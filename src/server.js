"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { PspSession } = require("./psp-session");
const { findPpsspp } = require("./ppsspp");
const { ffmpegPath } = require("./capture");
const { NativeCore } = require("./native-core");

const ROOT = path.resolve(__dirname, "..");
const ROM_DIR = path.join(ROOT, "roms");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8889", 10);
const ROM_EXTENSIONS = new Set([".iso", ".cso", ".chd", ".pbp"]);
const LANGUAGE_LABELS = {
  "portugues-br": "Português (Brasil)",
  ingles: "Inglês",
  multilingue: "Multilíngue · EN / FR / DE / ES / IT",
};
const STATIC_FILES = new Set([
  "index.html",
  "stream.html",
  "src/library.css",
  "src/library.js",
  "src/stream.css",
  "src/stream.js",
]);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT precisa ser um número entre 1 e 65535.");
}

function send(res, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  res.end(data);
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function staticFilePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;

  const relative = decoded.replace(/^\/+/, "");
  if (!STATIC_FILES.has(relative)) return null;
  return path.resolve(ROOT, relative);
}

async function listRoms() {
  let entries;
  try {
    entries = await fs.promises.readdir(ROM_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const games = [];
  const folders = [{ name: "", entries }];
  for (const entry of entries) {
    if (!entry.name.startsWith(".") && entry.isDirectory()) {
      folders.push({ name: entry.name });
    }
  }

  for (const folder of folders) {
    let files = folder.entries;
    if (!files) {
      try {
        files = await fs.promises.readdir(path.join(ROM_DIR, folder.name), { withFileTypes: true });
      } catch {
        continue;
      }
    }
    for (const file of files) {
      if (file.name.startsWith(".") || !file.isFile()) continue;
      const extension = path.extname(file.name).toLowerCase();
      if (!ROM_EXTENSIONS.has(extension)) continue;
      try {
        const info = await fs.promises.lstat(path.join(ROM_DIR, folder.name, file.name));
        if (!info.isFile()) continue;
        games.push({
          name: file.name,
          extension,
          size: info.size,
          language: folder.name || "sem-categoria",
          languageLabel: LANGUAGE_LABELS[folder.name] || folder.name || "Sem categoria",
          relativePath: folder.name ? `${folder.name}/${file.name}` : file.name,
        });
      } catch {
        // Ignore files that disappear while the library is being refreshed.
      }
    }
  }
  return games;
}

// Returns the absolute path of a game inside roms/ (at most one folder deep), or null.
async function resolveRomPath(relativePath) {
  const segments = relativePath.split("/");
  if (segments.length < 1 || segments.length > 2 || segments.some((segment) => !segment || segment.startsWith(".") || segment.includes("\\") || segment.includes("\0"))) {
    return null;
  }
  if (!ROM_EXTENSIONS.has(path.extname(segments[segments.length - 1]).toLowerCase())) {
    return null;
  }

  const filePath = path.resolve(ROM_DIR, ...segments);
  if (path.relative(ROM_DIR, filePath).startsWith("..")) {
    return null;
  }
  if (segments.length === 2) {
    try {
      const folderInfo = await fs.promises.lstat(path.join(ROM_DIR, segments[0]));
      if (!folderInfo.isDirectory()) throw new Error("Invalid folder");
    } catch {
      return null;
    }
  }

  let info;
  try {
    info = await fs.promises.lstat(filePath);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  return { filePath, size: info.size };
}

function systemStatus() {
  return {
    windows: process.platform === "win32",
    ppsspp: findPpsspp(ROOT),
    native: Boolean(session.native),
    ffmpeg: Boolean(ffmpegPath()),
    game: session.gameName || null,
  };
}

async function handle(req, res) {
  if (req.method !== "GET") {
    send(res, 405, "Método não permitido.", "text/plain; charset=utf-8", { Allow: "GET" });
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url, "http://localhost");
  } catch {
    send(res, 400, "Endereço inválido.");
    return;
  }
  if (requestUrl.pathname === "/api/roms") {
    send(res, 200, JSON.stringify(await listRoms()), "application/json; charset=utf-8");
    return;
  }
  if (requestUrl.pathname === "/api/status") {
    send(res, 200, JSON.stringify(systemStatus()), "application/json; charset=utf-8");
    return;
  }

  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = staticFilePath(requestedPath);
  if (!filePath) {
    send(res, 404, "Página não encontrada.");
    return;
  }

  let info;
  try {
    info = await fs.promises.stat(filePath);
  } catch {
    send(res, 404, "Arquivo não encontrado.");
    return;
  }
  if (!info.isFile()) {
    send(res, 404, "Arquivo não encontrado.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": info.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function networkAddresses() {
  const values = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  return values
    // 169.254.x.x is a link-local address (Bluetooth, Wi-Fi Direct): never the Wi-Fi the Switch is on.
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
}

function printAccessUrls() {
  const addresses = HOST === "127.0.0.1" || HOST === "localhost" ? ["127.0.0.1"] : networkAddresses();
  console.log("\nWideScreen está pronto:");
  if (addresses.length === 0) {
    console.log(`  http://localhost:${PORT}`);
  } else {
    for (const address of addresses) {
      console.log(`  http://${address}:${PORT}`);
    }
  }
  console.log("\nUse o endereço do mesmo Wi-Fi no navegador do Switch.");
  const status = systemStatus();
  if (!status.windows) console.log("Aviso: a captura da janela do PPSSPP só funciona no Windows.");
  if (status.native) console.log("O PPSSPP roda dentro deste processo (addon nativo).");
  else if (!status.ppsspp) console.log("Aviso: PPSSPP não encontrado. Rode build-ppsspp.bat, coloque-o na pasta ppsspp/ ou defina PPSSPP_EXE.");
  if (!status.native && !status.ffmpeg) console.log("Aviso: ffmpeg não encontrado. Rode npm install de novo ou defina FFMPEG_PATH.");
  console.log("");
}

function openLocalBrowser() {
  if (process.platform !== "win32") return;
  const url = `http://127.0.0.1:${PORT}`;
  const browser = spawn("explorer.exe", [url], { detached: true, stdio: "ignore" });
  browser.on("error", (error) => console.warn("Não foi possível abrir o navegador:", error.message));
  browser.unref();
}

for (const folder of Object.keys(LANGUAGE_LABELS)) {
  fs.mkdirSync(path.join(ROM_DIR, folder), { recursive: true });
}
const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("Falha ao processar solicitação:", error.message);
    if (!res.headersSent) send(res, 500, "Erro interno do servidor.");
    else res.destroy();
  });
});

const session = new PspSession(ROOT);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://localhost").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
});

sockets.on("connection", (ws) => {
  const client = session.addClient(ws);
  ws.on("message", async (data, isBinary) => {
    if (isBinary) return;
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.t !== "start") {
      session.handleMessage(client, message);
      return;
    }
    const rom = typeof message.rom === "string" ? await resolveRomPath(message.rom) : null;
    if (!rom) {
      ws.send(JSON.stringify({ t: "status", message: "Jogo não encontrado.", error: true }));
      return;
    }
    try {
      await session.loadGame(rom.filePath, path.basename(rom.filePath));
    } catch (error) {
      console.error("Falha ao iniciar o jogo:", error.message);
      session.broadcastError(error.userMessage || "Falha ao iniciar o PPSSPP.");
    }
  });
  ws.on("close", () => session.removeClient(client));
  ws.on("error", () => session.removeClient(client));
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await session.shutdown();
    process.exit(0);
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`A porta ${PORT} já está em uso. Feche a outra janela do servidor ou defina outra PORT.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  printAccessUrls();
  if (process.argv.includes("--open")) openLocalBrowser();
});
