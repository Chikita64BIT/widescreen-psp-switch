// Runs the PPSSPP libretro core (lib/ppsspp_libretro.dll) inside the Node process,
// like the NDS version runs melonDS: PPSSPP renders into a hidden OpenGL context,
// each frame is read back, encoded as JPEG on a worker thread and handed to
// JavaScript. Buttons, the analog stick, pause, reset, save states and fast-forward
// come back from JavaScript.
//
// One core per process: libretro cores keep global state.

#include <windows.h>
#include <GL/gl.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#define RETRO_IMPORT_SYMBOLS
#include "libretro.h"
#include "jpge.h"

// OpenGL 3 names missing from the Windows SDK's OpenGL 1.1 header.
#define GL_FRAMEBUFFER 0x8D40
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_READ_FRAMEBUFFER_BINDING 0x8CAA
#define GL_RENDERBUFFER 0x8D41
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_DEPTH_STENCIL_ATTACHMENT 0x821A
#define GL_DEPTH24_STENCIL8 0x88F0
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_PIXEL_PACK_BUFFER 0x88EB
#define GL_PIXEL_PACK_BUFFER_BINDING 0x88ED
#define GL_RGBA8 0x8058

typedef void(APIENTRY *PfnGenObjects)(GLsizei, GLuint *);
typedef void(APIENTRY *PfnDeleteObjects)(GLsizei, const GLuint *);
typedef void(APIENTRY *PfnBindObject)(GLenum, GLuint);
typedef void(APIENTRY *PfnFramebufferTexture2D)(GLenum, GLenum, GLenum, GLuint, GLint);
typedef void(APIENTRY *PfnRenderbufferStorage)(GLenum, GLenum, GLsizei, GLsizei);
typedef void(APIENTRY *PfnFramebufferRenderbuffer)(GLenum, GLenum, GLenum, GLuint);
typedef GLenum(APIENTRY *PfnCheckFramebufferStatus)(GLenum);

namespace {

// Bit order shared with src/psp-session.js, mapped to libretro joypad ids.
const unsigned kButtonToRetro[] = {
	RETRO_DEVICE_ID_JOYPAD_B,       // cross
	RETRO_DEVICE_ID_JOYPAD_A,       // circle
	RETRO_DEVICE_ID_JOYPAD_Y,       // square
	RETRO_DEVICE_ID_JOYPAD_X,       // triangle
	RETRO_DEVICE_ID_JOYPAD_L,
	RETRO_DEVICE_ID_JOYPAD_R,
	RETRO_DEVICE_ID_JOYPAD_SELECT,
	RETRO_DEVICE_ID_JOYPAD_START,
	RETRO_DEVICE_ID_JOYPAD_UP,
	RETRO_DEVICE_ID_JOYPAD_DOWN,
	RETRO_DEVICE_ID_JOYPAD_LEFT,
	RETRO_DEVICE_ID_JOYPAD_RIGHT,
};
// Held fast-forward runs this many times faster than normal.
const int kFastForwardSpeed = 3;

struct Api {
	HMODULE dll = nullptr;
	decltype(&retro_set_environment) set_environment;
	decltype(&retro_set_video_refresh) set_video_refresh;
	decltype(&retro_set_audio_sample) set_audio_sample;
	decltype(&retro_set_audio_sample_batch) set_audio_sample_batch;
	decltype(&retro_set_input_poll) set_input_poll;
	decltype(&retro_set_input_state) set_input_state;
	decltype(&retro_init) init;
	decltype(&retro_deinit) deinit;
	decltype(&retro_get_system_av_info) get_system_av_info;
	decltype(&retro_load_game) load_game;
	decltype(&retro_unload_game) unload_game;
	decltype(&retro_run) run;
	decltype(&retro_reset) reset;
	decltype(&retro_serialize_size) serialize_size;
	decltype(&retro_serialize) serialize;
	decltype(&retro_unserialize) unserialize;
};

// Messages from the core threads to JavaScript.
struct Message {
	enum Kind { FRAME, EVENT } kind;
	std::vector<uint8_t> jpeg;
	std::string type;
	std::string text;
	int id = 0;
	bool ok = true;
};

struct PendingFrame {
	std::vector<uint8_t> rgba;
	int width = 0;
	int height = 0;
	bool valid = false;
};

struct Core {
	// Set by start(), read by the core thread.
	std::wstring dllPath;
	std::string systemDir;
	std::string saveDir;
	std::string gamePath;
	std::string resolution = "960x544";
	int scale = 2;

	Api api;
	std::thread thread;
	std::thread encoder;
	std::atomic<bool> stopping{ false };
	std::atomic<bool> running{ false };
	bool coreInitialized = false;

	napi_threadsafe_function frames = nullptr;
	napi_threadsafe_function events = nullptr;

	// Input, written from JavaScript.
	std::atomic<int> retroMask{ 0 };
	std::atomic<int> stickX{ 0 };
	std::atomic<int> stickY{ 0 };
	std::atomic<bool> paused{ false };
	std::atomic<bool> fastForward{ false };

	// Stream settings.
	std::atomic<bool> streaming{ false };
	std::atomic<int> quality{ 80 };
	std::atomic<int> maxRes{ 1 };

	// Work for the core thread (save states, reset).
	std::mutex commandLock;
	std::deque<std::function<void()>> commands;

	// The newest frame read back, waiting for the encoder.
	std::mutex frameLock;
	std::condition_variable frameReady;
	PendingFrame pending;

	// OpenGL, owned by the core thread.
	HWND window = nullptr;
	HDC dc = nullptr;
	HGLRC gl = nullptr;
	HMODULE opengl32 = nullptr;
	GLuint fbo = 0;
	GLuint colorTexture = 0;
	GLuint depthBuffer = 0;
	int fboWidth = 0;
	int fboHeight = 0;
	retro_hw_render_callback hw = {};
	bool hwRequested = false;
	std::atomic<bool> shutdownRequested{ false };
	double fps = 60.0 / 1.001;

	PfnGenObjects glGenFramebuffers = nullptr;
	PfnDeleteObjects glDeleteFramebuffers = nullptr;
	PfnBindObject glBindFramebuffer = nullptr;
	PfnFramebufferTexture2D glFramebufferTexture2D = nullptr;
	PfnGenObjects glGenRenderbuffers = nullptr;
	PfnDeleteObjects glDeleteRenderbuffers = nullptr;
	PfnBindObject glBindRenderbuffer = nullptr;
	PfnRenderbufferStorage glRenderbufferStorage = nullptr;
	PfnFramebufferRenderbuffer glFramebufferRenderbuffer = nullptr;
	PfnCheckFramebufferStatus glCheckFramebufferStatus = nullptr;
	PfnBindObject glBindBuffer = nullptr;
};

Core g;

// ---- Messages to JavaScript ----

void Post(napi_threadsafe_function fn, Message *message) {
	if (!fn || napi_call_threadsafe_function(fn, message, napi_tsfn_nonblocking) != napi_ok)
		delete message;
}

void PostEvent(const char *type, const std::string &text = "", int id = 0, bool ok = true) {
	auto message = new Message{ Message::EVENT };
	message->type = type;
	message->text = text;
	message->id = id;
	message->ok = ok;
	Post(g.events, message);
}

void CallJs(napi_env env, napi_value callback, void *context, void *data) {
	Message *message = (Message *)data;
	if (env && callback) {
		napi_value argument;
		if (message->kind == Message::FRAME) {
			void *copy;
			napi_create_buffer_copy(env, message->jpeg.size(), message->jpeg.data(), &copy, &argument);
		} else {
			napi_create_object(env, &argument);
			napi_value value;
			napi_create_string_utf8(env, message->type.c_str(), NAPI_AUTO_LENGTH, &value);
			napi_set_named_property(env, argument, "type", value);
			napi_create_string_utf8(env, message->text.c_str(), NAPI_AUTO_LENGTH, &value);
			napi_set_named_property(env, argument, "message", value);
			napi_create_int32(env, message->id, &value);
			napi_set_named_property(env, argument, "id", value);
			napi_get_boolean(env, message->ok, &value);
			napi_set_named_property(env, argument, "ok", value);
		}
		napi_value global;
		napi_get_global(env, &global);
		napi_call_function(env, global, callback, 1, &argument, nullptr);
	}
	delete message;
}

// ---- libretro callbacks ----

void LogCallback(enum retro_log_level level, const char *format, ...) {
	if (level < RETRO_LOG_ERROR)
		return;
	char text[1024];
	va_list args;
	va_start(args, format);
	vsnprintf(text, sizeof(text), format, args);
	va_end(args);
	fprintf(stderr, "[PPSSPP] %s", text);
	if (!*text || text[strlen(text) - 1] != '\n')
		fputc('\n', stderr);
}

const char *Variable(const char *key) {
	// Everything not listed keeps the core's default.
	if (!strcmp(key, "ppsspp_cpu_core"))
		return "JIT";
	if (!strcmp(key, "ppsspp_internal_resolution"))
		return g.resolution.c_str();
	if (!strcmp(key, "ppsspp_backend"))
		return "auto";
	if (!strcmp(key, "ppsspp_button_preference"))
		return "Cross";
	return nullptr;
}

uintptr_t GetCurrentFramebuffer() {
	return g.fbo;
}

retro_proc_address_t GlProcAddress(const char *name) {
	PROC proc = wglGetProcAddress(name);
	intptr_t value = (intptr_t)proc;
	// wglGetProcAddress only knows extensions; it reports these values for misses.
	if (value == 0 || value == 1 || value == 2 || value == 3 || value == -1)
		proc = ::GetProcAddress(g.opengl32, name);
	return (retro_proc_address_t)proc;
}

bool EnvironmentCallback(unsigned cmd, void *data) {
	switch (cmd) {
	case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
		*(const char **)data = g.systemDir.c_str();
		return true;
	case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
		*(const char **)data = g.saveDir.c_str();
		return true;
	case RETRO_ENVIRONMENT_GET_VARIABLE: {
		auto variable = (retro_variable *)data;
		variable->value = Variable(variable->key);
		return variable->value != nullptr;
	}
	case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
		*(bool *)data = false;
		return true;
	case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
		return *(const retro_pixel_format *)data == RETRO_PIXEL_FORMAT_XRGB8888;
	case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
		*(unsigned *)data = RETRO_HW_CONTEXT_OPENGL_CORE;
		return true;
	case RETRO_ENVIRONMENT_SET_HW_RENDER: {
		auto hw = (retro_hw_render_callback *)data;
		if (hw->context_type != RETRO_HW_CONTEXT_OPENGL_CORE && hw->context_type != RETRO_HW_CONTEXT_OPENGL)
			return false;
		hw->get_current_framebuffer = &GetCurrentFramebuffer;
		hw->get_proc_address = &GlProcAddress;
		g.hw = *hw;
		g.hwRequested = true;
		return true;
	}
	case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
		return true;
	case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
		((retro_log_callback *)data)->log = &LogCallback;
		return true;
	case RETRO_ENVIRONMENT_GET_FASTFORWARDING:
		*(bool *)data = g.fastForward;
		return true;
	case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
		g.fps = ((const retro_system_av_info *)data)->timing.fps;
		return true;
	case RETRO_ENVIRONMENT_SHUTDOWN:
		g.shutdownRequested = true;
		return true;
	case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
		*(unsigned *)data = 0;
		return true;
	case RETRO_ENVIRONMENT_SET_MESSAGE:
		LogCallback(RETRO_LOG_ERROR, "%s", ((const retro_message *)data)->msg);
		return true;
	case RETRO_ENVIRONMENT_SET_GEOMETRY:
	case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
	case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
	case RETRO_ENVIRONMENT_SET_VARIABLE:
	case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
	case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
		return true;
	default:
		return false;
	}
}

void QueueFrame(std::vector<uint8_t> &&rgba, int width, int height) {
	std::lock_guard<std::mutex> guard(g.frameLock);
	g.pending.rgba = std::move(rgba);
	g.pending.width = width;
	g.pending.height = height;
	g.pending.valid = true;
	g.frameReady.notify_one();
}

void VideoCallback(const void *data, unsigned width, unsigned height, size_t pitch) {
	if (!g.streaming || !data || width == 0 || height == 0)
		return;
	std::vector<uint8_t> rgba(width * height * 4);
	if (data == RETRO_HW_FRAME_BUFFER_VALID) {
		// Leave the core's GL state as it was.
		GLint previousFbo = 0, previousPack = 0, previousAlignment = 4;
		glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &previousFbo);
		glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &previousPack);
		glGetIntegerv(GL_PACK_ALIGNMENT, &previousAlignment);
		g.glBindFramebuffer(GL_READ_FRAMEBUFFER, g.fbo);
		g.glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
		glPixelStorei(GL_PACK_ALIGNMENT, 4);
		glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
		glPixelStorei(GL_PACK_ALIGNMENT, previousAlignment);
		g.glBindBuffer(GL_PIXEL_PACK_BUFFER, previousPack);
		g.glBindFramebuffer(GL_READ_FRAMEBUFFER, previousFbo);
		// OpenGL rows start at the bottom.
		std::vector<uint8_t> row(width * 4);
		for (unsigned y = 0; y < height / 2; y++) {
			uint8_t *top = &rgba[y * width * 4];
			uint8_t *bottom = &rgba[(height - 1 - y) * width * 4];
			memcpy(row.data(), top, row.size());
			memcpy(top, bottom, row.size());
			memcpy(bottom, row.data(), row.size());
		}
	} else {
		// Software rendering: XRGB8888, which is BGRX in memory.
		for (unsigned y = 0; y < height; y++) {
			const uint8_t *src = (const uint8_t *)data + y * pitch;
			uint8_t *dst = &rgba[y * width * 4];
			for (unsigned x = 0; x < width; x++, src += 4, dst += 4) {
				dst[0] = src[2];
				dst[1] = src[1];
				dst[2] = src[0];
				dst[3] = 255;
			}
		}
	}
	QueueFrame(std::move(rgba), width, height);
}

void InputPoll() {}

int16_t InputState(unsigned port, unsigned device, unsigned index, unsigned id) {
	if (port != 0)
		return 0;
	if (device == RETRO_DEVICE_JOYPAD) {
		const int mask = g.retroMask;
		if (id == RETRO_DEVICE_ID_JOYPAD_MASK)
			return (int16_t)mask;
		return (mask >> id) & 1;
	}
	if (device == RETRO_DEVICE_ANALOG && index == RETRO_DEVICE_INDEX_ANALOG_LEFT) {
		if (id == RETRO_DEVICE_ID_ANALOG_X)
			return (int16_t)g.stickX;
		if (id == RETRO_DEVICE_ID_ANALOG_Y)
			return (int16_t)g.stickY;
	}
	return 0;
}

// Nobody hears the PC speakers when playing remotely, so the sound is dropped.
void AudioSample(int16_t, int16_t) {}
size_t AudioSampleBatch(const int16_t *, size_t frames) {
	return frames;
}

// ---- JPEG encoding, on its own thread ----

void EncoderLoop() {
	std::vector<uint8_t> rgb;
	std::vector<uint8_t> jpeg;
	for (;;) {
		PendingFrame frame;
		{
			std::unique_lock<std::mutex> lock(g.frameLock);
			g.frameReady.wait(lock, [] { return g.pending.valid || g.stopping; });
			if (g.stopping)
				return;
			frame = std::move(g.pending);
			g.pending.valid = false;
		}

		// Shrink by a whole factor down to maxRes times the PSP screen.
		const int target = std::max(1, std::min((int)g.maxRes, g.scale));
		const int factor = std::max(1, g.scale / target);
		const int width = frame.width / factor;
		const int height = frame.height / factor;
		rgb.resize(width * height * 3);
		for (int y = 0; y < height; y++) {
			for (int x = 0; x < width; x++) {
				int sum[3] = { 0, 0, 0 };
				for (int dy = 0; dy < factor; dy++) {
					const uint8_t *src = &frame.rgba[((y * factor + dy) * frame.width + x * factor) * 4];
					for (int dx = 0; dx < factor; dx++, src += 4) {
						sum[0] += src[0];
						sum[1] += src[1];
						sum[2] += src[2];
					}
				}
				uint8_t *dst = &rgb[(y * width + x) * 3];
				const int count = factor * factor;
				dst[0] = (uint8_t)(sum[0] / count);
				dst[1] = (uint8_t)(sum[1] / count);
				dst[2] = (uint8_t)(sum[2] / count);
			}
		}

		jpge::params params;
		params.m_quality = g.quality;
		int size = std::max(1024, width * height * 3);
		jpeg.resize(size);
		if (!jpge::compress_image_to_jpeg_file_in_memory(jpeg.data(), size, width, height, 3, rgb.data(), params))
			continue;
		auto message = new Message{ Message::FRAME };
		message->jpeg.assign(jpeg.begin(), jpeg.begin() + size);
		Post(g.frames, message);
	}
}

// ---- OpenGL ----

bool CreateGlContext() {
	g.opengl32 = LoadLibraryW(L"opengl32.dll");
	WNDCLASSW windowClass = {};
	windowClass.style = CS_OWNDC;
	windowClass.lpfnWndProc = DefWindowProcW;
	windowClass.hInstance = GetModuleHandleW(nullptr);
	windowClass.lpszClassName = L"WideScreenPpssppGL";
	RegisterClassW(&windowClass);
	// Never shown: OpenGL on Windows just needs a window to attach to.
	g.window = CreateWindowExW(0, windowClass.lpszClassName, L"WideScreen", WS_OVERLAPPEDWINDOW,
		0, 0, 64, 64, nullptr, nullptr, windowClass.hInstance, nullptr);
	if (!g.window)
		return false;
	g.dc = GetDC(g.window);
	PIXELFORMATDESCRIPTOR format = {};
	format.nSize = sizeof(format);
	format.nVersion = 1;
	format.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
	format.iPixelType = PFD_TYPE_RGBA;
	format.cColorBits = 32;
	format.cDepthBits = 24;
	format.cStencilBits = 8;
	const int chosen = ChoosePixelFormat(g.dc, &format);
	if (!chosen || !SetPixelFormat(g.dc, chosen, &format))
		return false;
	// A legacy context gives the newest compatibility profile the driver has.
	g.gl = wglCreateContext(g.dc);
	if (!g.gl || !wglMakeCurrent(g.dc, g.gl))
		return false;

	g.glGenFramebuffers = (PfnGenObjects)GlProcAddress("glGenFramebuffers");
	g.glDeleteFramebuffers = (PfnDeleteObjects)GlProcAddress("glDeleteFramebuffers");
	g.glBindFramebuffer = (PfnBindObject)GlProcAddress("glBindFramebuffer");
	g.glFramebufferTexture2D = (PfnFramebufferTexture2D)GlProcAddress("glFramebufferTexture2D");
	g.glGenRenderbuffers = (PfnGenObjects)GlProcAddress("glGenRenderbuffers");
	g.glDeleteRenderbuffers = (PfnDeleteObjects)GlProcAddress("glDeleteRenderbuffers");
	g.glBindRenderbuffer = (PfnBindObject)GlProcAddress("glBindRenderbuffer");
	g.glRenderbufferStorage = (PfnRenderbufferStorage)GlProcAddress("glRenderbufferStorage");
	g.glFramebufferRenderbuffer = (PfnFramebufferRenderbuffer)GlProcAddress("glFramebufferRenderbuffer");
	g.glCheckFramebufferStatus = (PfnCheckFramebufferStatus)GlProcAddress("glCheckFramebufferStatus");
	g.glBindBuffer = (PfnBindObject)GlProcAddress("glBindBuffer");
	return g.glGenFramebuffers && g.glBindFramebuffer && g.glFramebufferTexture2D && g.glGenRenderbuffers &&
		g.glBindRenderbuffer && g.glRenderbufferStorage && g.glFramebufferRenderbuffer && g.glCheckFramebufferStatus &&
		g.glBindBuffer;
}

// The core draws into this framebuffer instead of a window.
bool CreateFramebuffer(int width, int height) {
	glGenTextures(1, &g.colorTexture);
	glBindTexture(GL_TEXTURE_2D, g.colorTexture);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
	glBindTexture(GL_TEXTURE_2D, 0);

	g.glGenRenderbuffers(1, &g.depthBuffer);
	g.glBindRenderbuffer(GL_RENDERBUFFER, g.depthBuffer);
	g.glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, width, height);
	g.glBindRenderbuffer(GL_RENDERBUFFER, 0);

	g.glGenFramebuffers(1, &g.fbo);
	g.glBindFramebuffer(GL_FRAMEBUFFER, g.fbo);
	g.glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g.colorTexture, 0);
	g.glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, g.depthBuffer);
	const bool complete = g.glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
	g.glBindFramebuffer(GL_FRAMEBUFFER, 0);
	g.fboWidth = width;
	g.fboHeight = height;
	return complete;
}

void DestroyGlContext() {
	if (g.gl) {
		if (g.fbo)
			g.glDeleteFramebuffers(1, &g.fbo);
		if (g.depthBuffer)
			g.glDeleteRenderbuffers(1, &g.depthBuffer);
		if (g.colorTexture)
			glDeleteTextures(1, &g.colorTexture);
		wglMakeCurrent(nullptr, nullptr);
		wglDeleteContext(g.gl);
	}
	if (g.window) {
		ReleaseDC(g.window, g.dc);
		DestroyWindow(g.window);
	}
	g.fbo = g.depthBuffer = g.colorTexture = 0;
	g.gl = nullptr;
	g.dc = nullptr;
	g.window = nullptr;
}

// ---- The core thread ----

template <typename T>
bool LoadSymbol(T &target, const char *name) {
	target = (T)::GetProcAddress(g.api.dll, name);
	return target != nullptr;
}

bool LoadApi() {
	if (!g.api.dll)
		g.api.dll = LoadLibraryW(g.dllPath.c_str());
	if (!g.api.dll)
		return false;
	auto &a = g.api;
	return LoadSymbol(a.set_environment, "retro_set_environment") &&
		LoadSymbol(a.set_video_refresh, "retro_set_video_refresh") &&
		LoadSymbol(a.set_audio_sample, "retro_set_audio_sample") &&
		LoadSymbol(a.set_audio_sample_batch, "retro_set_audio_sample_batch") &&
		LoadSymbol(a.set_input_poll, "retro_set_input_poll") &&
		LoadSymbol(a.set_input_state, "retro_set_input_state") &&
		LoadSymbol(a.init, "retro_init") &&
		LoadSymbol(a.deinit, "retro_deinit") &&
		LoadSymbol(a.get_system_av_info, "retro_get_system_av_info") &&
		LoadSymbol(a.load_game, "retro_load_game") &&
		LoadSymbol(a.unload_game, "retro_unload_game") &&
		LoadSymbol(a.run, "retro_run") &&
		LoadSymbol(a.reset, "retro_reset") &&
		LoadSymbol(a.serialize_size, "retro_serialize_size") &&
		LoadSymbol(a.serialize, "retro_serialize") &&
		LoadSymbol(a.unserialize, "retro_unserialize");
}

std::wstring Widen(const std::string &text) {
	const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
	std::wstring wide(size > 0 ? size - 1 : 0, L'\0');
	if (size > 0)
		MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, wide.data(), size);
	return wide;
}

void SaveState(int id, const std::string &path) {
	const size_t size = g.api.serialize_size();
	std::vector<uint8_t> data(size);
	bool ok = size > 0 && g.api.serialize(data.data(), size);
	if (ok) {
		FILE *file = _wfopen(Widen(path).c_str(), L"wb");
		ok = file && fwrite(data.data(), 1, size, file) == size;
		if (file)
			fclose(file);
	}
	PostEvent("state", ok ? "" : "Falha ao salvar o estado", id, ok);
}

void LoadState(int id, const std::string &path) {
	std::vector<uint8_t> data;
	FILE *file = _wfopen(Widen(path).c_str(), L"rb");
	if (file) {
		fseek(file, 0, SEEK_END);
		data.resize(ftell(file));
		fseek(file, 0, SEEK_SET);
		if (fread(data.data(), 1, data.size(), file) != data.size())
			data.clear();
		fclose(file);
	}
	const bool ok = !data.empty() && g.api.unserialize(data.data(), data.size());
	PostEvent("state", ok ? "" : (file ? "Falha ao carregar o estado" : "Slot vazio"), id, ok);
}

void CoreLoop() {
	if (!CreateGlContext()) {
		PostEvent("error", "Não foi possível criar o contexto OpenGL.");
		DestroyGlContext();
		g.running = false;
		return;
	}
	if (!LoadApi()) {
		PostEvent("error", "Não foi possível carregar o núcleo do PPSSPP (ppsspp_libretro.dll).");
		DestroyGlContext();
		g.running = false;
		return;
	}

	auto &a = g.api;
	a.set_environment(&EnvironmentCallback);
	a.set_video_refresh(&VideoCallback);
	a.set_audio_sample(&AudioSample);
	a.set_audio_sample_batch(&AudioSampleBatch);
	a.set_input_poll(&InputPoll);
	a.set_input_state(&InputState);
	a.init();
	g.coreInitialized = true;

	g.hwRequested = false;
	g.shutdownRequested = false;
	retro_game_info game = {};
	game.path = g.gamePath.c_str();
	bool loaded = a.load_game(&game);
	if (loaded && g.hwRequested) {
		retro_system_av_info info = {};
		a.get_system_av_info(&info);
		g.fps = info.timing.fps > 0 ? info.timing.fps : g.fps;
		loaded = CreateFramebuffer(std::max(info.geometry.max_width, 480u), std::max(info.geometry.max_height, 272u));
		if (loaded && g.hw.context_reset)
			g.hw.context_reset();
	}
	if (!loaded) {
		PostEvent("error", "O PPSSPP não conseguiu abrir o jogo.");
	} else {
		PostEvent("loaded");
		using clock = std::chrono::steady_clock;
		auto next = clock::now();
		while (!g.stopping) {
			std::deque<std::function<void()>> work;
			{
				std::lock_guard<std::mutex> guard(g.commandLock);
				work.swap(g.commands);
			}
			for (auto &command : work)
				command();

			MSG message;
			while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
				DispatchMessageW(&message);

			if (g.paused) {
				std::this_thread::sleep_for(std::chrono::milliseconds(10));
				next = clock::now();
				continue;
			}
			a.run();
			if (g.shutdownRequested) {
				PostEvent("error", "O PPSSPP encerrou o jogo.");
				break;
			}

			const double speed = g.fastForward ? kFastForwardSpeed : 1;
			next += std::chrono::duration_cast<clock::duration>(std::chrono::duration<double>(1.0 / (g.fps * speed)));
			const auto now = clock::now();
			if (next < now - std::chrono::milliseconds(100))
				next = now;  // Fell far behind; don't try to catch up in a burst.
			else
				std::this_thread::sleep_until(next);
		}
		if (g.hw.context_destroy)
			g.hw.context_destroy();
		a.unload_game();
	}
	a.deinit();
	g.coreInitialized = false;
	DestroyGlContext();
	// PPSSPP can't be initialized a second time in the same copy of the DLL, so the
	// next game gets a fresh one, as RetroArch does when it changes content.
	FreeLibrary(g.api.dll);
	g.api = {};
	g.running = false;
}

// ---- JavaScript API ----

std::string StringProperty(napi_env env, napi_value object, const char *name) {
	napi_value value;
	size_t length = 0;
	if (napi_get_named_property(env, object, name, &value) != napi_ok)
		return "";
	if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok)
		return "";
	std::string text(length, '\0');
	napi_get_value_string_utf8(env, value, text.data(), length + 1, &length);
	return text;
}

int IntArgument(napi_env env, napi_value value, int fallback) {
	int result = fallback;
	napi_get_value_int32(env, value, &result);
	return result;
}

double DoubleArgument(napi_env env, napi_value value) {
	double result = 0;
	napi_get_value_double(env, value, &result);
	return result;
}

bool BoolArgument(napi_env env, napi_value value) {
	bool result = false;
	napi_get_value_bool(env, value, &result);
	return result;
}

napi_value Undefined(napi_env env) {
	napi_value value;
	napi_get_undefined(env, &value);
	return value;
}

void StopCore() {
	if (!g.thread.joinable())
		return;
	g.stopping = true;
	g.frameReady.notify_all();
	g.thread.join();
	g.encoder.join();
	if (g.frames)
		napi_release_threadsafe_function(g.frames, napi_tsfn_release);
	if (g.events)
		napi_release_threadsafe_function(g.events, napi_tsfn_release);
	g.frames = g.events = nullptr;
	g.pending = {};
	g.commands.clear();
}

// start({ dll, systemDir, saveDir, game, scale }, onFrame(jpeg), onEvent({ type, message, id, ok }))
napi_value Start(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value argv[3];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	if (argc < 3) {
		napi_throw_type_error(env, nullptr, "start(options, onFrame, onEvent)");
		return nullptr;
	}
	StopCore();

	g.dllPath = Widen(StringProperty(env, argv[0], "dll"));
	g.systemDir = StringProperty(env, argv[0], "systemDir");
	g.saveDir = StringProperty(env, argv[0], "saveDir");
	g.gamePath = StringProperty(env, argv[0], "game");
	napi_value scaleValue;
	napi_get_named_property(env, argv[0], "scale", &scaleValue);
	g.scale = std::clamp(IntArgument(env, scaleValue, 2), 1, 4);
	static const char *const kResolutions[] = { "480x272", "960x544", "1440x816", "1920x1088" };
	g.resolution = kResolutions[g.scale - 1];

	napi_value name;
	napi_create_string_utf8(env, "ppsspp-core", NAPI_AUTO_LENGTH, &name);
	// These keep Node running while a game is open, so it can't start shutting down
	// under the core thread; stop() releases them.
	napi_create_threadsafe_function(env, argv[1], nullptr, name, 3, 1, nullptr, nullptr, nullptr, &CallJs, &g.frames);
	napi_create_threadsafe_function(env, argv[2], nullptr, name, 0, 1, nullptr, nullptr, nullptr, &CallJs, &g.events);

	g.stopping = false;
	g.running = true;
	g.paused = false;
	g.fastForward = false;
	g.retroMask = 0;
	g.stickX = g.stickY = 0;
	g.encoder = std::thread(&EncoderLoop);
	g.thread = std::thread(&CoreLoop);
	return Undefined(env);
}

napi_value Stop(napi_env env, napi_callback_info) {
	StopCore();
	return Undefined(env);
}

napi_value SetButtons(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	const int mask = IntArgument(env, argv[0], 0);
	int retro = 0;
	for (int bit = 0; bit < (int)(sizeof(kButtonToRetro) / sizeof(*kButtonToRetro)); bit++) {
		if (mask & (1 << bit))
			retro |= 1 << kButtonToRetro[bit];
	}
	g.retroMask = retro;
	return Undefined(env);
}

// setAnalog(x, y) with -1..1, y pointing down like the Gamepad API.
napi_value SetAnalog(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	g.stickX = (int)(std::clamp(DoubleArgument(env, argv[0]), -1.0, 1.0) * 32767);
	g.stickY = (int)(std::clamp(DoubleArgument(env, argv[1]), -1.0, 1.0) * 32767);
	return Undefined(env);
}

napi_value SetPaused(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	g.paused = BoolArgument(env, argv[0]);
	return Undefined(env);
}

napi_value SetFastForward(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	g.fastForward = BoolArgument(env, argv[0]);
	return Undefined(env);
}

// setStreaming(on, quality, maxRes)
napi_value SetStreaming(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value argv[3];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	g.quality = std::clamp(IntArgument(env, argv[1], 80), 1, 100);
	g.maxRes = std::clamp(IntArgument(env, argv[2], 1), 1, 4);
	g.streaming = BoolArgument(env, argv[0]);
	return Undefined(env);
}

void Queue(std::function<void()> &&command) {
	std::lock_guard<std::mutex> guard(g.commandLock);
	g.commands.push_back(std::move(command));
}

napi_value Reset(napi_env env, napi_callback_info) {
	Queue([] { g.api.reset(); });
	return Undefined(env);
}

// saveState(id, path) and loadState(id, path); the result arrives as a "state" event with the id.
napi_value StateCommand(napi_env env, napi_callback_info info, bool save) {
	size_t argc = 2;
	napi_value argv[2];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	const int id = IntArgument(env, argv[0], 0);
	size_t length = 0;
	napi_get_value_string_utf8(env, argv[1], nullptr, 0, &length);
	std::string path(length, '\0');
	napi_get_value_string_utf8(env, argv[1], path.data(), length + 1, &length);
	Queue([save, id, path] {
		if (save)
			SaveState(id, path);
		else
			LoadState(id, path);
	});
	return Undefined(env);
}

napi_value SaveStateJs(napi_env env, napi_callback_info info) {
	return StateCommand(env, info, true);
}

napi_value LoadStateJs(napi_env env, napi_callback_info info) {
	return StateCommand(env, info, false);
}

napi_value Running(napi_env env, napi_callback_info) {
	napi_value value;
	napi_get_boolean(env, g.running, &value);
	return value;
}

napi_value Init(napi_env env, napi_value exports) {
	const napi_property_descriptor functions[] = {
		{ "start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "running", nullptr, Running, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "setButtons", nullptr, SetButtons, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "setAnalog", nullptr, SetAnalog, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "setPaused", nullptr, SetPaused, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "setFastForward", nullptr, SetFastForward, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "setStreaming", nullptr, SetStreaming, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "reset", nullptr, Reset, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "saveState", nullptr, SaveStateJs, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "loadState", nullptr, LoadStateJs, nullptr, nullptr, nullptr, napi_default, nullptr },
	};
	napi_define_properties(env, exports, sizeof(functions) / sizeof(*functions), functions);
	// Stop the threads before Node tears the environment down.
	napi_add_env_cleanup_hook(env, [](void *) { StopCore(); }, nullptr);
	return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
