@echo off
set "LIVE_VOICE_LAUNCH_DIR=%~dp0"
powershell.exe -NoProfile -Command "& (Join-Path $env:LIVE_VOICE_LAUNCH_DIR 'launch.ps1')"
if errorlevel 1 pause
