@echo off
title Leggio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js non risulta installato.
  echo  Scaricalo gratis da https://nodejs.org ^(versione LTS^) poi riavvia questo file.
  echo.
  pause
  exit /b
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 (
  echo.
  echo  Node.js e' troppo vecchio: serve la versione 20.19 o successiva ^(consigliata: l'ultima LTS^). Aggiornalo da https://nodejs.org
  echo.
  pause
  exit /b
)
node -e "require('express');require('imapflow');require('mailparser');require('html-to-text')" >nul 2>nul
if errorlevel 1 (
  echo  Installo o riparo i componenti, attendi un minuto...
  call npm install --omit=dev --no-audit --no-fund
)
rem Cartella dati di QUESTA istanza: separata da qualsiasi altro Leggio sul PC.
if not defined LEGGIO_DATA_DIR set "LEGGIO_DATA_DIR=%APPDATA%\Leggio-Personale"
set OPEN_BROWSER=1
echo  Avvio di Leggio... la console si aprira' nel browser.
echo  (Per spegnere Leggio, chiudi questa finestra.)
node server.js
if errorlevel 1 (
  echo.
  echo  Leggio si e' fermato con un errore: leggi il messaggio qui sopra.
  pause
)
