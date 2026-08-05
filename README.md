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

Exocortex is installed from its canonical source repository on every platform.
Keep the clone after installation: the Linux commands are symlinked into it, and
macOS runs directly from it.

### Arch Linux

#### Prerequisites

Install Git, Make, and the optional native-call audio dependencies:

```bash
sudo pacman -S --needed git make nodejs libpulse
```

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

Open a new shell, or source the shell profile printed by Bun's installer, before
continuing. Arch already includes the systemd user-service support used by
Exocortex.

#### Install

```bash
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
make install
```

`make install`:

1. Installs the locked Bun dependencies.
2. Symlinks `exocortexd` and `exocortex` into `~/.local/bin`.
3. Installs, enables, and starts `exocortex-daemon.service` as a systemd user
   service.

Make sure `~/.local/bin` is on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to `~/.bashrc` or `~/.zshrc` if necessary.

#### Authenticate and launch

```bash
exocortexd login
exocortex
```

Browser OAuth is the default. On a remote or headless machine, use OpenAI's
code flow:

```bash
exocortexd login openai code
```

Check or restart the daemon with:

```bash
exocortexd status
exocortexd restart
```

#### Update

```bash
cd Exocortex
git pull --ff-only
bun install --frozen-lockfile
exocortexd restart
```

#### Uninstall

```bash
cd Exocortex
make uninstall
```

This stops and removes the systemd user service and removes the two command
symlinks. It does not delete the source clone or user data.

---

### macOS

The current macOS path runs the daemon and TUI directly from the source clone.
The Linux `make install` target is intentionally not used because it installs a
systemd service.

#### Prerequisites

Install Apple's command-line tools, which provide Git:

```bash
xcode-select --install
```

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

Open a new shell, or source the shell profile printed by Bun's installer. Voice
input and native TUI call audio additionally require Node.js and FFmpeg; with
Homebrew:

```bash
brew install node ffmpeg
```

Text and image clipboard integration uses macOS's built-in `pbcopy`, `pbpaste`,
and `osascript` commands.

#### Install

```bash
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
bun install --frozen-lockfile
```

#### Authenticate

From the source clone:

```bash
cd daemon
bun run src/main.ts login
```

For code-based OpenAI login on a headless Mac or remote shell:

```bash
bun run src/main.ts login openai code
```

#### Launch

Keep the daemon running in one terminal:

```bash
cd Exocortex/daemon
bun run src/main.ts
```

Launch the TUI from a second terminal:

```bash
cd Exocortex/tui
bun run src/main.ts
```

Press `Ctrl+C` in the daemon terminal to stop it.

#### Update

Stop the foreground daemon, then update the source and dependencies:

```bash
cd Exocortex
git pull --ff-only
bun install --frozen-lockfile
```

Start the daemon and TUI again using the commands above.

---

### Windows

The Windows installer builds Exocortex from the canonical source repository. It
does not download prebuilt Exocortex release artifacts.

#### Prerequisites

Install Git from [git-scm.com](https://git-scm.com/download/win), or with
`winget`:

```powershell
winget install Git.Git
```

The Exocortex installer installs Bun from Bun's official installer when Bun is
not already available.

#### Install

Clone the repository, then double-click `scripts\install-windows.cmd`. To run
the same installer from a terminal:

```powershell
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
.\scripts\install-windows.cmd
```

The installer builds the daemon, TUI, and external `exo` CLI into `dist\`,
copies `exocortexd.exe`, `exocortex.exe`, `exo.exe`, and `exocortex.bat` to
`%USERPROFILE%\.local\bin`, and adds that directory to the user `PATH`. Open a
new terminal after the first install.

To install elsewhere or leave `PATH` unchanged:

```powershell
.\scripts\install-windows.cmd -InstallDir C:\Exocortex -NoPathUpdate
```

#### Authenticate and launch

```powershell
exocortexd login
exocortex.bat
```

For code-based OpenAI login:

```powershell
exocortexd login openai code
```

`exocortex.bat` starts the daemon in the background, opens the TUI, and stops
the daemon when the TUI closes. No Windows service is installed.

#### Update

```powershell
cd Exocortex
git pull --ff-only
.\scripts\install-windows.cmd
```

#### Cross-build from Linux or WSL

```bash
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
bun install --frozen-lockfile
make windows
```

Both native and cross-build methods produce standalone Windows executables in
`dist/`:

- `exocortexd.exe` — the daemon
- `exocortex.exe` — the TUI client
- `exo.exe` — the external debugging and automation CLI
- `exocortex.bat` — the launcher

---

## `exo` tool and CLI

The daemon provides a native `exo` tool for current-instance conversation and
subagent orchestration. The separate `exo` executable is an external debugging
and automation client, especially useful for targeting other daemon instances.
The Windows installer includes `exo.exe`; the Arch `make install` target and the
manual macOS steps do not install the separate CLI.
