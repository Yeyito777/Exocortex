# Exocortex

A daemon-driven AI assistant with a clean client/server architecture.

---

## MESSAGE FOR HUMANS:
**Don't read the rest of this file**. You only need to know the three following things:

1. The easiest way to install Exocortex is to tell your AI agent:
```
Please install https://github.com/Yeyito777/Exocortex.git
```

2. Exocortex is fully vim-keyed, the easiest way to learn how to use it is to point your agent at the code and ask it how it works.

3. Chances are you won't like Exocortex out-of-the-box, and there may be things that straight up don't work for you. This is because I built it for me. The easiest way to fix this, is to ask AI to do it for you. There are many systems I've built into it that makes this process particularly easy, have fun discovering them.

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
2. Symlink `exocortexd` and `exocortex` into `~/.local/bin/`
3. Install and start a systemd user service for the daemon

The daemon exposes current-instance conversation and subagent orchestration through its native `exo` tool. Lower-frequency operations such as folder management and one-shot LLM calls live in an on-demand command registry (`action=commands`, `command=ls`) so they do not bloat every model request. The separate `exo` CLI remains an external debugging/automation client—especially for targeting other daemon instances—and is not installed by this repository's `make install` target.

> **Note:** Make sure `~/.local/bin` is in your `PATH`.
> Add this to your `~/.bashrc` or `~/.zshrc` if it isn't:
> ```bash
> export PATH="$HOME/.local/bin:$PATH"
> ```

#### Authenticate

Run the one-time login to connect a model provider account:

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

If you want to build the daemon and TUI from a specific commit:

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
- `exocortex.bat` — launcher script

Copy the contents of `dist/` wherever you like and follow the same authenticate & launch steps from above.
