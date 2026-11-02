@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao foi encontrado.
  echo Instale a versao LTS em https://nodejs.org e execute este arquivo de novo.
  pause
  exit /b 1
)
if not exist node_modules\ffmpeg-static\ffmpeg.exe (
  echo Instalando dependencias do servidor...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Falha ao instalar as dependencias. Verifique a conexao com a internet.
    pause
    exit /b 1
  )
)
node src\server.js --open
pause
