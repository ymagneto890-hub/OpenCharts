@echo off
setlocal
cd /d "%~dp0"
if exist "%SystemRoot%\System32\wscript.exe" (
  start "" "%SystemRoot%\System32\wscript.exe" //nologo "%~dp0iniciar_opencharts.vbs"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  msg "%username%" "No se encontro Node.js en el sistema. Instala Node.js desde https://nodejs.org para iniciar OpenCharts."
  exit /b 1
)
node "%~dp0scripts\launcher.mjs"
