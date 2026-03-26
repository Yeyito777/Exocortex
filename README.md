# Exocortex

A daemon-driven AI assistant with a clean client/server architecture.

---

## Installation

### Arch Linux

#### Prerequisites

- **Git**
  ```bash
  sudo pacman -S git
  ```

- **Bun** (JavaScript runtime)
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
  Then restart your shell or run `source ~/.bashrc` so `bun` is on your `PATH`.

- **systemd** — comes with Arch by default.

#### Install

```bash
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
make install
```

This will:
1. Install dependencies (`bun install`)
2. Symlink `exocortexd`, `exocortex`, and `exo` into `~/.local/bin/`
3. Install and start a systemd user service for the daemon

> **Note:** Make sure `~/.local/bin` is in your `PATH`.
> Add this to your `~/.bashrc` or `~/.zshrc` if it isn't:
> ```bash
> export PATH="$HOME/.local/bin:$PATH"
> ```

#### Authenticate

Run the one-time login to connect your Anthropic account:

```bash
exocortexd login
```

#### Launch

```bash
exocortex
```

The daemon runs in the background via systemd. You can check its status with:

```bash
exocortexd status
```

#### Uninstall

```bash
cd Exocortex
make uninstall
```

This stops the systemd service and removes the symlinks from `~/.local/bin/`.

---

### Windows

#### Quick Setup

1. Download `exocortex-windows-x64.zip` from the [latest release](https://github.com/Yeyito777/Exocortex/releases/latest).

2. Extract the zip to a folder of your choice (e.g. `C:\Exocortex`).

3. Open a terminal in that folder and authenticate:
   ```powershell
   .\exocortexd.exe login
   ```

4. Launch by double-clicking `exocortex.bat`, or from a terminal:
   ```powershell
   .\exocortex.bat
   ```

The batch file starts the daemon in the background, opens the TUI, and automatically stops the daemon when you close it.

To uninstall, just delete the folder. No registry entries or services are created.

#### Power Users — Build from Source

If you want the full toolset (including the `exo` CLI) or want to build from a specific commit:

**Prerequisites:**
- **Git** — install from [git-scm.com](https://git-scm.com/download/win) or via `winget`:
  ```powershell
  winget install Git.Git
  ```
- **Bun** (JavaScript runtime)
  ```powershell
  powershell -c "irm bun.sh/install.ps1 | iex"
  ```

**Build** (from a Linux machine or WSL):

```bash
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
bun install
make windows
```

This cross-compiles standalone executables into `dist/`:
- `exocortexd.exe` — the daemon
- `exocortex.exe` — the TUI client
- `exo.exe` — the CLI client (not included in the release zip)
- `exocortex.bat` — launcher script

Copy the contents of `dist/` wherever you like and follow the same authenticate & launch steps from above.
