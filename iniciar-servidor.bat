@echo off
chcp 65001 >nul
title Controle de Pneus - Servidor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ============================================================
  echo  O Node.js nao esta instalado neste computador.
  echo  Instale em https://nodejs.org ^(baixe a versao "LTS"^),
  echo  depois de instalado, de dois cliques neste arquivo de novo.
  echo ============================================================
  echo.
  pause
  exit /b 1
)

node server.js

echo.
echo O servidor foi encerrado.
pause
