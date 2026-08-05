[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $HOME ".local\bin"),
    [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"
$WindowsDir = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $WindowsDir)

& (Join-Path $PSScriptRoot "build.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "Windows build failed with code $LASTEXITCODE"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($name in @("exocortexd.exe", "exocortex.exe", "exo.exe", "exocortex.bat")) {
    Copy-Item (Join-Path $RepoRoot "dist\$name") (Join-Path $InstallDir $name) -Force
}

if (-not $NoPathUpdate) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Segments = @($UserPath -split ";" | Where-Object { $_ })
    if (-not ($Segments | Where-Object { $_.TrimEnd("\") -ieq $InstallDir.TrimEnd("\") })) {
        $NewUserPath = if ($UserPath) { "$InstallDir;$UserPath" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
        Write-Host "Added $InstallDir to the user PATH. Open a new terminal to use it."
    }
}

Write-Host ""
Write-Host "Exocortex installed in $InstallDir"
Write-Host "Commands: exocortexd, exocortex, exo"
Write-Host "Next: exocortexd login"
