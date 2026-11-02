// Thin client for the Switch browser: the PC runs PPSSPP and sends JPEG frames
// over a WebSocket; this page draws them and sends buttons and the stick back.
// Kept to older JavaScript syntax because the console's WebKit is old.
(function () {
  "use strict";

  var QUALITY_LABELS = ["baixa", "média", "alta"];
  // Bit order shared with src/psp-session.js:
  // 0 cross, 1 circle, 2 square, 3 triangle, 4 L, 5 R, 6 select, 7 start, 8-11 up/down/left/right.
  var KEY_BITS = {
    KeyZ: 0, KeyX: 1, KeyA: 2, KeyS: 3, KeyQ: 4, KeyW: 5,
    ShiftLeft: 6, ShiftRight: 6, Enter: 7,
    ArrowUp: 8, ArrowDown: 9, ArrowLeft: 10, ArrowRight: 11,
  };
  var KEY_STICK = { KeyJ: [-1, 0], KeyL: [1, 0], KeyI: [0, -1], KeyK: [0, 1] };
  // Gamepad API "standard" indices. On the Switch, 0 is the bottom face button (B),
  // 1 the right one (A), 2 the left (Y), 3 the top (X), 6/7 are ZL/ZR. Matching them by
  // position gives the PSP layout: cross bottom, circle right, square left, triangle top.
  var PAD_TARGETS = [
    { id: 0, label: "Cruz ✕" }, { id: 1, label: "Círculo ○" }, { id: 2, label: "Quadrado □" }, { id: 3, label: "Triângulo △" },
    { id: 4, label: "L" }, { id: 5, label: "R" }, { id: 7, label: "START" }, { id: 6, label: "SELECT" },
    { id: 8, label: "Cima" }, { id: 9, label: "Baixo" }, { id: 10, label: "Esquerda" }, { id: 11, label: "Direita" },
    { id: "turbo", label: "Turbo (segurar)" }, { id: "menu", label: "Abrir o menu" },
  ];
  var DEFAULT_PAD_MAP = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 8, 7: 9, 8: 12, 9: 13, 10: 14, 11: 15, turbo: 6, menu: 7 };
  var STICK_DEADZONE = 0.15;
  var STICK_STEP = 0.03;

  var params = new URLSearchParams(location.search);
  var romPath = params.get("rom") || "";

  var screens = document.getElementById("screens");
  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var gameTitle = document.getElementById("gameTitle");
  var fpsValue = document.getElementById("fpsValue");
  var overlay = document.getElementById("overlay");
  var overlayText = document.getElementById("overlayText");
  var spinner = document.getElementById("spinner");
  var menu = document.getElementById("menu");
  var pauseButton = document.getElementById("pauseButton");
  var qualityButton = document.getElementById("qualityButton");
  var slotNote = document.getElementById("slotNote");
  var toast = document.getElementById("toast");
  var turboBadge = document.getElementById("turboBadge");
  var padStatus = document.getElementById("padStatus");
  var padMapText = document.getElementById("padMapText");
  var captureBox = document.getElementById("captureBox");
  var captureText = document.getElementById("captureText");

  var socket = null;
  var reconnectTimer = null;
  var gotFrame = false;
  var frameImage = new Image();
  var frameUrl = "";
  var drawing = false;
  var pendingBlob = null;
  var toastTimer = null;

  // Each input source keeps its own mask of pressed buttons; PPSSPP sees their OR.
  var touchMask = 0;
  var keyMask = 0;
  var padMask = 0;
  var sentMask = -1;
  var activeTouches = {};
  var keyStick = {};
  var padStick = { x: 0, y: 0 };
  var sentStick = { x: 0, y: 0 };

  var padMap = loadPadMap();
  var padTurbo = false;
  var keyTurbo = false;
  var sentTurbo = null;
  var lastPadButtons = [];
  var lastPadActivity = 0;
  var capture = null;

  var qualityIndex = Number(readSetting("quality", "1"));
  if (!(qualityIndex >= 0 && qualityIndex < QUALITY_LABELS.length)) qualityIndex = 1;

  function readSetting(key, fallback) {
    try {
      var value = localStorage.getItem("widescreen-stream-" + key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function writeSetting(key, value) {
    try {
      localStorage.setItem("widescreen-stream-" + key, String(value));
    } catch (error) {
      // Settings are a convenience only.
    }
  }

  function send(payload) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  function showOverlay(text, busy) {
    overlayText.textContent = text;
    spinner.className = busy ? "spinner" : "spinner hidden";
    overlay.hidden = false;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  // ---- Connection ----

  function connect() {
    clearTimeout(reconnectTimer);
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(protocol + "//" + location.host + "/ws");
    socket.binaryType = "blob";
    socket.onopen = function () {
      showOverlay("Iniciando o jogo no PC…", true);
      send({ t: "quality", level: qualityIndex });
      send({ t: "start", rom: romPath });
      sentMask = -1;
      sentTurbo = null;
      sentStick = { x: 0, y: 0 };
      flushMask();
      flushTurbo();
    };
    socket.onmessage = function (event) {
      if (typeof event.data === "string") handleText(event.data);
      else handleFrame(event.data);
    };
    socket.onclose = function () {
      socket = null;
      showOverlay("Conexão com o PC perdida. Tentando reconectar…", true);
      reconnectTimer = setTimeout(connect, 2000);
    };
  }

  function handleText(text) {
    var message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      return;
    }
    if (message.rom) gameTitle.textContent = message.rom.replace(/\.[^.]+$/, "");
    if (message.t === "turbo") {
      turboBadge.hidden = !message.on;
    } else if (message.t === "stats") {
      fpsValue.textContent = String(message.fps);
    } else if (message.t === "caps") {
      applySlots(message.slots);
      // The modified PPSSPP sends its own image, so there is no window to reposition.
      document.getElementById("recenterButton").hidden = message.windowCapture === false;
    } else if (message.t === "loading") {
      gotFrame = false;
      showOverlay(message.message, true);
    } else if (message.t === "status") {
      if (message.error) {
        showOverlay(message.message, false);
        return;
      }
      pauseButton.textContent = message.paused ? "Continuar" : "Pausar";
      if (message.paused) showOverlay("Pausado", false);
      else if (gotFrame) overlay.hidden = true;
      if (message.message && message.message !== "Jogando") showToast(message.message);
    }
  }

  function applySlots(slots) {
    var extras = document.querySelectorAll(".slot-extra");
    for (var i = 0; i < extras.length; i++) extras[i].hidden = slots < 3;
    slotNote.hidden = slots >= 3;
    document.getElementById("saveSlot1").textContent = slots < 3 ? "Salvar estado" : "Salvar 1";
    document.getElementById("loadSlot1").textContent = slots < 3 ? "Carregar estado" : "Carregar 1";
  }

  function handleFrame(blob) {
    if (drawing) {
      // Only the newest frame matters; acknowledge the dropped one right away.
      if (pendingBlob) send({ t: "ack" });
      pendingBlob = blob;
      return;
    }
    drawFrame(blob);
  }

  function drawFrame(blob) {
    drawing = true;
    frameUrl = URL.createObjectURL(blob);
    frameImage.src = frameUrl;
  }

  frameImage.onload = function () {
    if (canvas.width !== frameImage.width || canvas.height !== frameImage.height) {
      canvas.width = frameImage.width;
      canvas.height = frameImage.height;
    }
    ctx.drawImage(frameImage, 0, 0);
    finishFrame();
    if (!gotFrame) {
      gotFrame = true;
      if (menu.hidden && pauseButton.textContent !== "Continuar") overlay.hidden = true;
    }
  };
  frameImage.onerror = finishFrame;

  function finishFrame() {
    URL.revokeObjectURL(frameUrl);
    drawing = false;
    send({ t: "ack" });
    if (pendingBlob) {
      var next = pendingBlob;
      pendingBlob = null;
      drawFrame(next);
    }
  }

  // ---- Layout ----

  function resizeScreen() {
    var availH = screens.parentNode.clientHeight;
    // Only Start and Select stay on screen, so the picture gets everything but two narrow columns.
    var availW = window.innerWidth - 2 * 96;
    var scale = Math.max(Math.min(availH / 272, availW / 480), 0.5);
    canvas.style.width = Math.floor(480 * scale) + "px";
    canvas.style.height = Math.floor(272 * scale) + "px";
  }

  window.addEventListener("resize", resizeScreen);
  window.addEventListener("load", resizeScreen);

  // ---- Input ----

  function flushMask() {
    var mask = touchMask | keyMask | padMask;
    if (mask === sentMask) return;
    sentMask = mask;
    send({ t: "keys", mask: mask });
  }

  function flushTurbo() {
    var on = (padTurbo || keyTurbo) && menu.hidden && !capture;
    if (on === sentTurbo) return;
    sentTurbo = on;
    send({ t: "turbo", on: on });
  }

  function flushStick() {
    var x = padStick.x;
    var y = padStick.y;
    var key;
    for (key in keyStick) {
      x += KEY_STICK[key][0];
      y += KEY_STICK[key][1];
    }
    if (!menu.hidden || capture) x = y = 0;
    x = Math.max(-1, Math.min(1, x));
    y = Math.max(-1, Math.min(1, y));
    var atRest = x === 0 && y === 0;
    var wasAtRest = sentStick.x === 0 && sentStick.y === 0;
    if (atRest === wasAtRest && Math.abs(x - sentStick.x) < STICK_STEP && Math.abs(y - sentStick.y) < STICK_STEP) return;
    sentStick = { x: x, y: y };
    send({ t: "analog", x: x, y: y });
  }

  function buttonAt(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute("data-bit") !== null) return el;
      el = el.parentNode;
    }
    return null;
  }

  function refreshTouchButtons() {
    var mask = 0;
    for (var id in activeTouches) {
      var el = activeTouches[id];
      if (el) mask |= 1 << Number(el.getAttribute("data-bit"));
    }
    touchMask = mask;
    var buttons = document.querySelectorAll("[data-bit]");
    var all = touchMask | keyMask | padMask;
    for (var i = 0; i < buttons.length; i++) {
      var on = (all & (1 << Number(buttons[i].getAttribute("data-bit")))) !== 0;
      buttons[i].className = buttons[i].className.replace(/\s*pressed/g, "") + (on ? " pressed" : "");
    }
    flushMask();
  }

  function onTouchStart(event) {
    if (!menu.hidden) return;
    event.preventDefault();
    for (var i = 0; i < event.changedTouches.length; i++) {
      var t = event.changedTouches[i];
      activeTouches[t.identifier] = buttonAt(t.clientX, t.clientY);
    }
    refreshTouchButtons();
  }

  function onTouchMove(event) {
    if (!menu.hidden) return;
    event.preventDefault();
    for (var i = 0; i < event.changedTouches.length; i++) {
      var t = event.changedTouches[i];
      if (t.identifier in activeTouches) activeTouches[t.identifier] = buttonAt(t.clientX, t.clientY);
    }
    refreshTouchButtons();
  }

  function onTouchEnd(event) {
    for (var i = 0; i < event.changedTouches.length; i++) delete activeTouches[event.changedTouches[i].identifier];
    refreshTouchButtons();
  }

  var playArea = document.querySelector(".play-area");
  playArea.addEventListener("touchstart", onTouchStart, { passive: false });
  playArea.addEventListener("touchmove", onTouchMove, { passive: false });
  playArea.addEventListener("touchend", onTouchEnd);
  playArea.addEventListener("touchcancel", onTouchEnd);

  // Mouse support, for testing from a PC browser.
  playArea.addEventListener("mousedown", function (event) {
    activeTouches.mouse = buttonAt(event.clientX, event.clientY);
    refreshTouchButtons();
  });
  window.addEventListener("mouseup", function () {
    if (!("mouse" in activeTouches)) return;
    delete activeTouches.mouse;
    refreshTouchButtons();
  });

  window.addEventListener("keydown", function (event) {
    if (event.code === "Space") {
      event.preventDefault();
      keyTurbo = true;
      flushTurbo();
      return;
    }
    if (event.code === "Escape") {
      toggleMenu();
      return;
    }
    if (!menu.hidden) return;
    if (event.code in KEY_STICK) {
      keyStick[event.code] = true;
      flushStick();
      return;
    }
    if (!(event.code in KEY_BITS)) return;
    event.preventDefault();
    keyMask |= 1 << KEY_BITS[event.code];
    refreshTouchButtons();
  });
  window.addEventListener("keyup", function (event) {
    if (event.code === "Space") {
      keyTurbo = false;
      flushTurbo();
    }
    if (event.code in KEY_STICK) {
      delete keyStick[event.code];
      flushStick();
    }
    if (!(event.code in KEY_BITS)) return;
    keyMask &= ~(1 << KEY_BITS[event.code]);
    refreshTouchButtons();
  });

  function loadPadMap() {
    var map = {};
    for (var key in DEFAULT_PAD_MAP) map[key] = DEFAULT_PAD_MAP[key];
    try {
      var saved = JSON.parse(readSetting("padmap", "{}"));
      for (var id in saved) if (id in map && typeof saved[id] === "number") map[id] = saved[id];
    } catch (error) {
      // Fall back to the default layout.
    }
    return map;
  }

  function firstGamepad() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) if (pads[i]) return pads[i];
    return null;
  }

  function isDown(pad, index) {
    var button = pad.buttons[index];
    return Boolean(button && (button.pressed || button.value > 0.5));
  }

  // Rescales a stick past the dead zone so small movements still start at zero.
  function stickValue(value) {
    if (typeof value !== "number" || Math.abs(value) < STICK_DEADZONE) return 0;
    var sign = value < 0 ? -1 : 1;
    return sign * Math.min(1, (Math.abs(value) - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  }

  function pollGamepad() {
    var pad = firstGamepad();
    var mask = 0;
    var stick = { x: 0, y: 0 };
    var now = Date.now();
    if (pad) {
      var pressedNow = [];
      for (var i = 0; i < pad.buttons.length; i++) {
        pressedNow[i] = isDown(pad, i);
        if (pressedNow[i]) lastPadActivity = now;
        if (pressedNow[i] && !lastPadButtons[i]) onPadButtonDown(i);
      }
      lastPadButtons = pressedNow;

      if (menu.hidden && !capture) {
        for (var bit = 0; bit < 12; bit++) {
          if (isDown(pad, padMap[bit])) mask |= 1 << bit;
        }
        // Left stick is the PSP analog stick; the right stick works as the D-pad
        // (handy for games that turn the camera with it).
        stick.x = stickValue(pad.axes[0]);
        stick.y = stickValue(pad.axes[1]);
        if (pad.axes[2] > 0.5) mask |= 1 << 11;
        if (pad.axes[2] < -0.5) mask |= 1 << 10;
        if (pad.axes[3] < -0.5) mask |= 1 << 8;
        if (pad.axes[3] > 0.5) mask |= 1 << 9;
        if (mask !== 0 || stick.x !== 0 || stick.y !== 0) lastPadActivity = now;
      }
      padTurbo = isDown(pad, padMap.turbo);
      padStatus.textContent = "Controle detectado: " + (pad.id || "sem nome");
    }
    if (mask !== padMask) {
      padMask = mask;
      refreshTouchButtons();
    }
    padStick = stick;
    flushStick();
    flushTurbo();
  }
  if (navigator.getGamepads) setInterval(pollGamepad, 16);

  function onPadButtonDown(index) {
    if (capture) {
      padMap[PAD_TARGETS[capture.step].id] = index;
      capture.step++;
      showCaptureStep();
      return;
    }
    if (index === padMap.menu) toggleMenu();
  }

  // ---- Button setup ----

  function showCaptureStep() {
    if (capture.step >= PAD_TARGETS.length) {
      writeSetting("padmap", JSON.stringify(padMap));
      capture = null;
      captureBox.hidden = true;
      showToast("Botões configurados");
      renderPadMap();
      return;
    }
    captureText.textContent = "Aperte no controle o botão para: " + PAD_TARGETS[capture.step].label +
      " (" + (capture.step + 1) + " de " + PAD_TARGETS.length + ")";
  }

  function renderPadMap() {
    var parts = [];
    for (var i = 0; i < PAD_TARGETS.length; i++) {
      parts.push(PAD_TARGETS[i].label + " = botão " + padMap[PAD_TARGETS[i].id]);
    }
    padMapText.textContent = parts.join(" · ");
  }

  // ---- Menu ----

  function toggleMenu(open) {
    var show = typeof open === "boolean" ? open : menu.hidden;
    menu.hidden = !show;
    flushTurbo();
    if (show) {
      activeTouches = {};
      keyMask = 0;
      keyStick = {};
      refreshTouchButtons();
    }
    flushStick();
  }

  function applyQuality() {
    qualityButton.textContent = "Qualidade: " + QUALITY_LABELS[qualityIndex];
  }

  document.getElementById("menuButton").addEventListener("click", function () { toggleMenu(true); });
  menu.addEventListener("click", function (event) {
    var target = event.target;
    if (target === menu) {
      toggleMenu(false);
      return;
    }
    var action = target.getAttribute && target.getAttribute("data-action");
    if (!action) return;
    if (action === "close") {
      toggleMenu(false);
    } else if (action === "quality") {
      qualityIndex = (qualityIndex + 1) % QUALITY_LABELS.length;
      writeSetting("quality", qualityIndex);
      send({ t: "quality", level: qualityIndex });
      applyQuality();
    } else if (action === "pad-setup") {
      capture = { step: 0 };
      captureBox.hidden = false;
      showCaptureStep();
    } else if (action === "pad-cancel") {
      capture = null;
      captureBox.hidden = true;
      padMap = loadPadMap();
      renderPadMap();
    } else if (action === "pad-reset") {
      writeSetting("padmap", "{}");
      padMap = loadPadMap();
      renderPadMap();
      showToast("Botões padrão restaurados");
    } else if (action === "save-state" || action === "load-state") {
      send({ t: action, slot: Number(target.getAttribute("data-slot")) });
      toggleMenu(false);
    } else {
      send({ t: action });
      if (action === "reset") toggleMenu(false);
      if (action === "recenter") showToast("Janela do PPSSPP reposicionada");
    }
  });

  // The Switch's B button also means "back" in its browser. Stay on the page; when
  // the controller is in use, B is a game button, otherwise "back" opens the menu.
  if (window.history && history.pushState) {
    history.pushState({ widescreen: true }, "", location.href);
    window.addEventListener("popstate", function () {
      history.pushState({ widescreen: true }, "", location.href);
      if (Date.now() - lastPadActivity > 1000) toggleMenu();
    });
  }

  if (!romPath) {
    showOverlay("Nenhum jogo escolhido. Volte à biblioteca.", false);
    gameTitle.textContent = "WideScreen";
  } else {
    gameTitle.textContent = decodeURIComponent(romPath.split("/").pop()).replace(/\.[^.]+$/, "");
    connect();
  }
  applyQuality();
  resizeScreen();
  renderPadMap();
}());
