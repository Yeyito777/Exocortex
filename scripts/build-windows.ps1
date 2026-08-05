[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DistDir = Join-Path $RepoRoot "dist"

$BunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue
if ($BunCommand) {
    $Bun = $BunCommand.Source
} else {
    $Bun = Join-Path $HOME ".bun\bin\bun.exe"
    if (-not (Test-Path $Bun)) {
        Write-Host "Bun was not found. Installing Bun from https://bun.sh ..."
        try {
            $InstallScript = Invoke-RestMethod -Uri "https://bun.sh/install.ps1"
            Invoke-Expression $InstallScript
        } catch {
            throw "Bun was not found and automatic installation failed: $($_.Exception.Message)"
        }

        if (-not (Test-Path $Bun)) {
            throw "The Bun installer completed, but $Bun was not created."
        }

        $BunBin = Split-Path -Parent $Bun
        $PathSegments = @($env:Path -split ";" | Where-Object { $_ })
        if (-not ($PathSegments | Where-Object { $_.TrimEnd("\") -ieq $BunBin.TrimEnd("\") })) {
            $env:Path = "$BunBin;$env:Path"
        }

        Write-Host "Bun installed successfully."
    }
}

function Invoke-Bun {
    & $Bun @args
    if ($LASTEXITCODE -ne 0) {
        throw "bun exited with code $LASTEXITCODE"
    }
}

Push-Location $RepoRoot
try {
    Write-Host "Installing dependencies..."
    Invoke-Bun install --frozen-lockfile

    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

    Write-Host "Building exocortexd.exe..."
    Invoke-Bun build --compile --target=bun-windows-x64 daemon/src/windows-entry.ts --outfile (Join-Path $DistDir "exocortexd.exe")

    Write-Host "Building exocortex.exe..."
    Invoke-Bun build --compile --target=bun-windows-x64 tui/src/main.ts --outfile (Join-Path $DistDir "exocortex.exe")

    $ExoCliDir = Join-Path $RepoRoot "external-tools\exo-cli"
    if (-not (Test-Path (Join-Path $ExoCliDir "src\main.ts"))) {
        $GitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
        if (-not $GitCommand) { throw "git is required to clone the exo CLI source" }
        Write-Host "Cloning exo CLI source..."
        & $GitCommand.Source clone https://github.com/Yeyito777/exo-cli.git $ExoCliDir
        if ($LASTEXITCODE -ne 0) { throw "git clone exo-cli failed with code $LASTEXITCODE" }
    }

    Write-Host "Building exo.exe..."
    Invoke-Bun build --compile --target=bun-windows-x64 external-tools/exo-cli/src/main.ts --outfile (Join-Path $DistDir "exo.exe")

    Copy-Item (Join-Path $RepoRoot "scripts\exocortex.bat") (Join-Path $DistDir "exocortex.bat") -Force

    Write-Host ""
    Write-Host "Windows build complete:"
    Get-ChildItem $DistDir | Select-Object Name, Length
} finally {
    Pop-Location
}
