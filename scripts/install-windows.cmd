@echo off
setlocal

rem Double-clickable launcher for the native Windows source installer.
rem Set EXOCORTEX_INSTALL_NO_PAUSE=1 when invoking this from CI or automation.

pushd "%~dp0.." >nul
if errorlevel 1 (
    echo Exocortex installation failed: could not enter the repository directory.
    set "INSTALL_EXIT=1"
    goto :finish
)

echo Installing Exocortex from %CD%
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
set "INSTALL_EXIT=%ERRORLEVEL%"
popd

:finish
echo.
if "%INSTALL_EXIT%"=="0" (
    echo Exocortex installation completed successfully.
) else (
    echo Exocortex installation failed with exit code %INSTALL_EXIT%.
)

if not defined EXOCORTEX_INSTALL_NO_PAUSE pause
endlocal & exit /b %INSTALL_EXIT%
