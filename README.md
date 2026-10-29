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

### Quick install (Linux and macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/Yeyito777/Exocortex/main/install.sh | bash -s -- --tui
```

`install.sh` installs what is missing and sets everything up; rerun it to
update. It:

1. Checks for Git and curl (and unzip on Linux) and prints the package-manager
   command if one is missing; it never runs `sudo`.
2. Installs Bun and Claude Code with their official installers if they are not
   found (Claude Code runs the Claude models, on your Claude subscription).
3. Clones the source into `~/.local/share/exocortex`, or fast-forwards an
   existing install (a clean checkout on its branch; local changes are left
   alone), and runs `bun install --frozen-lockfile`.
4. Links `exocortexd` (and the `exocortex` TUI with `--tui`) into
   `~/.local/bin` and adds it and Bun to your shell's PATH.
5. Installs and starts the daemon service: `exocortex-daemon.service` (systemd
   user service) on Linux, the `com.exocortex.daemon` LaunchAgent through the
   signed launcher app on macOS (see [below](#run-the-daemon-in-the-background-launchagent);
   without Xcode's command-line tools, a plain LaunchAgent). A rerun that
   pulled new code restarts the daemon gracefully.
6. Offers to sign in to Claude and OpenAI, then prints `exocortexd doctor`.

| Option | |
| --- | --- |
| `--tui` | Also install the terminal UI (`exocortex`) |
| `--dir PATH` | Where the source and its data live (default: the existing install, else `~/.local/share/exocortex`) |
| `--branch NAME` | Branch to install or switch to |
| `--no-service` | No background service; run `exocortexd` yourself |
| `--no-login` | Skip the sign-ins |
| `--no-claude-code` | Do not install Claude Code |
| `--yes` | Do not ask; take the defaults |
| `--uninstall` | Remove the service and commands (keeps the source and data) |

From a clone, `./install.sh` installs that clone. To add the TUI later, rerun
with `--tui` or run `exocortexd install-tui`. `exocortexd doctor` shows what is
installed, running and signed in.

### Use Exocortex from your own program

Programs drive the daemon over its local socket; the protocol is in
[docs/app-api.md](docs/app-api.md). An app needs the daemon installed and
signed in once:

```bash
curl -fsSL https://raw.githubusercontent.com/Yeyito777/Exocortex/main/install.sh | bash
exocortexd doctor
```

- `exocortexd doctor --json` reports Bun, Claude Code and its sign-in, whether
  the daemon is running, provider logins and whether the TUI is installed.
  `ok` is true when the daemon answers and a provider is signed in; `problems`
  lists each missing piece with the command that fixes it. It exits 0 whenever
  it printed a report (the text form exits 1 when something is wrong).
- `exocortexd socket` prints the socket to connect to: `$EXOCORTEX_SOCKET` if
  set (Exocortex sets it in every shell it starts), else the install's own.
- An app that finds no `exocortexd` or a failing doctor should show the user
  the one-line install above; it should never run the installer itself.

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
key lists), and the usage bars become the key's spend today and this month: a
published-rate estimate counted from the responses this daemon received,
sent to every TUI as each one is counted. Requests without a per-token rate
(audio priced per minute, images) are counted but not priced; `/tokens` says
how many. OpenAI's own balance can't be read with a project key, so these are
always estimates.

When the key is funded by a prepaid credit grant, set
`providers.openai.credit` in `config/config.json`:

```json
{ "providers": { "openai": { "credit": { "amountUsd": 1000, "since": "2026-10-20", "expires": "2027-10-20" } } } }
```

The usage slot then shows the same Credit and Expiry rows as Claude on API
credits: `Credit: [bar] ≈$936 / $1000` (the bar is the share left; the
balance turns red under 10% left; always `≈`, since it is counted here) over
`Expiry: $936 356d`, with `API credits` over `today $0.84 of $2.73` on the
right: today's spend against the pace that makes the credit last until
`expires` (this morning's balance over the days left, today included), red
once over it. Without `expires`, or once it has passed, today is its plain
spend. `/tokens` adds what the bar leaves out: the runway at the
last 7 days' pace and, when the daemon started counting after `since`, the
first counted day (the balance is then an upper bound). Without a credit grant,
`providers.openai.monthlyBudgetUsd` (e.g. `20`) draws bars instead: the month
against the budget, today against what was left of it that morning spread
over the days left in the month (just today's spend once the month is over).

Check or restart the daemon with:

```bash
exocortexd status
exocortexd restart
```

`exocortexd stop` is the only way to stop it without resuming anything. Every
other exit (`exocortexd restart`, a direct `systemctl --user stop` or
`launchctl kill`, a reboot, a stray `kill`, a crash, even SIGKILL or power
loss) replays the turns it interrupted when the daemon next starts; under
systemd and launchd it comes back on its own unless it was stopped through the
service manager or the machine is shutting down.

On a machine with neither systemd nor launchd, a supervisor of your own can
take their place: set `EXOCORTEX_SUPERVISOR` (in the daemon's environment and
in shells that run `exocortexd`) to an executable that takes
`start|stop|restart|status|main-pid`. `exocortexd start|stop|restart|status`
then call it, and the `exo` tool's restart runs its executor in a detached
session and restarts through it when the supervisor's `main-pid` is this
daemon. `stop` must keep the daemon stopped until `start`; any other exit,
including a plain SIGTERM, is a restart (the interrupted turns replay).
The OSS Phone's keeper is one
([OSS-Phone-V1 docs/EXOCORTEX.md](https://github.com/Yeyito777/OSS-Phone-V1/blob/main/docs/EXOCORTEX.md)).

Inside the TUI, `/ssh <alias>` connects directly to that host's Exocortex
daemon through `exocortexd proxy`; `/ssh cancel` returns to the local daemon.
The selected route belongs to that TUI process, so other TUIs can remain local
or connect to different aliases at the same time.

Hold-to-talk transcription on an SSH route prefers the local daemon, falling
back to the remote daemon if local transcription is unavailable. Prompt editing,
pending-message recall, and optimistic queuing still work normally; final text
goes to the selected conversation daemon. Voice jobs survive SSH reconnects.

The model's `client_bash` tool runs commands on the user's own machine rather
than on the daemon's host. It reaches that machine through the machine's own
Exocortex daemon when that daemon is linked to this one with `/proxy` (so it
works while no TUI is open), else through a TUI connected over `/ssh`. Either
runs each command in its own process group and stops it on timeout, interrupt,
or when the connection ends. Both acknowledge commands and report them alive,
so a frozen TUI or a sleeping machine fails a call in about 15 seconds rather
than after its timeout. Subagents get it like their parents.

Several machines can be connected at once (a laptop and a phone, say), so each
has a short client ID: `mac` for a Mac, `windows` for Windows, otherwise its
hostname (`toronto`), numbered when taken (`mac-2`) and kept across restarts.
Each install (TUI and daemon of one checkout) announces a random install ID,
kept in its `config/data/client-install-id`, so two devices that are both
`root@localhost` are two machines; clients from before install IDs are told
apart by `user@hostname` only. Name a machine yourself in `config/config.json`
by its `user@hostname` (every machine announcing it: the second gets `-2`) or
by its install ID (that one alone):

```json
"clientHosts": { "names": { "root@localhost": "phone", "8f3a2c1b9d4e7a60": "tablet" } }
```

A `client_bash` call names its machine with `host`. It may leave `host` out only
while a single machine is connected and the conversation was told that one is
the only one; otherwise it fails, listing the connected machines, and never
runs anywhere it did not name. Conversations get a short notice listing the
connected machines by ID whenever that changes, and saying which one the user
last wrote from (subagents: the one the user last wrote to their parent from).

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

If `git pull` says the untracked `bun.lock` would be overwritten (a clone from
before the lockfile was tracked), delete it (`rm bun.lock`) and pull again.

#### Uninstall

```bash
cd Exocortex
make uninstall          # same as: ./install.sh --uninstall
```

This stops and removes the service (the systemd user service, or on macOS the
LaunchAgent and launcher app) and removes the two command symlinks. It does not
delete the source clone or user data.

---

### macOS

The [quick install](#quick-install-linux-and-macos) sets up everything below,
LaunchAgent included. The manual path runs the daemon and TUI directly from the
source clone. The Linux `make install` target is intentionally not used because
it installs a systemd service.

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

**One-time Full Disk Access.** macOS asks separately for each protected place
(Desktop, Documents, Downloads, other apps' data, removable and network
volumes), so allowing prompts one at a time keeps producing new ones. Full Disk
Access for “Exocortex Daemon” covers them all, once. `build-launcher.sh` and
`install.sh` check it without prompting (`scripts/macos/full-disk-access.sh
check` prints `granted`, `missing` or `unknown`) and, when it is missing, open
**System Settings › Privacy & Security › Full Disk Access**: switch on
**Exocortex Daemon** (if it is not listed, `+`, then
`~/Applications/Exocortex Daemon.app`), then `exocortexd restart`. Run
`scripts/macos/full-disk-access.sh setup` to do this step alone, and
`exocortexd doctor` warns while it is missing. Do it before the first reload if
the clone lives in Desktop or Documents. The grant belongs to the app's signing
identity, so it survives restarts, pulls, rebuilds and Homebrew/Bun upgrades.

**Other background jobs.** A LaunchAgent whose program is bash, bun or another
tool is that tool's own responsible process: macOS asks for it separately, and
again whenever Homebrew updates it. To share the app's grant, make the job's
program `~/Applications/Exocortex Daemon.app/Contents/MacOS/exocortex-daemon
--exec PROGRAM ARGS…` (it forwards signals and exits with the job's status).
The daemon's model-requested restarts run this way.

**Rebuild** after pulling launcher changes, or to re-sign with a new
certificate, by re-running `scripts/macos/build-launcher.sh --reload`. It is
idempotent and keeps your LaunchAgent's other settings (a backup of the previous
plist goes to `config/runtime/launchd/backups/`). Homebrew or Bun upgrades need
no rebuild. Without an Apple Development or Developer ID certificate it stops:
an ad-hoc signed app loses its grants on every rebuild. Pass `--adhoc` to sign
ad-hoc anyway (`install.sh` does, with a warning, when there is no
certificate). `install.sh` runs it with `--if-changed`, which keeps the
installed app unless the launcher sources or signing identity changed.

#### Update

Stop the foreground daemon, then update the source and dependencies:

```bash
cd Exocortex
git pull --ff-only
bun install --frozen-lockfile
```

If `git pull` says the untracked `bun.lock` would be overwritten (a clone from
before the lockfile was tracked), delete it (`rm bun.lock`) and pull again.

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
`Opus-5.5 | 87.9 tokens/s | 1m 12s`. It starts at 0 when the conversation goes
from idle to working, whatever starts it (your message, a wake, a notification),
and runs on through messages that join the running work (steered or queued ones,
goal continuations) and daemon restarts. Time asleep in a long Chrono sleep is
not counted: work after the sleep starts again at 0. When the message finishes, the finish
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

## Development

Run the whole pre-merge check from the repository root:

```bash
bun run check            # typecheck shared, daemon and tui; run all test suites
bun run check daemon     # or only some steps: typecheck, shared, daemon, tui
```

It runs everything at once and the test files in parallel, in about 12 seconds.
`cd daemon && bun test` (or `tui`, `shared`) still runs one suite on its own.
How tests are isolated, and the rules that keep them fast:
[docs/testing.md](docs/testing.md).
