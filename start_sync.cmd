@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_project.ps1" -Action Start
pause
