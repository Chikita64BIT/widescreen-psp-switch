// Library page. Kept to older JavaScript syntax because it also runs in the
// Switch's WebKit.
(function () {
  "use strict";

  var gameList = document.getElementById("gameList");
  var libraryStatus = document.getElementById("libraryStatus");
  var emptyState = document.getElementById("emptyState");
  var refreshButton = document.getElementById("refreshButton");
  var systemWarning = document.getElementById("systemWarning");
  var PRIORITY = ["portugues-br", "ingles", "multilingue", "sem-categoria"];

  function getJson(url, done) {
    var request = new XMLHttpRequest();
    request.open("GET", url);
    request.setRequestHeader("Accept", "application/json");
    request.onload = function () {
      if (request.status !== 200) return done(new Error("HTTP " + request.status));
      try {
        done(null, JSON.parse(request.responseText));
      } catch (error) {
        done(error);
      }
    };
    request.onerror = function () { done(new Error("Falha de rede")); };
    request.send();
  }

  function formatSize(bytes) {
    if (!(bytes > 0)) return "Tamanho desconhecido";
    var units = ["B", "KB", "MB", "GB"];
    var value = bytes;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return (value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)) + " " + units[unit];
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function createGameCard(game) {
    var card = element("article", "game-card");
    var top = element("div", "game-topline");
    top.appendChild(element("span", "game-format", game.extension.toUpperCase().replace(".", "")));
    top.appendChild(element("span", "game-size", formatSize(game.size)));

    var link = element("a", "play-link", "Jogar no Switch · streaming");
    link.href = "/stream.html?rom=" + encodeURIComponent(game.relativePath);
    link.setAttribute("aria-label", "Jogar " + game.name + " por streaming");
    var arrow = element("span", "", "↗");
    arrow.setAttribute("aria-hidden", "true");
    link.appendChild(arrow);

    card.appendChild(top);
    card.appendChild(element("h3", "game-name", game.name.replace(/\.[^.]+$/, "")));
    card.appendChild(link);
    return card;
  }

  function groupOrder(a, b) {
    var aOrder = PRIORITY.indexOf(a.key);
    var bOrder = PRIORITY.indexOf(b.key);
    if (aOrder !== -1 || bOrder !== -1) {
      return (aOrder === -1 ? PRIORITY.length : aOrder) - (bOrder === -1 ? PRIORITY.length : bOrder);
    }
    return a.key.localeCompare(b.key, "pt-BR");
  }

  function renderGames(games) {
    if (games.length === 0) {
      libraryStatus.textContent = "0 jogos encontrados";
      emptyState.hidden = false;
      return;
    }
    var groups = {};
    var list = [];
    for (var i = 0; i < games.length; i++) {
      var game = games[i];
      if (!groups[game.language]) {
        groups[game.language] = { key: game.language, label: game.languageLabel, games: [] };
        list.push(groups[game.language]);
      }
      groups[game.language].games.push(game);
    }
    list.sort(groupOrder);

    for (var g = 0; g < list.length; g++) {
      var group = list[g];
      var section = element("section", "language-group");
      var heading = element("div", "language-heading");
      heading.appendChild(element("h3", "", group.label));
      heading.appendChild(element("span", "", group.games.length + (group.games.length === 1 ? " jogo" : " jogos")));
      var grid = element("div", "game-grid");
      group.games.sort(function (a, b) { return a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }); });
      for (var j = 0; j < group.games.length; j++) grid.appendChild(createGameCard(group.games[j]));
      section.appendChild(heading);
      section.appendChild(grid);
      gameList.appendChild(section);
    }
    libraryStatus.textContent = games.length + (games.length === 1 ? " jogo encontrado" : " jogos encontrados") +
      " · " + list.length + (list.length === 1 ? " grupo" : " grupos de idioma");
  }

  function loadLibrary() {
    refreshButton.disabled = true;
    libraryStatus.textContent = "Procurando jogos…";
    emptyState.hidden = true;
    while (gameList.firstChild) gameList.removeChild(gameList.firstChild);

    getJson("/api/roms", function (error, games) {
      refreshButton.disabled = false;
      if (error || !games || typeof games.length !== "number") {
        libraryStatus.textContent = "Não foi possível carregar a biblioteca.";
        return;
      }
      renderGames(games);
    });
  }

  function checkSystem() {
    getJson("/api/status", function (error, status) {
      if (error || !status) return;
      var problems = [];
      if (!status.windows) problems.push("A captura da janela do PPSSPP só funciona com o servidor rodando no Windows.");
      if (!status.native && !status.ppsspp) problems.push("O PPSSPP não foi encontrado no PC. Rode build-ppsspp.bat, coloque-o na pasta ppsspp/ do projeto ou defina PPSSPP_EXE.");
      if (!status.native && !status.ffmpeg) problems.push("O ffmpeg não foi encontrado. Rode o start.bat de novo para instalar as dependências.");
      if (problems.length === 0) return;
      systemWarning.textContent = problems.join(" ");
      systemWarning.hidden = false;
    });
  }

  refreshButton.addEventListener("click", loadLibrary);

  if (location.protocol === "file:") {
    refreshButton.disabled = true;
    libraryStatus.textContent = "Abra o projeto pelo servidor local.";
    emptyState.hidden = false;
    emptyState.querySelector("h3").textContent = "Inicie pelo start.bat";
    emptyState.querySelector("p").textContent =
      "Volte à pasta do projeto e execute start.bat. O navegador abrirá a biblioteca no endereço correto.";
  } else {
    checkSystem();
    loadLibrary();
  }
}());
