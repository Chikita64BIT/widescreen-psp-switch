"use strict";

// One game at a time: PPSSPP runs on the PC and its image goes as JPEG frames to
// every connected browser, whose buttons go back to PPSSPP. PPSSPP runs inside
// this process when the native addon is built (src/native-core.js); otherwise as
// its own program (src/ppsspp.js), streaming by itself or captured with ffmpeg.

const { Ppsspp } = require("./ppsspp");
const { Capture } = require("./capture");
const { NativeCore } = require("./native-core");

// Bit order shared with src/stream.js.
const BUTTONS = ["cross", "circle", "square", "triangle", "ltrigger", "rtrigger", "select", "start", "up", "down", "left", "right"];
const ALL_BUTTONS = (1 << BUTTONS.length) - 1;
// PSP screen is 480x272. The window is sized to twice that so "alta" stays sharp.
const WINDOW_WIDTH = 960;
const WINDOW_HEIGHT = 544;
// width/height/q are for the ffmpeg window capture; jpeg/maxRes for the stream
// built into the modified PPSSPP (JPEG quality and multiple of 480x272).
const QUALITY_LEVELS = [
  { width: 480, height: 272, q: 9, jpeg: 55, maxRes: 1 },
  { width: 480, height: 272, q: 4, jpeg: 80, maxRes: 1 },
  { width: 960, height: 544, q: 4, jpeg: 85, maxRes: 2 },
];
const MAX_FRAMES_IN_FLIGHT = 2;
// A quick tap can press and release between two PSP input samples; keep presses
// visible to the game for a few frames so taps are never lost.
const MIN_HOLD_MS = 50;
const STATE_SLOTS = 3;
// Also how fast PPSSPP gets back on top when another window covers it.
const WINDOW_CHECK_MS = 1000;
const CAPTURE_RETRY_MS = 2000;
// PPSSPP's default hotkeys, used when its debugger has no save state or speed events.
const VK_TAB = 0x09;
const VK_F2 = 0x71;
const VK_F4 = 0x73;

class PspSession {
  constructor(root) {
    this.ppsspp = new Ppsspp(root);
    this.capture = new Capture();
    // PPSSPP_ENGINE=program forces the separate PPSSPP program even with the addon built.
    this.native = process.env.PPSSPP_ENGINE !== "program" && NativeCore.available(root) ? new NativeCore(root) : null;
    this.clients = new Set();
    this.gamePath = "";
    this.gameName = "";
    this.loading = null;
    this.paused = false;
    this.stepping = false;
    this.modern = false;
    // True when PPSSPP streams its own frames (the modified build), so there is
    // no window to capture and no ffmpeg.
    this.builtin = false;
    this.streaming = false;
    this.held = 0;
    this.wanted = 0;
    this.pressedAt = new Array(BUTTONS.length).fill(0);
    this.releaseTimer = null;
    this.analog = { x: 0, y: 0 };
    this.turbo = false;
    this.qualityIndex = 1;
    this.area = null;
    this.windowTimer = null;
    this.retryTimer = null;
    this.fpsFrames = 0;
    this.fpsTime = Date.now();

    this.capture.on("frame", (jpeg) => this.onFrame(jpeg));
    this.capture.on("failure", (message) => this.onCaptureFailure(message));
    this.ppsspp.on("frame", (jpeg) => {
      // Node does the per-browser flow control, so take frames as fast as PPSSPP makes them.
      this.ppsspp.send("stream.ack");
      if (this.streaming) this.onFrame(jpeg);
    });
    this.ppsspp.on("exit", () => this.onEngineExit("O PPSSPP foi fechado no PC."));
    if (this.native) {
      this.native.on("frame", (jpeg) => {
        if (this.streaming) this.onFrame(jpeg);
      });
      this.native.on("exit", (message) => this.onEngineExit(message));
    }
  }

  engineRunning() {
    return this.native ? this.native.running() : this.ppsspp.running();
  }

  onEngineExit(message) {
    this.streaming = false;
    this.gamePath = "";
    this.gameName = "";
    this.area = null;
    this.updateActivity();
    this.broadcastError(`${message} Volte à biblioteca e abra o jogo de novo.`);
  }

  async loadGame(gamePath, gameName) {
    if (this.loading) await this.loading.catch(() => {});
    if (this.gamePath === gamePath && this.engineRunning()) {
      this.paused = false;
      this.updateActivity();
      this.sendCaps();
      this.broadcastStatus("Jogando");
      return;
    }
    this.loading = this.launch(gamePath, gameName);
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async launch(gamePath, gameName) {
    this.stopCapture();
    this.gamePath = "";
    this.gameName = gameName;
    this.broadcast({ t: "loading", message: "Abrindo o PPSSPP no PC…", rom: gameName });

    if (this.native) {
      await this.native.launch(gamePath);
      this.modern = true;
      this.builtin = true;
      console.log("PPSSPP rodando dentro do Node.");
    } else {
      await this.ppsspp.launch(gamePath);
      this.modern = await this.ppsspp.supports("game.speed.get");
      this.builtin = await this.ppsspp.supports("stream.stop");
      console.log(this.builtin ? "Imagem: streaming embutido do PPSSPP." : "Imagem: captura da janela com o ffmpeg.");
    }
    this.streaming = false;
    this.gamePath = gamePath;
    this.paused = false;
    this.stepping = false;
    this.held = 0;
    this.wanted = 0;
    this.analog = { x: 0, y: 0 };
    this.turbo = false;
    this.area = null;

    if (!this.builtin) await this.refreshWindow(true);
    this.updateActivity();
    this.sendCaps();
    this.broadcastStatus("Jogando");
  }

  // ---- Window and capture ----

  async refreshWindow(place) {
    const result = await this.ppsspp.window(place, WINDOW_WIDTH, WINDOW_HEIGHT);
    if (!result.ok || result.w < 16 || result.h < 16) return false;
    this.area = { x: result.x, y: result.y, w: result.w, h: result.h, vx: result.vx, vy: result.vy };
    if (this.capture.active()) this.startCapture();
    return true;
  }

  startCapture() {
    const level = QUALITY_LEVELS[this.qualityIndex];
    if (this.native) {
      this.streaming = true;
      this.native.setStreaming(true, level.jpeg, level.maxRes);
      return;
    }
    if (this.builtin) {
      // Sent again while streaming, it just changes the quality.
      this.streaming = true;
      this.ppsspp.request("stream.start", { quality: level.jpeg, maxRes: level.maxRes, maxInFlight: 2 })
        .catch((error) => console.error("Falha ao iniciar o streaming do PPSSPP:", error.message));
      return;
    }
    if (!this.area) return;
    this.capture.start(this.area, level);
  }

  stopCapture() {
    if (this.streaming && this.native) this.native.setStreaming(false, 0, 1);
    else if (this.streaming) this.ppsspp.send("stream.stop");
    this.streaming = false;
    this.capture.stop();
  }

  captureActive() {
    return this.builtin ? this.streaming : this.capture.active();
  }

  onCaptureFailure(message) {
    console.error(message);
    clearTimeout(this.retryTimer);
    if (!this.running()) return;
    this.retryTimer = setTimeout(() => {
      if (this.running() && !this.capture.active()) this.startCapture();
    }, CAPTURE_RETRY_MS);
  }

  onFrame(jpeg) {
    this.fpsFrames++;
    const now = Date.now();
    if (now - this.fpsTime >= 1000) {
      this.broadcast({ t: "stats", fps: Math.round((this.fpsFrames * 1000) / (now - this.fpsTime)) });
      this.fpsFrames = 0;
      this.fpsTime = now;
    }
    for (const client of this.clients) {
      if (client.socket.readyState !== 1 || client.inFlight >= MAX_FRAMES_IN_FLIGHT) continue;
      client.inFlight++;
      client.socket.send(jpeg, { binary: true });
    }
  }

  running() {
    return Boolean(this.gamePath) && this.engineRunning() && this.clients.size > 0;
  }

  // Captures and runs the game only while someone is watching.
  updateActivity() {
    if (this.running()) {
      if (!this.captureActive()) this.startCapture();
      if (!this.builtin && !this.windowTimer) {
        this.windowTimer = setInterval(() => this.refreshWindow(false), WINDOW_CHECK_MS);
      }
      this.setStepping(this.paused);
      return;
    }
    this.stopCapture();
    clearInterval(this.windowTimer);
    this.windowTimer = null;
    if (this.gamePath && this.engineRunning()) {
      this.releaseInputs();
      this.setStepping(true);
    }
  }

  setStepping(on) {
    if (this.stepping === on) return;
    this.stepping = on;
    if (this.native) this.native.setPaused(on);
    else this.ppsspp.send(on ? "cpu.stepping" : "cpu.resume");
  }

  // ---- Input ----

  setButtons(mask) {
    this.wanted = mask & ALL_BUTTONS;
    this.applyButtons();
  }

  applyButtons() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    const now = Date.now();
    const changes = {};
    let changed = false;
    let wait = Infinity;
    for (let bit = 0; bit < BUTTONS.length; bit++) {
      const flag = 1 << bit;
      const wants = (this.wanted & flag) !== 0;
      const held = (this.held & flag) !== 0;
      if (wants && !held) {
        this.held |= flag;
        this.pressedAt[bit] = now;
        changes[BUTTONS[bit]] = true;
        changed = true;
      } else if (!wants && held) {
        const left = this.pressedAt[bit] + MIN_HOLD_MS - now;
        if (left <= 0) {
          this.held &= ~flag;
          changes[BUTTONS[bit]] = false;
          changed = true;
        } else {
          wait = Math.min(wait, left);
        }
      }
    }
    if (changed && this.native) this.native.setButtons(this.held);
    else if (changed) this.ppsspp.send("input.buttons.send", { buttons: changes });
    if (wait !== Infinity) this.releaseTimer = setTimeout(() => this.applyButtons(), wait);
  }

  setAnalog(x, y) {
    const clamp = (value) => Math.max(-1, Math.min(1, Number(value) || 0));
    this.analog = { x: clamp(x), y: clamp(y) };
    if (this.native) {
      this.native.setAnalog(this.analog.x, this.analog.y);
      return;
    }
    // PPSSPP's stick Y points up, the browser's points down.
    this.ppsspp.send("input.analog.send", { x: this.analog.x, y: -this.analog.y, stick: "left" });
  }

  releaseInputs() {
    this.wanted = 0;
    this.held = ALL_BUTTONS;
    this.pressedAt.fill(0);
    this.applyButtons();
    this.setAnalog(0, 0);
    this.setTurbo(false);
  }

  async setTurbo(on) {
    if (this.turbo === on) return;
    this.turbo = on;
    this.broadcast({ t: "turbo", on });
    if (this.native) {
      this.native.setFastForward(on);
    } else if (this.modern) {
      await this.ppsspp.request("game.speed.set", { fastForward: on }).catch((error) => {
        this.broadcastStatus(`Turbo indisponível: ${error.message}`);
      });
    } else {
      await this.ppsspp.key(VK_TAB, on);
    }
  }

  // ---- Save states ----

  async stateOperation(save, slot) {
    const verb = save ? "salvo" : "carregado";
    try {
      if (this.native) {
        await this.native.state(save, slot);
        this.broadcastStatus(`Estado ${verb} ${save ? "no" : "do"} slot ${slot}`);
      } else if (this.modern) {
        await this.ppsspp.request(save ? "game.state.save" : "game.state.load", { slot: slot - 1, wait: true });
        this.broadcastStatus(`Estado ${verb} ${save ? "no" : "do"} slot ${slot}`);
      } else {
        await this.ppsspp.tapKey(save ? VK_F2 : VK_F4);
        this.broadcastStatus(`Estado ${verb} (slot atual do PPSSPP)`);
      }
    } catch (error) {
      this.broadcastStatus(`Falha: ${error.message}`);
    }
  }

  // ---- Messages from browsers ----

  handleMessage(client, message) {
    if (message.t === "ack") {
      client.inFlight = Math.max(0, client.inFlight - 1);
      return;
    }
    if (message.t === "quality") {
      const level = Number(message.level);
      if (Number.isInteger(level) && level >= 0 && level < QUALITY_LEVELS.length) {
        this.qualityIndex = level;
        if (this.captureActive()) this.startCapture();
      }
      return;
    }
    if (!this.gamePath) return;
    switch (message.t) {
      case "keys":
        this.setButtons(Number(message.mask) || 0);
        break;
      case "analog":
        this.setAnalog(message.x, message.y);
        break;
      case "turbo":
        this.setTurbo(Boolean(message.on));
        break;
      case "pause":
        this.paused = !this.paused;
        if (this.paused) this.releaseInputs();
        this.setStepping(this.paused);
        this.broadcastStatus(this.paused ? "Pausado" : "Jogando");
        break;
      case "reset":
        this.paused = false;
        this.setStepping(false);
        if (this.native) {
          this.native.reset();
          this.broadcastStatus("Reiniciado");
          break;
        }
        this.ppsspp.request("game.reset")
          .then(() => this.broadcastStatus("Reiniciado"))
          .catch((error) => this.broadcastStatus(`Falha ao reiniciar: ${error.message}`));
        break;
      case "save-state":
      case "load-state": {
        const slot = Number(message.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > STATE_SLOTS) return;
        this.stateOperation(message.t === "save-state", slot);
        break;
      }
      case "recenter":
        if (!this.builtin) this.refreshWindow(true);
        break;
      default:
        break;
    }
  }

  addClient(socket) {
    const client = { socket, inFlight: 0 };
    this.clients.add(client);
    return client;
  }

  removeClient(client) {
    if (!this.clients.delete(client)) return;
    this.updateActivity();
  }

  sendCaps() {
    this.broadcast({ t: "caps", slots: this.modern ? STATE_SLOTS : 1, windowCapture: !this.builtin });
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.socket.readyState === 1) client.socket.send(text);
    }
  }

  broadcastStatus(message) {
    this.broadcast({ t: "status", message, paused: this.paused, rom: this.gameName });
  }

  broadcastError(message) {
    this.broadcast({ t: "status", message, error: true, rom: this.gameName });
  }

  async shutdown() {
    clearInterval(this.windowTimer);
    clearTimeout(this.retryTimer);
    this.stopCapture();
    if (this.native) this.native.close();
    await this.ppsspp.shutdown();
  }
}

module.exports = { PspSession };
