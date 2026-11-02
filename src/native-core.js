"use strict";

// Runs PPSSPP inside this Node process through the native addon (native/) and
// the libretro core (lib/ppsspp_libretro.dll), like the NDS version runs melonDS.

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const STATE_TIMEOUT_MS = 10000;
// Render at 960x544; the stream is shrunk on the PC for lower qualities.
const RENDER_SCALE = 2;

function userError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

class NativeCore extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.addonPath = path.join(root, "native", "build", "Release", "ppsspp_core.node");
    this.dllPath = path.join(root, "lib", "ppsspp_libretro.dll");
    this.systemDir = path.join(root, "lib", "system");
    this.statesDir = path.join(root, "saves");
    this.addon = null;
    this.active = false;
    this.pendingLoad = null;
    this.states = new Map();
    this.nextStateId = 1;
  }

  // The addon, the core and its system files are all built by build-ppsspp.bat.
  static available(root) {
    return process.platform === "win32" &&
      fs.existsSync(path.join(root, "native", "build", "Release", "ppsspp_core.node")) &&
      fs.existsSync(path.join(root, "lib", "ppsspp_libretro.dll")) &&
      fs.existsSync(path.join(root, "lib", "system", "PPSSPP", "compat.ini"));
  }

  // Game saves go where the standalone PPSSPP keeps them, so both see the same progress.
  saveDir() {
    const standalone = path.join(this.root, "ppsspp", "memstick");
    const dir = fs.existsSync(standalone) ? standalone : path.join(this.statesDir, "memstick");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  running() {
    return this.active;
  }

  launch(gamePath) {
    if (!this.addon) {
      try {
        this.addon = require(this.addonPath);
      } catch (error) {
        throw userError(`Não foi possível carregar o addon do PPSSPP: ${error.message}`);
      }
    }
    this.close();
    this.stem = path.basename(gamePath).replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 64) || "game";
    fs.mkdirSync(this.statesDir, { recursive: true });

    return new Promise((resolve, reject) => {
      this.pendingLoad = { resolve, reject };
      this.addon.start({
        dll: this.dllPath,
        systemDir: this.systemDir,
        saveDir: this.saveDir(),
        game: gamePath,
        scale: RENDER_SCALE,
      }, (jpeg) => this.emit("frame", jpeg), (event) => this.onEvent(event));
      this.active = true;
    });
  }

  onEvent(event) {
    if (event.type === "loaded" && this.pendingLoad) {
      this.pendingLoad.resolve();
      this.pendingLoad = null;
    } else if (event.type === "error") {
      const wasLoading = Boolean(this.pendingLoad);
      if (wasLoading) {
        this.pendingLoad.reject(userError(event.message));
        this.pendingLoad = null;
      }
      this.close();
      if (!wasLoading) this.emit("exit", event.message);
    } else if (event.type === "state") {
      const pending = this.states.get(event.id);
      if (!pending) return;
      this.states.delete(event.id);
      clearTimeout(pending.timer);
      if (event.ok) pending.resolve();
      else pending.reject(new Error(event.message));
    }
  }

  setButtons(mask) {
    if (this.active) this.addon.setButtons(mask);
  }

  setAnalog(x, y) {
    if (this.active) this.addon.setAnalog(x, y);
  }

  setPaused(on) {
    if (this.active) this.addon.setPaused(on);
  }

  setFastForward(on) {
    if (this.active) this.addon.setFastForward(on);
  }

  setStreaming(on, quality, maxRes) {
    if (this.active) this.addon.setStreaming(on, quality, maxRes);
  }

  reset() {
    if (this.active) this.addon.reset();
  }

  statePath(slot) {
    return path.join(this.statesDir, `${this.stem}.slot${slot}.state`);
  }

  state(save, slot) {
    if (!this.active) return Promise.reject(new Error("PPSSPP não está rodando"));
    const id = this.nextStateId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.states.delete(id);
        reject(new Error("o PPSSPP não respondeu"));
      }, STATE_TIMEOUT_MS);
      this.states.set(id, { resolve, reject, timer });
      if (save) this.addon.saveState(id, this.statePath(slot));
      else this.addon.loadState(id, this.statePath(slot));
    });
  }

  // Stops the emulation thread and frees the game; takes a fraction of a second.
  close() {
    if (!this.addon || !this.active) return;
    this.active = false;
    this.addon.stop();
    for (const pending of this.states.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("o jogo foi fechado"));
    }
    this.states.clear();
  }
}

module.exports = { NativeCore };
