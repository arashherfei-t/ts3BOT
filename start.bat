@echo off
chcp 65001 >nul
title CMT TeamSpeak Bot
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>&1 || set "NODE_EXE=C:\Program Files\nodejs\node.exe"

tasklist /fi "imagename eq ts3client_win64.exe" 2>nul | find /i "ts3client_win64.exe" >nul
if errorlevel 1 (
  echo.
  echo  WARNING: the TeamSpeak 3 client does not appear to be running.
  echo  The bot drives that client, so start it first and leave it open.
  echo.
)

:run
echo.
echo === starting CMT bot ===
"%NODE_EXE%" bot.js
echo.
echo === bot stopped (exit code %errorlevel%) - restarting in 15s, close this window to stop ===
timeout /t 15 /nobreak >nul
goto run
