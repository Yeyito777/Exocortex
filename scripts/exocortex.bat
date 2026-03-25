@echo off
rem Exocortex launcher for Windows.
rem Starts the daemon in the background, launches the TUI,
rem and kills the daemon when the TUI exits.

pushd "%~dp0"

start "" /B exocortexd.exe >nul 2>&1

timeout /t 2 /nobreak >nul

exocortex.exe

taskkill /F /IM exocortexd.exe >nul 2>&1

popd
