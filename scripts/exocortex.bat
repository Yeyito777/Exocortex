@echo off
:: Exocortex launcher for Windows.
:: Starts the daemon in the background, launches the TUI,
:: and kills the daemon when the TUI exits.

:: Change to the directory where this .bat lives
pushd "%~dp0"

:: Start the daemon hidden (no console window)
start "" /B exocortexd.exe >nul 2>&1

:: Give the daemon a moment to start listening
timeout /t 2 /nobreak >nul

:: Run the TUI in this console (blocks until user quits)
exocortex.exe

:: TUI exited — kill the daemon
taskkill /F /IM exocortexd.exe >nul 2>&1

popd
