#!/usr/bin/env bash
# Exocortex installer for Linux (systemd user service) and macOS (LaunchAgent).
#
#   curl -fsSL https://raw.githubusercontent.com/Yeyito777/Exocortex/main/install.sh | bash -s -- [options]
#   ./install.sh [options]            (from a clone: installs that clone)
#
# Installs what is missing (Bun, Claude Code), clones or fast-forwards the
# source, installs its dependencies, links `exocortexd` (and the `exocortex`
# TUI with --tui) into ~/.local/bin, sets PATH, installs the daemon service and
# walks the sign-ins. Rerunning it updates. Run with --help for the options.
set -euo pipefail

REPO_URL="${EXOCORTEX_REPO_URL:-https://github.com/Yeyito777/Exocortex.git}"
DEFAULT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/exocortex"
BIN_DIR="${EXOCORTEX_BIN_DIR:-$HOME/.local/bin}"
UNIT_NAME="exocortex-daemon.service"
LAUNCHD_LABEL="${EXOCORTEX_LAUNCHD_LABEL:-com.exocortex.daemon}"

DIR=""
BRANCH=""
WITH_TUI=0
NO_SERVICE=0
NO_LOGIN=0
NO_CLAUDE_CODE=0
ASSUME_YES=0
UNINSTALL=0

usage() {
  cat <<EOF
Usage: install.sh [options]

  --tui             Also install the terminal UI (the \`exocortex\` command)
  --dir PATH        Where the source and its data live
                    (default: an existing install, else $DEFAULT_DIR)
  --branch NAME     Branch to install or switch to (default: main, or the
                    existing checkout's branch)
  --no-service      Do not install or restart the background service
  --no-login        Skip the sign-in steps
  --no-claude-code  Do not install Claude Code (Claude models need it)
  --yes, -y         Do not ask; take the defaults
  --uninstall       Remove the service and commands (keeps the source and data)
  --repo URL        Clone from URL (default: $REPO_URL)
  -h, --help        Show this help
EOF
}

# ── Output ───────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  GREEN=$'\033[32m' RED=$'\033[31m' YELLOW=$'\033[33m' BOLD=$'\033[1m' RESET=$'\033[0m'
else
  GREEN="" RED="" YELLOW="" BOLD="" RESET=""
fi
step() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
note() { printf '  • %s\n' "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# Prompts read the terminal, not stdin: under `curl | bash` stdin is the script.
HAVE_TTY=0
if [[ -r /dev/tty ]] && (exec </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi

# ask "Question" y|n  → succeeds for yes. Without a terminal or with --yes, the default.
ask() {
  local question="$1" default="$2" reply hint="[y/N]"
  [[ "$default" == y ]] && hint="[Y/n]"
  if ((ASSUME_YES == 1 || HAVE_TTY == 0)); then
    [[ "$default" == y ]]
    return
  fi
  printf '  %s %s ' "$question" "$hint" >/dev/tty
  read -r reply </dev/tty || reply=""
  reply="${reply:-$default}"
  [[ "$reply" == [Yy]* ]]
}

# Inside an Exocortex shell the daemon is this script's ancestor: restarting or
# stopping it would cut off the turn running the installer.
inside_exocortex() { [[ -n "${EXOCORTEX_SOCKET:-}" ]]; }

LOG_DIR=""
cleanup() { [[ -n "$LOG_DIR" ]] && rm -rf "$LOG_DIR"; return 0; }
trap cleanup EXIT

# run_logged NAME CMD...: quiet on success, prints the output's tail on failure.
run_logged() {
  local name="$1"; shift
  if "$@" >"$LOG_DIR/$name.log" 2>&1; then return 0; fi
  tail -n 20 "$LOG_DIR/$name.log" | sed 's/^/    /' >&2
  return 1
}

# ── Platform and prerequisites ───────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  MINGW*|MSYS*|CYGWIN*) die "On Windows use scripts\\windows\\exocortex-install.cmd (see README)." ;;
  *) die "Unsupported system: $OS (Linux and macOS are supported)." ;;
esac

package_hint() {
  if [[ "$OS" == Darwin ]]; then
    command -v brew >/dev/null 2>&1 && { echo "brew install $*"; return; }
    echo "install: $*"
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get update && sudo apt-get install -y $*"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y $*"
  elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S --needed $*"
  elif command -v zypper >/dev/null 2>&1; then echo "sudo zypper install -y $*"
  elif command -v apk >/dev/null 2>&1; then echo "sudo apk add $*"
  else echo "install with your package manager: $*"
  fi
}

have_git() {
  # macOS ships a /usr/bin/git stub that opens an installer dialog until the
  # command-line tools are installed; ask xcode-select instead of running it.
  if [[ "$OS" == Darwin && "$(command -v git 2>/dev/null)" == /usr/bin/git ]]; then
    xcode-select -p >/dev/null 2>&1
    return
  fi
  command -v git >/dev/null 2>&1
}

find_bun() {
  command -v bun 2>/dev/null && return
  local candidate
  for candidate in "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.local/bin/bun"; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  return 1
}

# Same places the daemon looks (daemon/src/providers/anthropic/cli.ts).
find_claude() {
  [[ -n "${CLAUDE_CODE_BIN:-}" && -x "${CLAUDE_CODE_BIN:-}" ]] && { echo "$CLAUDE_CODE_BIN"; return; }
  command -v claude 2>/dev/null && return
  local candidate
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  return 1
}

is_checkout() { [[ -e "$1/.git" && -f "$1/bin/exocortexd" ]]; }

# The checkout an earlier install runs from, so a rerun updates it instead of
# cloning a second copy: the `exocortexd` link, else the macOS LaunchAgent.
existing_checkout() {
  local link="$BIN_DIR/exocortexd" target plist
  if [[ -L "$link" ]]; then
    target="$(readlink "$link")"
    [[ "$target" == /* ]] || target="$BIN_DIR/$target"
    target="$(dirname "$(dirname "$target")")"
    is_checkout "$target" && { echo "$target"; return; }
  fi
  plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  if [[ "$OS" == Darwin && -f "$plist" ]]; then
    target="$(awk '/<string>--repo<\/string>/ { getline; gsub(/^[[:space:]]*<string>|<\/string>.*$/, ""); print; exit }' "$plist")"
    [[ -n "$target" ]] && is_checkout "$target" && { echo "$target"; return; }
  fi
  return 1
}

resolve_dir() {
  if [[ -n "$DIR" ]]; then
    [[ "$DIR" == /* ]] || DIR="$PWD/$DIR"
    DIR="${DIR%/}"
    if [[ -d "$DIR" ]]; then DIR="$(cd "$DIR" && pwd)"; fi
    return 0
  fi
  # Run from a clone (not piped): install that clone.
  local self="${BASH_SOURCE[0]:-}"
  if [[ -n "$self" && -f "$self" ]]; then
    self="$(cd "$(dirname "$self")" && pwd)"
    is_checkout "$self" && { DIR="$self"; return; }
  fi
  DIR="$(existing_checkout)" || DIR="$DEFAULT_DIR"
}

# ── Steps ────────────────────────────────────────────────────────────

install_bun() {
  step "Bun"
  if BUN="$(find_bun)"; then
    ok "Bun $("$BUN" --version) ($BUN)"
  else
    note "Installing Bun (https://bun.sh/install)..."
    run_logged bun bash -c 'curl -fsSL https://bun.sh/install | bash' || die "Bun install failed."
    BUN="$(find_bun)" || die "Bun installed but not found; open a new shell and rerun."
    ok "Installed Bun $("$BUN" --version)"
  fi
  PATH="$(dirname "$BUN"):$PATH"
  export PATH
}

install_claude_code() {
  step "Claude Code"
  if CLAUDE="$(find_claude)"; then
    ok "Claude Code $("$CLAUDE" --version 2>/dev/null | awk '{ print $1; exit }') ($CLAUDE)"
  elif ((NO_CLAUDE_CODE == 1)); then
    note "Skipped (--no-claude-code); Claude models need it"
  else
    note "Installing Claude Code (https://claude.ai/install.sh)..."
    run_logged claude bash -c 'curl -fsSL https://claude.ai/install.sh | bash' || die "Claude Code install failed."
    CLAUDE="$(find_claude)" || die "Claude Code installed but not found in ~/.local/bin."
    ok "Installed Claude Code $("$CLAUDE" --version 2>/dev/null | awk '{ print $1; exit }')"
  fi
}

# Sets UPDATED=1 when the source changed (fresh clone or new commits).
fetch_source() {
  step "Source"
  UPDATED=0
  if is_checkout "$DIR"; then
    local current before
    current="$(git -C "$DIR" symbolic-ref --short -q HEAD || true)"
    before="$(git -C "$DIR" rev-parse HEAD)"
    BRANCH="${BRANCH:-$current}"
    if [[ -z "$BRANCH" ]]; then
      warn "$DIR is not on a branch; not updating it (pass --branch NAME to switch)"
    elif [[ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]]; then
      warn "$DIR has local changes; not updating it"
    elif ! run_logged fetch git -C "$DIR" fetch --quiet origin "$BRANCH"; then
      warn "Could not fetch $BRANCH; keeping the current code"
    else
      if [[ "$current" != "$BRANCH" ]]; then
        git -C "$DIR" switch --quiet "$BRANCH" 2>/dev/null \
          || run_logged switch git -C "$DIR" switch --quiet -c "$BRANCH" FETCH_HEAD \
          || die "Could not switch $DIR to $BRANCH."
      fi
      if ! run_logged merge git -C "$DIR" merge --ff-only --quiet FETCH_HEAD; then
        warn "$BRANCH has diverged from origin; keeping the local commits"
      fi
    fi
    [[ "$(git -C "$DIR" rev-parse HEAD)" != "$before" ]] && UPDATED=1
    local state=""
    ((UPDATED == 1)) && state=", updated"
    ok "$DIR at $(git -C "$DIR" rev-parse --short HEAD) (${BRANCH:-detached})$state"
  else
    if [[ -e "$DIR" ]] && [[ -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
      die "$DIR exists and is not an Exocortex checkout; pass --dir to install elsewhere."
    fi
    BRANCH="${BRANCH:-main}"
    mkdir -p "$(dirname "$DIR")"
    run_logged clone git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR" || die "git clone $REPO_URL failed."
    UPDATED=1
    ok "Cloned $BRANCH into $DIR"
  fi
}

install_dependencies() {
  step "Dependencies"
  if [[ "$OS" == Linux ]]; then
    bash "$DIR/scripts/setup/check-ipv6.sh" || exit 1
  fi
  (cd "$DIR" && run_logged deps "$BUN" install --frozen-lockfile) || die "bun install failed in $DIR."
  ok "Installed (including the Claude agent SDK)"
}

link_commands() {
  step "Commands"
  mkdir -p "$BIN_DIR"
  ln -sfn "$DIR/bin/exocortexd" "$BIN_DIR/exocortexd"
  ok "exocortexd → $BIN_DIR/exocortexd"
  if ((WITH_TUI == 1)); then
    ln -sfn "$DIR/bin/exocortex" "$BIN_DIR/exocortex"
    ok "exocortex (TUI) → $BIN_DIR/exocortex"
  elif [[ "$(readlink "$BIN_DIR/exocortex" 2>/dev/null)" == "$DIR/bin/exocortex" ]]; then
    ok "exocortex (TUI) already linked"
  else
    note "TUI not installed (add it later: exocortexd install-tui)"
  fi
  BIN_DIR="$BIN_DIR" BUN_BIN="$BUN" bash "$DIR/scripts/setup/install-shell-path.sh"
}

file_digest() {
  [[ -f "$1" ]] || return 0
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Wait until the daemon answers on its socket (a restart can leave the old
# socket file in place for a moment, so the file alone proves nothing).
wait_for_daemon() {
  local socket
  socket="$(env -u EXOCORTEX_SOCKET "$DIR/bin/exocortexd" socket)"
  for _ in $(seq 1 60); do
    if [[ "$(doctor_get "r.daemon.responsive")" == true ]]; then
      ok "Daemon is up: $socket"
      return 0
    fi
    sleep 0.5
  done
  warn "The daemon is not answering yet on $socket (check: exocortexd status)"
}

# Restart a running daemon onto new code; never from inside its own turn.
restart_daemon() {
  if inside_exocortex; then
    warn "Running inside Exocortex; restart the daemon yourself to load the update: exocortexd restart"
    return
  fi
  "$DIR/bin/exocortexd" restart >/dev/null || warn "exocortexd restart failed (check: exocortexd status)"
  ok "Restarted the daemon onto the new code"
  wait_for_daemon
}

install_service_linux() {
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "No systemd user session here; skipped the service."
    note "Start the daemon by hand with: exocortexd"
    return
  fi
  local unit="$HOME/.config/systemd/user/$UNIT_NAME" before was_active=0
  before="$(file_digest "$unit")"
  systemctl --user is-active --quiet "$UNIT_NAME" && was_active=1
  UNIT_NAME="$UNIT_NAME" bash "$DIR/scripts/setup/install-daemon.sh" || warn "Service setup reported a problem (check: exocortexd status)"
  if ((was_active == 1)) && { ((UPDATED == 1)) || [[ "$(file_digest "$unit")" != "$before" ]]; }; then
    restart_daemon
  fi
  # A user service stops at logout unless lingering is on (servers, SSH-only use).
  if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" == no ]]; then
    note "To keep the daemon running after you log out: loginctl enable-linger $(id -un)"
  fi
}

install_service_macos() {
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist" domain target before loaded=0
  domain="gui/$(id -u)"
  target="$domain/$LAUNCHD_LABEL"
  before="$(file_digest "$plist")"
  launchctl print "$target" >/dev/null 2>&1 && loaded=1

  local launcher=0
  if command -v clang >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; then
    # The signed launcher app makes macOS privacy prompts name "Exocortex
    # Daemon" instead of bash (README › macOS › Daemon launcher). It edits an
    # existing LaunchAgent in place and rebuilds only when its sources change.
    EXOCORTEX_LAUNCHD_LABEL="$LAUNCHD_LABEL" bash "$DIR/scripts/macos/build-launcher.sh" --if-changed --quiet \
      || die "Building the daemon launcher failed."
    launcher=1
  else
    warn "Xcode command-line tools not found; using a plain LaunchAgent (privacy prompts will name bash)"
    mkdir -p "$DIR/config/runtime"
    "$BUN" "$DIR/scripts/macos/launchagent.ts" --mode plain --plist "$plist" --repo "$DIR" \
      --bun-dir "$(dirname "$BUN")" --label "$LAUNCHD_LABEL" >/dev/null || die "Writing $plist failed."
  fi

  if ((loaded == 0)); then
    launchctl bootstrap "$domain" "$plist" || die "launchctl bootstrap $plist failed."
    launchctl enable "$target" 2>/dev/null || true
    ok "Loaded LaunchAgent $LAUNCHD_LABEL"
    wait_for_daemon
  elif [[ "$(file_digest "$plist")" != "$before" ]] && ((launcher == 1)); then
    # A changed plist only takes effect after a reload.
    if inside_exocortex; then
      warn "Running inside Exocortex; reload the LaunchAgent from a terminal: $DIR/scripts/macos/build-launcher.sh --reload"
    else
      EXOCORTEX_LAUNCHD_LABEL="$LAUNCHD_LABEL" bash "$DIR/scripts/macos/build-launcher.sh" --if-changed --quiet --reload --no-tools-update >/dev/null
      ok "Reloaded LaunchAgent $LAUNCHD_LABEL"
    fi
  elif ((UPDATED == 1)); then
    restart_daemon
  else
    ok "LaunchAgent $LAUNCHD_LABEL already running"
  fi
}

install_service() {
  step "Service"
  if ((NO_SERVICE == 1)); then
    note "Skipped (--no-service); start the daemon by hand with: exocortexd"
    return
  fi
  if [[ "$OS" == Darwin ]]; then install_service_macos; else install_service_linux; fi
}

# doctor_get EXPR: one value from `exocortexd doctor --json` (EXPR is JS over `r`),
# about this install's daemon even when run from another daemon's shell.
doctor_get() {
  EXOCORTEX_SOCKET="" "$DIR/bin/exocortexd" doctor --json 2>/dev/null \
    | "$BUN" -e "const r = JSON.parse(await Bun.stdin.text()); const v = $1; console.log(v ?? '')" 2>/dev/null || true
}

login() {
  (cd "$DIR/daemon" && "$BUN" run src/main.ts login "$@" </dev/tty)
}

walk_logins() {
  step "Sign in"
  if ((NO_LOGIN == 1 || HAVE_TTY == 0)); then
    note "Sign in later with: exocortexd login anthropic   (Claude, via Claude Code)"
    note "                or: exocortexd login openai      (ChatGPT plan; 'openai code' on a headless machine)"
    return
  fi
  local claude_ok openai_ok
  claude_ok="$(doctor_get "r.providers?.anthropic?.authenticated ? (r.providers.anthropic.email || 'yes') : ''")"
  openai_ok="$(doctor_get "r.providers?.openai?.authenticated ? (r.providers.openai.email || 'yes') : ''")"

  if [[ -n "$claude_ok" ]]; then
    ok "Claude: signed in ($claude_ok)"
  elif [[ -n "${CLAUDE:-}" ]] && ask "Sign in to Claude now (your Claude subscription, via Claude Code)?" y; then
    login anthropic || warn "Claude sign-in did not finish; retry with: exocortexd login anthropic"
  fi
  if [[ -n "$openai_ok" ]]; then
    ok "OpenAI: signed in ($openai_ok)"
  elif ask "Sign in to OpenAI (ChatGPT plan) now?" n; then
    login openai || warn "OpenAI sign-in did not finish; retry with: exocortexd login openai"
  fi
}

# ── Install / uninstall ──────────────────────────────────────────────

install_main() {
  resolve_dir
  LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/exocortex-install.XXXXXX")"
  # Where the installers put bun, claude and our links, for this run's lookups.
  export PATH="$BIN_DIR:$HOME/.local/bin:$PATH"

  local missing=()
  have_git || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  if [[ "$OS" == Linux ]] && ! find_bun >/dev/null && ! command -v unzip >/dev/null 2>&1; then missing+=(unzip); fi
  if ((${#missing[@]} > 0)); then
    if [[ "$OS" == Darwin && " ${missing[*]} " == *" git "* ]]; then
      die "Git is missing. Install Apple's command-line tools with: xcode-select --install   then rerun."
    fi
    die "Missing ${missing[*]}. Install with:  $(package_hint "${missing[@]}")   then rerun."
  fi

  local plan=()
  find_bun >/dev/null || plan+=("Bun (official installer)")
  ((NO_CLAUDE_CODE == 1)) || find_claude >/dev/null || plan+=("Claude Code (official installer)")
  if is_checkout "$DIR"; then plan+=("update $DIR"); else plan+=("clone Exocortex into $DIR"); fi
  if ((WITH_TUI == 1)); then plan+=("link exocortexd and exocortex (TUI) into $BIN_DIR"); else plan+=("link exocortexd into $BIN_DIR"); fi
  if ((NO_SERVICE == 0)); then
    if [[ "$OS" == Darwin ]]; then plan+=("LaunchAgent $LAUNCHD_LABEL"); else plan+=("systemd user service $UNIT_NAME"); fi
  fi

  printf '\n%sExocortex installer%s\n' "$BOLD" "$RESET"
  local item
  for item in "${plan[@]}"; do note "$item"; done
  if ! ask "Continue?" y; then echo "  Cancelled."; exit 1; fi

  install_bun
  install_claude_code
  fetch_source
  install_dependencies
  link_commands
  install_service
  walk_logins

  step "Status"
  EXOCORTEX_SOCKET="" "$DIR/bin/exocortexd" doctor | sed '1,3d' || true
  printf '  Open a new shell to pick up PATH. Check the install any time with: exocortexd doctor\n'
  ((WITH_TUI == 1)) && printf '  Start the TUI with: exocortex\n'
  printf '\n'
}

uninstall_main() {
  resolve_dir
  LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/exocortex-install.XXXXXX")"
  # Where the installers put bun, claude and our links, for this run's lookups.
  export PATH="$BIN_DIR:$HOME/.local/bin:$PATH"
  inside_exocortex && die "Run the uninstaller from a terminal, not from inside Exocortex (it stops the daemon)."
  printf '\n%sExocortex uninstaller%s\n' "$BOLD" "$RESET"
  note "Stops and removes the daemon service and the exocortexd/exocortex commands."
  note "Keeps $DIR (the source and your data) and Bun/Claude Code."
  ask "Continue?" y || { echo "  Cancelled."; exit 1; }

  if [[ "$OS" == Darwin ]]; then
    local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist" target
    target="gui/$(id -u)/$LAUNCHD_LABEL"
    if launchctl print "$target" >/dev/null 2>&1; then
      [[ -x "$DIR/bin/exocortexd" ]] && "$DIR/bin/exocortexd" stop >/dev/null 2>&1 || true
      launchctl bootout "$target" 2>/dev/null || true
      ok "Stopped and unloaded $LAUNCHD_LABEL"
    fi
    if [[ -f "$plist" ]]; then rm -f "$plist"; ok "Removed $plist"; fi
    local app="$HOME/Applications/Exocortex Daemon.app"
    if [[ -d "$app" ]]; then rm -rf "$app"; ok "Removed $app"; fi
  else
    local unit="$HOME/.config/systemd/user/$UNIT_NAME"
    if [[ -f "$unit" ]]; then
      if systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
        # `exocortexd stop` is the stop that resumes nothing later.
        "$DIR/bin/exocortexd" stop >/dev/null 2>&1 || systemctl --user stop "$UNIT_NAME" || true
        ok "Stopped $UNIT_NAME"
      fi
      systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1 || true
      rm -f "$unit"
      systemctl --user daemon-reload 2>/dev/null || true
      ok "Removed $UNIT_NAME"
    fi
  fi

  local name target
  for name in exocortexd exocortex; do
    target="$(readlink "$BIN_DIR/$name" 2>/dev/null || true)"
    if [[ "$target" == "$DIR/bin/$name" ]]; then
      rm -f "$BIN_DIR/$name"
      ok "Removed $BIN_DIR/$name"
    fi
  done
  printf '\n  Done. To delete the source and all data too: rm -rf %q\n\n' "$DIR"
}

main() {
  while (($# > 0)); do
    case "$1" in
      --tui) WITH_TUI=1 ;;
      --dir) DIR="${2:?--dir needs a path}"; shift ;;
      --dir=*) DIR="${1#--dir=}" ;;
      --branch) BRANCH="${2:?--branch needs a name}"; shift ;;
      --branch=*) BRANCH="${1#--branch=}" ;;
      --repo) REPO_URL="${2:?--repo needs a URL}"; shift ;;
      --no-service) NO_SERVICE=1 ;;
      --no-login) NO_LOGIN=1 ;;
      --no-claude-code) NO_CLAUDE_CODE=1 ;;
      -y|--yes) ASSUME_YES=1 ;;
      --uninstall) UNINSTALL=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "Unknown option: $1" ;;
    esac
    shift
  done
  [[ -n "${HOME:-}" ]] || die "HOME is not set."
  if ((UNINSTALL == 1)); then uninstall_main; else install_main; fi
}

# Everything runs from main, parsed in full before it starts, so a `git pull`
# that rewrites this file mid-run cannot change what bash executes.
main "$@"
