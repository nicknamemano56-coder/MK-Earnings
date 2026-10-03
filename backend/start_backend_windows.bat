@echo off
cd /d "%~dp0"
if "%ADMIN_KEY%"=="" set ADMIN_KEY=CHANGE_ME_ADMIN_KEY
set PORT=8787
node server.js
pause
