# Guia de instalação

Este guia leva do zero até um jogo de PSP rodando no Switch. Leva uns 15 minutos, mais o tempo de compilar o PPSSPP (cerca de uma hora, sem precisar acompanhar).

## Do que você precisa

| Item | Detalhes |
|---|---|
| PC com Windows 10 ou 11 | É ele que roda o emulador. Precisa de uma placa de vídeo que rode o PPSSPP bem. |
| Node.js 20.11 ou mais novo | Baixe a versão **LTS** em [nodejs.org](https://nodejs.org). |
| Git e Visual Studio Community com C++ | Para montar o PPSSPP dentro do Node (recomendado). Sem eles, dá para usar o [PPSSPP oficial](https://www.ppsspp.org/download/). |
| Nintendo Switch ou Switch Lite | Sem desbloqueio nem modificação. |
| Mesma rede Wi-Fi | O PC e o Switch precisam estar na mesma rede. O PC pode usar cabo. |
| Jogos de PSP | Arquivos `.iso`, `.cso`, `.chd` ou `.pbp` dos seus próprios jogos. Não vêm com o projeto. |

## 1. Instalar o Node.js

1. Baixe o instalador **LTS** em [nodejs.org](https://nodejs.org) e instale com as opções padrão.
2. Para conferir, abra o **Prompt de Comando** e digite `node -v`. Deve aparecer `v20.11.0` ou um número maior.

## 2. Montar o PPSSPP

O jeito recomendado é montar o PPSSPP com o script do projeto. Assim ele roda **dentro do servidor Node**, igual à versão de NDS: nada abre no PC além do terminal, a imagem sai a 60 quadros por segundo, e você tem 3 slots de estado salvo e o turbo.

1. Instale o [Git](https://git-scm.com) e o [Visual Studio Community](https://visualstudio.microsoft.com/pt-br/vs/community/) com a carga de trabalho **Desenvolvimento para desktop com C++**.
2. Dê dois cliques em **`build-ppsspp.bat`**. Ele:
   - baixa o código do PPSSPP 1.20.4 (cerca de 1 GB na pasta `ppsspp-src\`);
   - aplica o patch deste projeto;
   - compila o núcleo `lib\ppsspp_libretro.dll` e o PPSSPP separado `ppsspp\PPSSPPWindows64.exe` (de 40 a 90 minutos no total);
   - compila o addon do Node em `native\build\Release\`.
3. No terminal do `start.bat` aparece "O PPSSPP roda dentro deste processo (addon nativo)."

Seus saves na pasta `ppsspp\memstick` continuam valendo.

### Sem compilar: PPSSPP oficial (modo reserva)

Se não quiser instalar o Visual Studio, use o PPSSPP oficial. Funciona, mas a janela dele aparece no PC (é dela que a imagem é capturada), o som toca no PC, e os estados salvos usam só o slot atual.

- **Versão portátil (ZIP):** extraia o conteúdo de [ppsspp.org/download](https://www.ppsspp.org/download/) para a pasta `ppsspp\` deste projeto, de modo que exista `ppsspp\PPSSPPWindows64.exe`.
- **Instalador:** instale normalmente. O servidor procura o PPSSPP em `C:\Program Files\PPSSPP`.
- **Outro lugar:** antes de iniciar, defina o caminho no Prompt de Comando:

  ```bat
  set PPSSPP_EXE=D:\Emuladores\PPSSPP\PPSSPPWindows64.exe
  ```

Nesse modo o servidor liga o modo janela, o depurador remoto na porta 45999 e o "não pausar quando perder o foco". O PPSSPP grava esses ajustes na configuração dele. Para desligar o depurador depois, vá em Configurações → Ferramentas → Ferramentas de desenvolvedor. Feche o PPSSPP antes de escolher um jogo: o servidor o abre sozinho e avisa se já houver um aberto.

## 3. Colocar os jogos

Copie os jogos para as pastas dentro de `roms/`:

```text
roms/
├── portugues-br/   jogos ou traduções em português
├── ingles/         versões em inglês
└── multilingue/    jogos com vários idiomas
```

- Se o jogo estiver em `.zip`, `.rar` ou `.7z`, **extraia antes**.
- Jogos da PSN costumam vir como uma pasta com um `EBOOT.PBP`. Renomeie o arquivo para o nome do jogo, por exemplo `Patapon.pbp`, e coloque-o direto na pasta de idioma.
- Arquivos colocados direto em `roms/` aparecem como "Sem categoria".

## 4. Iniciar o servidor no PC

1. Dê dois cliques em **`start.bat`**.
2. Na primeira vez, ele instala as dependências (`ws` e `ffmpeg-static`, cerca de 80 MB). Isso precisa de internet.
3. O **Firewall do Windows** pode perguntar duas coisas:
   - Para o **Node.js**: marque **Redes privadas** e clique em **Permitir acesso**. Sem isso, o Switch não conecta.
   - Para o **PPSSPP**: clique em **Cancelar**. O depurador do PPSSPP só precisa ser acessado pelo próprio PC, e deixá-lo aberto na rede permitiria que outros aparelhos mexessem no jogo.
4. O terminal mostra o endereço para usar no Switch:

   ```text
   WideScreen está pronto:
     http://SeuIP:8889
   ```

5. A biblioteca também abre no navegador do PC. Se aparecer um aviso amarelo, o PPSSPP ou o ffmpeg não foram encontrados. Deixe a janela do terminal aberta enquanto joga.

## 5. Abrir o navegador no Switch

O Switch tem um navegador escondido, que o console abre quando a rede pede um login. Para chegar a ele, use um DNS público que faz essa página aparecer. O mais conhecido é o **SwitchBru**:

1. No Switch, vá em **Configurações do sistema → Internet → Configurações de Internet**.
2. Escolha a sua rede Wi-Fi e depois **Alterar configurações**.
3. Em **Configurações de DNS**, escolha **Manual**.
4. Em **DNS primário**, digite `045.055.142.122` e salve.
5. Escolha **Conectar a esta rede**. O Switch avisa que é preciso se registrar na rede. Toque em **Seguinte**.
6. A página do SwitchBru abre. No campo de endereço, digite o IP que apareceu no terminal do PC, por exemplo `http://192.22.22.22:8889`.

Avisos sobre esse método:

- Ele **não é oficial** da Nintendo. Enquanto o DNS manual estiver ativo, o console consulta os endereços por esse servidor de terceiros.
- Algumas versões do sistema fecham o navegador depois de um tempo, em torno de 20 minutos. Se acontecer, repita o passo 5. O jogo continua de onde parou, porque ele roda no PC.
- Para voltar ao normal, mude o DNS para **Automático** na mesma tela.

## 6. Jogar

1. Na biblioteca, toque em **Jogar no Switch · streaming** no jogo que quiser.
2. No PC, com o PPSSPP montado pelo `build-ppsspp.bat`, nada aparece: ele roda dentro do servidor. Com o PPSSPP oficial, ele abre no canto superior esquerdo da tela, sempre por cima das outras janelas; **não minimize nem cubra essa janela**, porque é dela que a imagem é capturada.
3. No Switch, aperte qualquer botão do Joy-Con para o navegador reconhecer o controle.

| Switch | PSP |
|---|---|
| B, A, Y, X | ✕, ○, □, △ (mesma posição) |
| L, R | L, R |
| + / − | START / SELECT |
| D-pad | Direcional |
| Analógico esquerdo | Analógico |
| Analógico direito | Direcional |
| ZL (segurar) | Turbo |
| ZR | Menu |

No **menu** você encontra:

- Pausar e reiniciar.
- Salvar e carregar estados.
- Qualidade da imagem: baixa, média ou alta (alta envia 960x544).
- Reposicionar a janela do PPSSPP no PC.
- Configurar botões e voltar aos botões padrão.
- Sair para a biblioteca.

O progresso do jogo (save do próprio jogo) é guardado pelo PPSSPP, como sempre.

## Solução de problemas

| Problema | O que fazer |
|---|---|
| O Switch não abre a página | Confira se o PC e o Switch estão na mesma rede e se o terminal ainda está aberto. Libere o Node.js no Firewall do Windows (Painel de Controle → Firewall → Permitir um aplicativo → Node.js, em **Privada**). |
| "PPSSPP não encontrado no PC" | Instale o PPSSPP, coloque a versão portátil em `ppsspp\` ou defina `PPSSPP_EXE` (passo 2). |
| "Já existe um PPSSPP aberto no PC" | Feche o PPSSPP que está aberto e escolha o jogo de novo. |
| "O depurador do PPSSPP não respondeu" | Outro programa está usando a porta 45999, ou outro PPSSPP já está aberto. Feche o PPSSPP e tente de novo, ou defina `set PPSSPP_DEBUG_PORT=46010` antes de iniciar. |
| A imagem aparece com outra janela por cima, ou cortada | Use **Menu → Reposicionar janela no PC**. Não deixe nada na frente do PPSSPP. |
| A imagem fica preta | Confira se o PPSSPP não está minimizado nem em tela cheia. Se continuar, troque o backend gráfico do PPSSPP (Configurações → Gráficos → Backend) para Direct3D 11 ou OpenGL. |
| Os botões não respondem | Aperte um botão do Joy-Con com a página aberta, para o navegador detectar o controle. Se continuar, use Menu → **Configurar botões**. |
| O personagem anda para o lado errado com o analógico | Use o direcional e avise no repositório: alguns jogos tratam o eixo de outro jeito. |
| A imagem trava ou atrasa | No menu, use **Qualidade: baixa**. Prefira Wi-Fi de 5 GHz perto do roteador, ou ligue o PC por cabo. |
| Salvar estado não faz nada | Nas versões estáveis do PPSSPP, o servidor usa as teclas F2 e F4. Confira se elas continuam com os atalhos padrão em Configurações → Controles → Mapeamento. |
| Não tem som | É uma limitação do navegador do Switch. O som toca no PC. |
| `start.bat` diz que o Node.js não foi encontrado | Instale o Node.js LTS, feche e abra o `start.bat` de novo. |
| Falha ao instalar as dependências | Verifique a internet. Depois apague a pasta `node_modules`, se ela existir, e rode o `start.bat` de novo. |

## Segurança

- O servidor não tem senha. Qualquer aparelho da sua rede local consegue abrir a biblioteca.
- **Não** encaminhe a porta `8889` no roteador nem exponha o servidor na internet.
- Bloqueie o PPSSPP no firewall (passo 4). O depurador dele aceita comandos de quem alcançar a porta 45999.
- Para usar outra porta, rode `set PORT=9000` antes de iniciar o servidor.
