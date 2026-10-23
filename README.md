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

Install Git and Make:

```bash
sudo pacman -S --needed git make
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
3. Adds the Exocortex and Bun binary directories to the login shell's startup
   file (`~/.zshenv` for zsh or `~/.bashrc` for bash). This also makes
   `exocortexd proxy` available to non-interactive SSH commands.
4. Installs, enables, and starts `exocortex-daemon.service` as a systemd user
   service.

Open a new shell after installation so the updated `PATH` is loaded.

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

To bill the OpenAI API instead of a ChatGPT plan, log in with an API key
(piped on stdin, never as an argument). Requests then go to api.openai.com and
only the models the key can use are offered:

```bash
exocortexd login openai key < openai-key.txt
```

In the TUI, `/login openai key <api-key>` does the same. The most recent login
wins; `/login openai` switches back to the ChatGPT account, and `/login` shows
which one is in use. On the key, the `transcribe` and `image` tools and voice
input use the public API too (the best transcription and GPT Image models the
key lists), and the usage bars become the key's spend: tokens and a
published-rate estimate per day and month, counted from the responses this
daemon received.

Check or restart the daemon with:

```bash
exocortexd status
exocortexd restart
```

Inside the TUI, `/ssh <alias>` connects directly to that host's Exocortex
daemon through `exocortexd proxy`; `/ssh cancel` returns to the local daemon.
The selected route belongs to that TUI process, so other TUIs can remain local
or connect to different aliases at the same time.

Hold-to-talk transcription on an SSH route prefers the local daemon, falling
back to the remote daemon if local transcription is unavailable. Prompt editing,
pending-message recall, and optimistic queuing still work normally; final text
goes to the selected conversation daemon. Voice jobs survive SSH reconnects.

While a TUI is connected over `/ssh`, the model's `client_bash` tool runs
commands on the machine that TUI runs on, rather than on the daemon's host.
The TUI runs them in their own process group and stops them on timeout,
interrupt, or when its SSH connection ends. Conversations get a short notice
when that machine connects or disconnects.

To select the SSH route as soon as the TUI launches, pass the same alias on the
command line:

```bash
exocortex --ssh <alias>
```

`/proxy <openai|anthropic> <alias>` is narrower: conversations, tools and files
stay on this machine, and only that provider's model requests go through the
other machine's daemon, which adds its own login. See
[docs/provider-proxy.md](docs/provider-proxy.md).

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
input additionally requires FFmpeg; with Homebrew:

```bash
brew install ffmpeg
```

Text and image clipboard integration uses macOS's built-in `pbcopy`, `pbpaste`,
and `osascript` commands.

HEIC/HEIF photos are converted locally to JPEG before being sent to a model.
This requires ImageMagick with HEIC/libheif support (`brew install imagemagick libheif`
on macOS). Native HEIC clipboard data and single copied HEIC files from Finder
or Linux file managers are preferred over PNG file icons. Terminal/SSH clipboard
pasting supports HEIC when the terminal offers the actual HEIC image bytes;
a PNG containing only a file icon cannot be recovered into the original photo.

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

#### Run the daemon in the background (LaunchAgent)

To keep the daemon running across logins, run it as the `com.exocortex.daemon`
LaunchAgent through the signed launcher app:

```bash
cd Exocortex
scripts/macos/build-launcher.sh            # build, sign, install the app; write/update the LaunchAgent
scripts/macos/build-launcher.sh --reload   # same, then (re)load the LaunchAgent now
```

`--reload` also fast-forwards each `external-tools/*` repo (they are separate
git repos, so `git pull` never updates them) via
`scripts/macos/update-external-tools.sh`. It only pulls a repo that is on its
default branch, clean and strictly behind; dirty, ahead, diverged, off-branch or
upstream-less repos are skipped with a warning, nothing is stashed or reset, and
a changed `requirements.txt`/`requirements.lock`/`bun.lock` re-runs that tool's
install. Pass `--no-tools-update` to skip it.

Then manage it with `exocortexd start|stop|restart|status` (link it with
`ln -s "$PWD/bin/exocortexd" ~/.local/bin/exocortexd`).

**Why a launcher.** macOS attributes privacy access (files of other apps,
Desktop, Documents, …) to the *responsible process*: the program launchd
started. If that is `bin/exocortexd`, it is Homebrew's bash, which is ad-hoc
signed and changes on every `brew upgrade`, so macOS keeps asking “bash would
like to access data from other apps”. `~/Applications/Exocortex Daemon.app`
(`dev.yeyito.exocortex.daemon`) is a tiny native launcher signed with your
Apple Development identity. It stays the daemon's parent, so every process the
daemon spawns is attributed to it, and its identity survives rebuilds and
Homebrew/Bun upgrades. It resolves Bun each time it starts, forwards
stop/restart signals, and exits with the daemon's status, so `exocortexd` and
launchd's restart behaviour are unchanged.

**One-time consent.** The first time a prompt names “Exocortex Daemon”, choose
**Allow**; it now sticks. To never be asked, add the app under **System
Settings › Privacy & Security › Full Disk Access** (`+`, then
`~/Applications/Exocortex Daemon.app`); do this before the first reload if the
clone lives in Desktop or Documents.

**Rebuild** after pulling launcher changes, or to re-sign with a new
certificate, by re-running `scripts/macos/build-launcher.sh --reload`. It is
idempotent and keeps your LaunchAgent's other settings (a backup of the previous
plist goes to `config/runtime/launchd/backups/`). Homebrew or Bun upgrades need
no rebuild. Without an Apple Development or Developer ID certificate it signs
ad-hoc and warns: prompts will then return after each rebuild.

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

Clone the repository, then double-click
`scripts\windows\exocortex-install.cmd`. To run
the same installer from a terminal:

```powershell
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
.\scripts\windows\exocortex-install.cmd
```

The installer builds the daemon, TUI, and external `exo` CLI into `dist\`,
copies `exocortexd.exe`, `exocortex.exe`, `exo.exe`, and `exocortex.bat` to
`%USERPROFILE%\.local\bin`, and adds that directory to the user `PATH`. Open a
new terminal after the first install.

To install elsewhere or leave `PATH` unchanged:

```powershell
.\scripts\windows\exocortex-install.cmd -InstallDir C:\Exocortex -NoPathUpdate
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
.\scripts\windows\exocortex-install.cmd
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

## TUI AI metadata

AI metadata shows the model, average output `tokens/s`, and a time segment.
While the AI is working the segment is the live work timer counting up:
`Opus-5.5 | 87.9 tokens/s | 1m 12s`. When the message finishes, the finish
clock replaces the duration on that same render (`endedAt`, the instant the timer
stopped): `Opus-5.5 | 87.9 tokens/s | 2:03pm`, `... | yesterday 10:41pm`,
`... | Oct 19 9:12am` (year added for another year, `Oct 19 2025 9:12am`). The
duration stays in the stored metadata but is no longer rendered on finished
messages; messages with no `endedAt` (older conversations) keep showing it. With
`/diagnostics` on the token count follows: `... | 2:03pm | 1,234 tokens`. The clock
is 12-hour by default; `/clock 24h` switches to `14:03`, `yesterday 22:41`,
`Oct 19 09:12`, and `/clock 12h` switches back (bare `/clock` shows the current
value). The choice is a TUI-only preference saved as `tui.clock` in
`config/config.json` and repaints immediately. The clock is shown per rendered AI
message (a run of assistant fragments or goal turns shows the last one's end), in
the TUI machine's own zone (so over `/ssh` it is the Mac's time, not the
daemon's), relative to the TUI's local day, and repainted after local midnight.
The segment is one column of the line, so a narrow pane truncates the clock with
`…` exactly as it truncated the duration.

Each API round is sampled separately: provider-reported output tokens divided
by that request's time (time-to-first-token + generation). Tool execution,
compaction, retry backoff, and gaps between rounds are excluded. Retried rounds
are not sampled. These APIs do not expose reliable server-side generation-only
timing, so this is request throughput, not a raw decoding benchmark.

Each assistant message starts at `0.0 tokens/s` with an empty sample history.
The display uses normalized exponential weights (`alpha = 2/11`) over that
message's latest ten measured rounds, with a hard cutoff at ten. Previous
messages never contribute. Reconnecting preserves the current message's
samples, and during tools the rate stays fixed. Historical messages without
measured rates show `— tokens/s`; message/work elapsed time is never a fallback.

`/diagnostics` toggles raw output-token counts alongside this metadata.
`/diagnostics on` and `/diagnostics off` set it explicitly. This TUI-only
preference defaults to off and persists locally as `tui.diagnostics` in
`config/config.json`. Token accounting and `/tokens` remain unchanged.

## `exo` tool and CLI

The daemon provides a native `exo` tool for current-instance conversation and
subagent orchestration. The separate `exo` executable is an external debugging
and automation client, especially useful for targeting other daemon instances.
The Windows installer includes `exo.exe`; the Arch `make install` target and the
manual macOS steps do not install the separate CLI.
