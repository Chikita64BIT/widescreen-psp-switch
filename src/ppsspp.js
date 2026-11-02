"use strict";

// Starts PPSSPP on the PC, talks to its remote debugger WebSocket (buttons,
// analog stick, pause, reset, save states, speed) and to the window helper.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const WebSocket = require("ws");

const DEBUGGER_PORT = Number.parseInt(process.env.PPSSPP_DEBUG_PORT || "45999", 10);
const CONNECT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 4000;
const CLOSE_TIMEOUT_MS = 4000;
const EXE_NAMES = ["PPSSPPWindows64.exe", "PPSSPPWindows.exe"];

function findPpsspp(root) {
  if (process.env.PPSSPP_EXE) {
    return fs.existsSync(process.env.PPSSPP_EXE) ? process.env.PPSSPP_EXE : null;
  }
  const folders = [path.join(root, "ppsspp")];
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (base) folders.push(path.join(base, "PPSSPP"));
  }
  if (process.env.LOCALAPPDATA) folders.push(path.join(process.env.LOCALAPPDATA, "Programs", "PPSSPP"));
  for (const folder of folders) {
    for (const name of EXE_NAMES) {
      const candidate = path.join(folder, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function userError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

// One long-lived PowerShell process, so each command answers in milliseconds.
class WinHelper {
  constructor() {
    this.process = null;
    this.pending = [];
  }

  ensure() {
    if (this.process) return;
    const script = path.join(__dirname, "win-helper.ps1");
    this.process = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => {
      const next = this.pending.shift();
      if (!next) return;
      try {
        next.resolve(JSON.parse(line));
      } catch {
        next.resolve({ ok: false, error: line });
      }
    });
    this.process.on("exit", () => {
      this.process = null;
      for (const next of this.pending.splice(0)) next.resolve({ ok: false, error: "helper-exited" });
    });
    this.process.on("error", (error) => console.error("Falha ao iniciar o PowerShell:", error.message));
  }

  run(command) {
    if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "not-windows" });
    this.ensure();
    return new Promise((resolve) => {
      this.pending.push({ resolve });
      this.process.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  stop() {
    if (this.process) this.process.stdin.end();
  }
}

class Ppsspp extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.runtimeDir = path.join(root, ".runtime");
    this.helper = new WinHelper();
    this.child = null;
    this.socket = null;
    this.tickets = new Map();
    this.nextTicket = 1;
  }

  running() {
    return Boolean(this.child) && this.child.exitCode === null;
  }

  // Settings layered over the user's own ppsspp.ini for this run only.
  writeConfig() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const file = path.join(this.runtimeDir, "widescreen.ini");
    fs.writeFileSync(file, [
      "[General]",
      "RemoteDebuggerOnStartup = True",
      `RemoteISOPort = ${DEBUGGER_PORT}`,
      "PauseOnLostFocus = False",
      "PauseWhenMinimized = False",
      "[Graphics]",
      "FullScreen = False",
      "",
    ].join("\r\n"));
    return file;
  }

  async launch(gamePath) {
    const exe = findPpsspp(this.root);
    if (!exe) throw userError("PPSSPP não encontrado no PC. Veja o guia de instalação.");
    await this.close();
    // A PPSSPP left open (by hand, or by a server that crashed) holds the debugger
    // port, and a new one would quietly fall back to another port.
    if (await this.openSocket().then(() => true, () => false)) {
      this.disconnect();
      throw userError("Já existe um PPSSPP aberto no PC. Feche-o e tente de novo.");
    }

    const config = this.writeConfig();
    // The modified build (ppsspp-patch/) runs without a visible window, like the NDS
    // version; the official one ignores --hidden and shows its window for the capture.
    const child = spawn(exe, [`--appendconfig=${config}`, "--windowed", "--hidden", gamePath], {
      cwd: path.dirname(exe),
      stdio: "ignore",
    });
    this.child = child;
    child.on("error", (error) => console.error("Falha ao abrir o PPSSPP:", error.message));
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.disconnect();
      this.emit("exit");
    });
    await this.connect();
  }

  async connect() {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.running()) throw userError("O PPSSPP fechou ao abrir o jogo.");
      try {
        await this.openSocket();
        this.send("version", { name: "WideScreen", version: "1.0.0" });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw userError(`O depurador do PPSSPP não respondeu na porta ${DEBUGGER_PORT}.`);
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${DEBUGGER_PORT}/debugger`, "debugger.ppsspp.org");
      socket.once("open", () => {
        this.socket = socket;
        resolve();
      });
      socket.once("error", reject);
      // The modified PPSSPP build (ppsspp-patch/) sends its game image as binary JPEG frames.
      socket.on("message", (data, isBinary) => {
        if (isBinary) this.emit("frame", data);
        else this.onMessage(data);
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
      });
    });
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const pending = message.ticket !== undefined ? this.tickets.get(message.ticket) : null;
    if (!pending) return;
    this.tickets.delete(message.ticket);
    clearTimeout(pending.timer);
    if (message.event === "error") pending.reject(new Error(message.message || "Erro do PPSSPP"));
    else pending.resolve(message);
  }

  // Fire and forget, for input that is sent many times a second.
  send(event, params = {}) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ event, ...params }));
    }
  }

  request(event, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("PPSSPP desconectado"));
    }
    const ticket = String(this.nextTicket++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tickets.delete(ticket);
        reject(new Error(`Sem resposta para ${event}`));
      }, REQUEST_TIMEOUT_MS);
      this.tickets.set(ticket, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ event, ticket, ...params }));
    });
  }

  // Newer PPSSPP builds have more debugger events (save states, speed); older
  // ones answer an unknown event with an error.
  async supports(event) {
    try {
      await this.request(event);
      return true;
    } catch {
      return false;
    }
  }

  window(place, width, height) {
    if (!this.running()) return Promise.resolve({ ok: false, error: "not-running" });
    return this.helper.run({ cmd: "window", pid: this.child.pid, place, width, height });
  }

  key(vk, down) {
    if (!this.running()) return Promise.resolve({ ok: false });
    return this.helper.run({ cmd: "key", pid: this.child.pid, vk, down });
  }

  async tapKey(vk) {
    await this.key(vk, true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await this.key(vk, false);
  }

  disconnect() {
    for (const pending of this.tickets.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("PPSSPP desconectado"));
    }
    this.tickets.clear();
    if (this.socket) this.socket.terminate();
    this.socket = null;
  }

  // Asks PPSSPP to close normally (it saves its settings), and kills it if it doesn't.
  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.child = null;
    this.disconnect();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await this.helper.run({ cmd: "close", pid: child.pid });
    const timer = setTimeout(() => child.kill(), CLOSE_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  async shutdown() {
    await this.close();
    this.helper.stop();
  }
}

module.exports = { Ppsspp, findPpsspp, DEBUGGER_PORT };
