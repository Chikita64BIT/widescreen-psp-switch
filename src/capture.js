"use strict";

// Captures the PPSSPP window area of the desktop with ffmpeg (gdigrab) and
// emits one JPEG buffer per frame.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const CAPTURE_FPS = 60;
const SOI = Buffer.from([0xFF, 0xD8]);
const EOI = Buffer.from([0xFF, 0xD9]);
const MAX_BUFFER = 4 * 1024 * 1024;

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // The package path exists even when its install script was blocked and never downloaded the binary.
    const bundled = require("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // Not installed.
  }
  return null;
}

class Capture extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.key = "";
  }

  active() {
    return Boolean(this.process);
  }

  // area: client rectangle of the PPSSPP window in physical screen pixels, plus
  // the virtual screen origin (vx, vy). output: { width, height, q } for the JPEGs.
  start(area, output) {
    const key = JSON.stringify([area.x, area.y, area.w, area.h, output]);
    if (this.process && this.key === key) return;
    this.stop();

    const exe = ffmpegPath();
    if (!exe) {
      this.emit("failure", "ffmpeg não encontrado no PC.");
      return;
    }
    // gdigrab offsets are relative to the top-left of the virtual screen.
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "gdigrab", "-framerate", String(CAPTURE_FPS), "-draw_mouse", "0",
      "-offset_x", String(area.x - area.vx), "-offset_y", String(area.y - area.vy),
      "-video_size", `${area.w}x${area.h}`,
      "-i", "desktop",
      "-an", "-vf", `scale=${output.width}:${output.height}:flags=bilinear`,
      "-pix_fmt", "yuvj420p", "-q:v", String(output.q),
      // gdigrab can deliver more frames than asked for; drop the extras.
      "-fps_mode", "cfr", "-r", String(CAPTURE_FPS),
      "-flush_packets", "1", "-f", "mjpeg", "pipe:1",
    ];
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.process = child;
    this.key = key;
    this.buffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => console.error("ffmpeg:", chunk.toString().trim()));
    child.on("error", (error) => this.emit("failure", `Falha ao iniciar o ffmpeg: ${error.message}`));
    child.on("exit", (code) => {
      if (this.process !== child) return;
      this.process = null;
      this.key = "";
      this.emit("failure", `A captura de tela parou (código ${code}).`);
    });
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const start = this.buffer.indexOf(SOI);
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      // Inside JPEG entropy data every 0xFF byte is followed by 0x00, so FFD9 only ends a frame.
      const end = this.buffer.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        if (this.buffer.length > MAX_BUFFER) this.buffer = Buffer.alloc(0);
        return;
      }
      this.emit("frame", Buffer.from(this.buffer.subarray(start, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }
  }

  stop() {
    const child = this.process;
    this.process = null;
    this.key = "";
    if (child) child.kill();
  }
}

module.exports = { Capture, ffmpegPath };
