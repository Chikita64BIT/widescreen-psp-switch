# WideScreen — PSP no Nintendo Switch

Jogue PSP no navegador do **Nintendo Switch sem modificação**. O PC roda o emulador [PPSSPP](https://www.ppsspp.org/) **dentro do próprio servidor Node** e transmite a imagem pelo Wi-Fi. O Switch mostra a imagem e devolve os botões e o analógico dos Joy-Con. No PC só aparece o terminal com o endereço.

É a mesma ideia do [DualScreen-NDS-Switch](https://github.com/Chikita64BIT/DualScreen-NDS-Switch), adaptada para o PSP. O navegador do Switch não tem WebAssembly, então o trabalho pesado fica no PC.

> **Guia passo a passo:** [INSTALACAO.md](INSTALACAO.md)

## Diferença em relação à versão de NDS

O DualScreen roda o núcleo melonDS em WebAssembly dentro do Node. Em WebAssembly o PSP ficaria lento demais, porque precisa da placa de vídeo e de JIT. Por isso o WideScreen roda o PPSSPP como **código nativo dentro do processo do Node**:

- `lib/ppsspp_libretro.dll` é o núcleo libretro do PPSSPP 1.20.4, compilado com o patch deste projeto.
- `native/` é um addon C++ do Node que carrega essa DLL numa thread própria, com um contexto OpenGL escondido. A cada quadro ele lê a imagem da GPU, codifica em JPEG e entrega ao servidor.
- Botões, analógico, pausa, reinício, estados salvos (3 slots, em `saves/`) e turbo de 3x vão direto para o núcleo.
- O som é descartado: no Switch não haveria como tocá-lo, e assim nada toca no PC.

Velocidade medida no Danganronpa: 60 quadros por segundo, 180 com o turbo.

### Modo reserva: PPSSPP como programa separado

Se o addon não estiver compilado, o servidor abre o `ppsspp/PPSSPPWindows64.exe` e conversa com ele pelo depurador remoto (WebSocket local):

- **PPSSPP modificado** (montado pelo `build-ppsspp.bat`): roda escondido (`--hidden`), sem som, e envia a imagem sozinho. Também tem 3 slots e turbo.
- **PPSSPP oficial**: a janela aparece no canto da tela, sempre por cima, e o `ffmpeg` captura a imagem dela. Os estados salvos usam o slot atual (F2/F4) e o turbo usa a tecla Tab.

Para forçar o modo reserva mesmo com o addon compilado, defina `PPSSPP_ENGINE=program`.

## Como montar o PPSSPP

Rode `build-ppsspp.bat` (precisa de Git, Node.js e Visual Studio com C++). Ele baixa o código do PPSSPP 1.20.4, aplica o [patch](ppsspp-patch/webstream.patch) e monta:

1. o núcleo `lib/ppsspp_libretro.dll` e a pasta de sistema `lib/system/PPSSPP`;
2. o PPSSPP separado `ppsspp/PPSSPPWindows64.exe`;
3. o addon `native/build/Release/ppsspp_core.node` (`npm run build:native`).

O patch acrescenta ao PPSSPP:

| Item | Função |
|---|---|
| `--hidden` | Abre o PPSSPP separado sem janela e sem som. |
| `stream.start` | Começa a enviar quadros pelo depurador. Parâmetros opcionais: `quality` (1–100), `maxRes` (múltiplo de 480x272) e `maxInFlight` (quadros sem confirmação). Cada quadro chega como mensagem binária com um JPEG. |
| `stream.ack` | Confirma um quadro recebido. Não tem resposta. |
| `stream.stop` | Para de enviar. |
| `game.state.save`, `game.state.load` | Salvam e carregam um slot (`slot`, a partir de 0). Mesmo formato das versões novas do PPSSPP. |
| `game.speed.get`, `game.speed.set` | Liga e desliga o avanço rápido (`fastForward`). |

## Arquitetura

```text
+------------------------------------------------------------------------+
|                    PC  (Windows + Node.js, um processo)                |
|                                                                        |
|  +----------------+        +----------------------------------------+  |
|  |  roms/  *.iso  |------->|  Addon native/ + ppsspp_libretro.dll   |  |
|  |  saves/ estados|<-------|  thread própria, OpenGL escondido      |  |
|  +----------------+        |  ~60 FPS, JIT, sem som                 |  |
|                            +-------------------+--------------------+  |
|                          quadro 960x544        |          ^  botões,   |
|                          JPEG (outra thread)   v          |  analógico |
|                            +-------------------+----------+---------+  |
|                            |  src/server.js: HTTP + WebSocket :8889 |  |
|                            +-------------------+----------^---------+  |
+------------------------------------------------|----------|------------+
                     JPEG binário (WebSocket)    |          |  JSON: botões,
                     1 quadro por confirmação    v          |  analógico, turbo
+------------------------------------------------|----------|------------+
|                 NINTENDO SWITCH / SWITCH LITE (sem modificação)        |
|  Navegador WebKit oculto (aberto pelo teste de DNS)                    |
|  stream.html + src/stream.js                                           |
|   - Imagem: JPEG -> Image -> <canvas> 480x272 (ou 960x544)             |
|   - Gamepad API: Joy-Con lidos a cada 16 ms (ZL turbo, ZR menu)        |
+------------------------------------------------------------------------+
```

## Recursos

- Biblioteca de jogos no navegador, agrupada por idioma (`roms/portugues-br`, `roms/ingles`, `roms/multilingue`). Aceita `.iso`, `.cso`, `.chd` e `.pbp`.
- Streaming para o Switch a ~60 FPS, em JPEG por WebSocket, com controle de fluxo para o atraso não se acumular.
- Analógico esquerdo do Switch = analógico do PSP. Analógico direito funciona como direcional (útil para girar a câmera).
- Turbo segurando o ZL. Menu no ZR ou no botão B.
- Estados salvos: 3 slots (só o slot atual com o PPSSPP oficial no modo reserva).
- Três níveis de qualidade de imagem e mapeamento de botões configurável.
- O jogo abre e fecha sozinho, sem janela no PC. Sem nenhum aparelho conectado, a emulação pausa e a imagem para.

## Início rápido (Windows)

1. Instale o [Node.js](https://nodejs.org) LTS (20.11 ou mais novo).
2. Monte o PPSSPP com `build-ppsspp.bat` (recomendado; veja [INSTALACAO.md](INSTALACAO.md)). Sem isso, também funciona com o [PPSSPP oficial](https://www.ppsspp.org/download/) na pasta `ppsspp/`, no modo reserva.
3. Coloque seus jogos nas pastas de `roms/`.
4. Dê dois cliques em `start.bat`.
5. No Switch, abra o navegador e acesse o endereço mostrado no terminal, por exemplo `http://192.168.1.10:8889`.

Variáveis de ambiente opcionais:

| Variável | Padrão | Função |
|---|---|---|
| `PORT` | `8889` | Porta do servidor (a versão de NDS usa a 8888, então as duas podem rodar juntas) |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` para aceitar só o próprio PC |
| `PPSSPP_ENGINE` | dentro do Node | `program` usa o PPSSPP separado mesmo com o addon compilado |
| `PPSSPP_EXE` | procura sozinho | Caminho completo do `PPSSPPWindows64.exe` (modo reserva) |
| `PPSSPP_DEBUG_PORT` | `45999` | Porta do depurador do PPSSPP |
| `FFMPEG_PATH` | ffmpeg do npm | Outro executável do ffmpeg |

## Controles no Switch

| Switch | PSP |
|---|---|
| B (baixo) | ✕ Cruz |
| A (direita) | ○ Círculo |
| Y (esquerda) | □ Quadrado |
| X (cima) | △ Triângulo |
| L, R | L, R |
| + / − | START / SELECT |
| D-pad | Direcional |
| Analógico esquerdo | Analógico |
| Analógico direito | Direcional |
| ZL (segurar) | Turbo |
| ZR | Menu |

Os botões seguem a **posição** do PSP (o de baixo é o ✕). Se preferir outro jeito, use **Menu → Configurar botões**.

No teclado do PC (para testar): Z ✕, X ○, A □, S △, Q L, W R, Enter START, Shift SELECT, setas direcional, I/J/K/L analógico, Espaço turbo, Esc menu.

## Limitações

- **Só Windows:** o addon usa OpenGL pelo Windows, e o modo reserva usa a captura de janela e atalhos do Windows.
- **Com o PPSSPP oficial (modo reserva), a janela precisa ficar visível.** O servidor a coloca no canto superior esquerdo, com 960x544 e sempre no topo. Não minimize nem cubra essa janela. Se ela sair do lugar, use **Menu → Reposicionar janela no PC**.
- **Sem som:** o navegador do Switch não oferece uma API de áudio utilizável, e o som também não toca no PC (só com o PPSSPP oficial, no modo reserva).
- **Uma partida por vez:** abrir outro jogo fecha o atual e carrega o novo.
- **Com o PPSSPP oficial (modo reserva):** só o slot de estado atual, pelas teclas F2 e F4, e o turbo pela tecla Tab. Para isso o servidor traz a janela do PPSSPP para a frente. O PPSSPP modificado não tem essa limitação.
- **Sem senha:** qualquer aparelho da rede local que alcance a porta pode abrir a biblioteca. Não exponha a porta na internet.

## Estrutura

| Caminho | Função |
|---|---|
| `src/server.js` | Servidor HTTP, lista de jogos e WebSocket `/ws` |
| `src/psp-session.js` | Liga tudo: abre o jogo, repassa os botões, distribui os quadros |
| `src/native-core.js` | Usa o addon para rodar o PPSSPP dentro do Node |
| `native/` | Addon C++ do Node (`ppsspp_core.cc`) que roda o núcleo libretro |
| `lib/` | Núcleo `ppsspp_libretro.dll` e pasta de sistema, montados pelo build (fora do Git) |
| `src/ppsspp.js` | Modo reserva: abre e fecha o PPSSPP separado e conversa com o depurador dele |
| `src/capture.js` | Modo reserva com o PPSSPP oficial: captura a janela com o ffmpeg |
| `src/win-helper.ps1` | Acha, posiciona e fecha a janela do PPSSPP e envia atalhos |
| `ppsspp-patch/webstream.patch` | Patch do PPSSPP com o streaming embutido |
| `build-ppsspp.bat` | Baixa o PPSSPP, aplica o patch e monta o núcleo, o addon e o PPSSPP separado |
| `ppsspp-src/` | Código do PPSSPP baixado pelo build (fora do Git) |
| `stream.html`, `src/stream.js`, `src/stream.css` | Página de streaming usada no Switch |
| `index.html`, `src/library.js`, `src/library.css` | Biblioteca de jogos |
| `roms/` | Seus jogos (fora do Git) |
| `ppsspp/` | Opcional: PPSSPP portátil (fora do Git) |

O progresso dos jogos (o save do próprio jogo) fica em `ppsspp/memstick`, a mesma pasta do PPSSPP separado, então os dois veem o mesmo progresso. Sem a pasta `ppsspp/`, fica em `saves/memstick`. Os estados salvos ficam em `saves/`.

## Créditos e licença

- Projeto original para NDS: [DualScreen-NDS-Switch](https://github.com/Chikita64BIT/DualScreen-NDS-Switch). A estrutura do servidor, da biblioteca e da página de streaming vem dele.
- Emulador: [PPSSPP](https://github.com/hrydgard/ppsspp), GPL-2.0 ou posterior. Não vem junto com este projeto. O patch em `ppsspp-patch/` modifica o PPSSPP e segue a mesma GPL-2.0 ou posterior; quem distribuir um executável ou a DLL montados com ele precisa oferecer o código-fonte correspondente. O addon carrega o núcleo GPL dentro do processo do servidor, então confira essas obrigações antes de redistribuir o conjunto.
- Codificador JPEG do addon: [jpge](https://github.com/richgel999/jpeg-compressor), de Rich Geldreich (domínio público ou Apache 2.0).
- Captura: [FFmpeg](https://ffmpeg.org/), pelo pacote [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static).
- Ideia do streaming para o Switch: [switch-gba](https://github.com/itsbjoern/switch-gba).
- Licença: MPL-2.0, a mesma do projeto original. Veja [LICENSE](LICENSE).

Este projeto não distribui jogos, BIOS, firmware nem arquivos de sistema. Use somente jogos que você tenha direito de utilizar. PSP é marca da Sony e Nintendo Switch é marca da Nintendo; este projeto não tem relação com nenhuma das duas.
