@echo off
rem Builds PPSSPP with this project's patch (ppsspp-patch\webstream.patch):
rem  - the libretro core lib\ppsspp_libretro.dll and the Node addon in native\,
rem    which run PPSSPP inside the server process (the default);
rem  - the standalone ppsspp\PPSSPPWindows64.exe, used when the addon is missing.
rem Needs Git, Node.js and Visual Studio 2022 or newer with "Desktop development with C++".
setlocal
cd /d "%~dp0"
set PPSSPP_TAG=v1.20.4

where git >nul 2>nul
if errorlevel 1 (
  echo O Git nao foi encontrado. Instale em https://git-scm.com e tente de novo.
  pause
  exit /b 1
)

set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if not exist "%VSWHERE%" (
  echo O Visual Studio nao foi encontrado. Instale o Visual Studio Community com "Desenvolvimento para desktop com C++".
  pause
  exit /b 1
)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find MSBuild\**\Bin\MSBuild.exe`) do set MSBUILD=%%i
if not defined MSBUILD (
  echo O Visual Studio nao tem as ferramentas de C++. Instale "Desenvolvimento para desktop com C++".
  pause
  exit /b 1
)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -prerelease -products * -find Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`) do set CMAKE=%%i
if not defined CMAKE set CMAKE=cmake

if not exist ppsspp-src\.git (
  echo Baixando o codigo do PPSSPP %PPSSPP_TAG%...
  git clone --depth 1 --branch %PPSSPP_TAG% --recurse-submodules --shallow-submodules -j8 https://github.com/hrydgard/ppsspp.git ppsspp-src
  if errorlevel 1 goto failed
)

pushd ppsspp-src
git apply --check ..\ppsspp-patch\webstream.patch >nul 2>nul
if not errorlevel 1 (
  echo Aplicando o patch de streaming...
  git apply ..\ppsspp-patch\webstream.patch
) else (
  git apply --reverse --check ..\ppsspp-patch\webstream.patch >nul 2>nul
  if errorlevel 1 (
    popd
    echo O patch nao se aplica a este codigo. Apague a pasta ppsspp-src e rode de novo.
    goto failed
  )
  echo O patch ja estava aplicado.
)

echo Compilando o nucleo libretro, isso leva de 20 a 60 minutos...
rem NOMINMAX: the Visual Studio projects define it, the CMake build doesn't.
"%CMAKE%" -S . -B build-libretro -A x64 -DLIBRETRO=ON "-DCMAKE_CXX_FLAGS=/DWIN32 /D_WINDOWS /GR /EHsc /DNOMINMAX"
if errorlevel 1 (
  popd
  goto failed
)
"%CMAKE%" --build build-libretro --config Release --target ppsspp_libretro --parallel
if errorlevel 1 (
  popd
  goto failed
)

echo Compilando o PPSSPP separado...
"%MSBUILD%" Windows\PPSSPP.sln -t:PPSSPPWindows -m -p:Configuration=Release -p:Platform=x64 -v:minimal -nologo
if errorlevel 1 (
  popd
  goto failed
)
popd

echo Instalando o nucleo em lib\...
if not exist lib mkdir lib
copy /y ppsspp-src\build-libretro\Release\ppsspp_libretro.dll lib\ >nul
robocopy ppsspp-src\assets lib\system\PPSSPP /mir /njh /njs /nfl /ndl >nul

echo Compilando o addon do Node...
call npm run build:native
if errorlevel 1 goto failed

echo Instalando em ppsspp\...
if not exist ppsspp mkdir ppsspp
copy /y ppsspp-src\PPSSPPWindows64.exe ppsspp\ >nul
robocopy ppsspp-src\assets ppsspp\assets /mir /njh /njs /nfl /ndl >nul
echo Pronto. O servidor roda o PPSSPP dentro do Node automaticamente.
pause
exit /b 0

:failed
echo Falha ao montar o PPSSPP modificado.
pause
exit /b 1
