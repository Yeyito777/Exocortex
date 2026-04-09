# External Tool Standard

Guide for building external tools for Exocortex. The reference
implementation is [gmail-cli](https://github.com/Yeyito777/gmail-cli).

## Directory layout

```
tool-name/
  manifest.json        # Exocortex metadata (required)
  .gitignore           # Ignore .venv, __pycache__, secrets
  bin/
    tool-name          # Entry point (bash wrapper)
  src/                 # Implementation
  config/              # Credentials, tokens, state
    .gitkeep           # Track the directory, gitignore its contents
  .venv/               # Python dependencies (if Python-based)
```

Each tool is its own git repository, independently developed. Tools are
installed by cloning into `external-tools/` — the daemon discovers them
automatically.

## manifest.json

```json
{
  "name": "tool-name",
  "bin": "./bin/tool-name",
  "systemHint": "You have access to ... Run `tool-name -h` for usage.",
  "display": {
    "label": "Tool Name",
    "color": "#hexcolor"
  }
}
```

- **name**: The command name as typed in bash. Must match the binary basename.
- **bin**: Relative path to the executable. Its parent directory is added to PATH.
- **systemHint**: Injected into the system prompt so the model knows the tool exists.
- **display**: TUI styling for bash sub-command matching (label + hex color).

### Optional: daemon supervision

Tools that need a long-running background process declare a `daemon` field.
The daemon auto-discovers it, spawns the process, and supervises it
(restart on crash with exponential backoff).

```json
{
  "daemon": {
    "command": "npx tsx lib/daemon.ts",
    "restart": "on-failure",
    "env": { "NODE_ENV": "production" }
  }
}
```

- **command**: Shell command run from the tool's root directory (executed via `bash -lc`).
- **restart**: `"on-failure"` (default) — restart on non-zero exit.
  `"always"` — restart on any exit. `"never"` — don't restart.
- **env**: Additional environment variables (merged with process env).

Stdout/stderr are captured to `config/service.log`. When a tool is removed,
its daemon is stopped automatically.

## Entry point

The `bin/` script is a thin bash wrapper. It resolves the project root,
sets up the runtime (venv, PYTHONPATH, etc.), and dispatches subcommands
via a `case` statement.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON="$PROJECT_DIR/.venv/bin/python3"

export PYTHONPATH="$PROJECT_DIR"

# ... usage() function ...

cmd="$1"; shift
case "$cmd" in
    subcmd1|subcmd2)
        exec "$PYTHON" -c "import sys; from src.module import $cmd; $cmd(sys.argv[1:])" "$@" ;;
    login|logout)
        exec "$PYTHON" -c "import sys; from src.auth import $cmd; $cmd(sys.argv[1:])" "$@" ;;
    help|--help|-h)
        usage ;;
    *)
        echo "tool-name: unknown command '$cmd'" >&2
        echo "Run 'tool-name --help' for usage." >&2
        exit 1 ;;
esac
```

Why bash wraps the implementation:
- Resolves venv/runtime without the user knowing about it.
- `--help` is instant (no interpreter startup).
- Language-agnostic pattern — works for Python, Node, Go, etc.

## Subcommands

Each subcommand is a function that takes `argv` and uses `argparse`
(or equivalent) internally.

```python
def inbox(argv):
    p = argparse.ArgumentParser(prog="tool-name inbox")
    p.add_argument("--limit", "-n", type=int, default=20)
    args = p.parse_args(argv)
    # ...
```

### Naming rules

- **Action commands** are verbs: `send`, `reply`, `archive`, `mark`, `search`.
- **Resource commands** with multiple operations use subcommands:
  `label list`, `label add`, `label remove`.
- **Resource commands** with a single operation are flat:
  `inbox`, `draft`, `search`.
- **Bare resource commands** (with subcommands) print help and exit.
  `tool-name label` alone shows `list/add/remove` usage.

### Authentication

Tools that require auth should provide:
- `tool-name login` — authenticate (opens browser, prompts for key, etc.)
- `tool-name logout` — remove stored credentials

## Output conventions

### List views

2-space indent. IDs visible for use in follow-up commands.

```
  ●   19d040fccc2896d1  John Doe                  Subject line here                                   08:07 PM
      19cea63baa700eeb  Jane Smith                Another subject                                 Fri 08:28 PM
```

### Detail views

Labeled key-value lines, body indented.

```
  Message ID: 19d040fccc2896d1
  Subject:    Some subject
  From:       sender@example.com
  Date:       Wed, 18 Mar 2026 20:07:17 -0700

  Body text here, indented two spaces.
```

### Confirmation messages

Single line, past tense.

```
Archived.                              # mutation
Marked as read.                        # mutation with qualifier
Trashed 12 messages.                   # bulk mutation
Sent. Message ID: 19d040fccc2896d1     # creation (include new ID)
Replied. Message ID: 19d040fccc2896d1  # creation
Created. Filter ID: abc123             # creation
```

Pattern:
- Mutations on existing items: `Verbed.` or `Verbed N items.`
- Creations: `Verbed. <Type> ID: <id>`

### Errors

Errors go to stderr. Descriptive, suggest the fix when possible.

```
Error: label 'Foo' not found.
Error: credentials.json not found at /path/to/config
  Download it from Google Cloud Console → APIs & Services → Credentials
```

### Exit codes

- **0**: success
- **1**: runtime error (auth failure, not found, API error)
- **2**: usage error (missing/invalid arguments — argparse default)

## .gitignore

Track the directory structure, ignore generated files and secrets.

```gitignore
.venv/
__pycache__/
*.pyc
config/*
!config/.gitkeep
```

## Install / uninstall

```bash
# Install
git clone <repo> ~/Workspace/Exocortex/external-tools/tool-name
cd ~/Workspace/Exocortex/external-tools/tool-name
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt  # if Python
# Set up config/credentials as needed
tool-name login

# Uninstall
rm -rf ~/Workspace/Exocortex/external-tools/tool-name
```

No symlinks, no config files to edit, no system prompt changes.
The daemon discovers tools automatically and watches for additions/removals.
