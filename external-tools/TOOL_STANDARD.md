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
  },
  "shell": {
    "literalArgs": [
      { "subcommand": "send", "kind": "tail" },
      { "subcommand": "reply", "kind": "tail" },
      { "subcommand": "dm", "kind": "flag", "flag": "--send" }
    ]
  }
}
```

- **name**: The command name as typed in bash. Must match the binary basename.
- **bin**: Relative path to the executable. Its parent directory is added to PATH.
- **systemHint**: Injected into the system prompt so the model knows the tool exists.
- **display**: TUI styling for bash sub-command matching (label + hex color).
- **shell**: Optional bash-harness hints for literal-safe rewriting of eligible tool invocations in bash command lines.

### Optional: literal argument rules

Use this when certain subcommands take freeform text (message bodies, markdown,
code blocks, etc.) that should not be interpreted by the shell.

```json
{
  "shell": {
    "literalArgs": [
      { "subcommand": "send", "kind": "tail" },
      { "subcommand": "reply", "kind": "tail" },
      { "subcommand": "dm", "kind": "flag", "flag": "--send" }
    ]
  }
}
```

Supported rule kinds:
- `{"subcommand":"send","kind":"tail"}`
  - Treats the final positional argument to `tool-name send ...` as literal text.
- `{"subcommand":"dm","kind":"flag","flag":"--send"}`
  - Treats the value passed to `--send` as literal text.

This lets the AI write commands like:

~~~bash
discord send general "```ts
const x = \"$HOME\";
```"
discord dm 123 --send "$HOME"
~~~

without having to manually protect `$`, backticks, quotes, or newlines in the
configured literal argument.

Scope:
- Applies to eligible top-level tool invocations, including within simple chains/pipelines like `cmd1 && discord send ...`, `cmd1; discord send ...`, or `discord send ... | tee out.txt`
- Does not apply inside subshells, redirects, or other unsupported shell syntax within the same segment
- Keep flags/options before the literal text they control

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

### External notification subscriptions

External tools that autonomously deliver platform events into Exocortex
conversations must use the daemon's generic external-notification registry.
Do not keep Exocortex conversation IDs in a tool-local `relay_targets` list and
do not shell out to `exo send` from a listener. The external tool owns platform
authentication, event collection, source-level filtering, and formatting;
Exocortex owns the durable source → conversation route, optional subscriber-
owned soft-wake filtering, delivery policy, deduplication, and UI.

This applies to notification listeners such as Discord DMs/mentions, Twitter
replies/quotes, and WhatsApp incoming messages. Ordinary request/response tools
and explicit human/script calls to `exo send` do not need this interface.

#### Source lifecycle

Every listener declares one or more stable, tool-local sources. Register each
source when the listener starts, before migrating subscriptions or publishing
events:

```json
{"type":"register_external_notification_source","reqId":"1","toolName":"discord","source":{"id":"account:paramount:notifications","label":"Paramount · DMs and @mentions","description":"Direct messages, group DMs, and server mentions received by the Paramount account"}}
```

The daemon replies with `external_notification_source`. Source IDs are opaque to
Exocortex but must remain stable across restarts. Include the account/profile in
the ID when a tool supports multiple accounts. Labels and descriptions are safe
display metadata; never include credentials or tokens.

Discover registered sources with:

```json
{"type":"list_external_notification_sources","reqId":"2","toolName":"discord"}
```

The response is `external_notification_sources` with a `sources` array.

#### Subscription management

Tool CLIs should expose `notify subscribe`, `notify unsubscribe`, and
`notify list` (legacy `add`/`remove` may remain aliases). These commands call the
daemon registry rather than editing a tool-local routing file:

```json
{"type":"subscribe_external_notification","reqId":"3","toolName":"discord","sourceId":"account:paramount:notifications","convId":"<conversation-id>","delivery":"wake"}
{"type":"subscribe_external_notification","reqId":"3b","toolName":"discord","sourceId":"account:paramount:notifications","convId":"<conversation-id>","delivery":"soft","softWake":{"command":"./filter-event.sh","timeoutMs":30000,"hardWake":{"when":"failure","message":"Handle the selected external event.","includeOutput":true}}}
{"type":"list_external_notification_subscriptions","reqId":"4","toolName":"discord","sourceId":"account:paramount:notifications"}
{"type":"unsubscribe_external_notification","reqId":"5","subscriptionId":"<subscription-id>"}
{"type":"update_external_notification_subscription","reqId":"6","subscriptionId":"<subscription-id>","delivery":"inbox","enabled":true}
```

`delivery` is one of:

- `wake` — durably enqueue the notification and autonomously start a model turn
  when the conversation is idle; if busy, deliver after its active turn.
- `inbox` — persist a provenance-tagged, model-visible notice and mark the
  conversation unread without autonomously starting a model turn.
- `soft` — durably run subscriber-owned static Bash without a model. The event
  is provided as JSON on stdin and is never interpolated into the command.
  `softWake.hardWake.when` may be `failure` (including a script-defined non-zero
  exit) or `always`; capped output can be included in the resulting hard wake.

Soft-wake commands run at least once across crash windows. Exocortex exports a
stable `EXOCORTEX_NOTIFICATION_OCCURRENCE_ID` plus subscription, source, and
event ID environment variables so side-effecting scripts can deduplicate. The
stdin JSON has this shape:

```json
{"type":"external_notification","subscription":{"id":"…","conversationId":"…","toolName":"discord","sourceId":"…","sourceLabel":"…"},"event":{"id":"discord-message-123","occurredAt":1770000000000,"text":"DM from Fede: …","data":{"senderId":"123","body":"…"}}}
```

Commands are selected by the subscription owner, never by the publisher.
Implementations must enforce timeouts, output limits, bounded concurrency, and
the normal Bash safety policy. The daemon also applies bounded durable-backlog
quotas; a publisher receives `failed` backpressure and must not treat that event
as accepted. Managed command runners enforce their timeout and terminate their
process group if the owning daemon channel disappears. Command output and event
content remain explicitly untrusted when included in a model wake.

Actual command exits, signals, timeouts, and safety-policy blocks are terminal
soft-wake outcomes and follow the configured hard-wake policy. Runner/spawn or
other execution-infrastructure failures remain durably pending and retry without
being checkpointed as command outcomes.

An accepted event snapshots the current command policy. Updating the command
affects future events; disabling/unsubscribing the route, changing it away from
`soft`, or deleting its conversation revokes pending work, aborts active work,
and suppresses any later hard wake.

The daemon validates conversation IDs and removes subscriptions when their
conversation is deleted. External tools should never choose a target while
publishing an event; routing is entirely daemon-owned.

The native model-facing Exocortex command registry also exposes a
`notifications` command. This lets an AI discover sources and subscribe the
active conversation when the user says, for example, “subscribe this chat to
Discord notifications.”

#### Publishing events

Publish one logical platform event or intentionally formatted batch with a
stable event ID:

```json
{"type":"publish_external_notification","reqId":"7","toolName":"discord","sourceId":"account:paramount:notifications","eventId":"discord-message-123","occurredAt":1770000000000,"text":"DM from Fede: …","data":{"senderId":"123","body":"…"}}
```

The daemon finds enabled subscriptions, adds an explicit untrusted-external-
content envelope, deduplicates per subscription/event ID, and returns
`external_notification_publish_result` with a `deliveries` array. A tool may
retry the same event ID safely. Treat `queued`, `inbox`, `started`, and
`duplicate` as accepted outcomes; retain/retry events whose routes report
`failed` according to the platform listener's normal retry policy.

Requirements:

- Never include a target conversation ID in a publish request.
- `data`, when present, must be JSON-compatible untrusted event data. Keep it
  compact (at most 100,000 serialized characters) and do not include secrets.
- Never include secrets in source metadata, event IDs, text, or logs.
- Use platform-stable event IDs so reconnect/replay does not duplicate turns.
- Exclude outgoing/self-authored events and history hydration unless the source
  explicitly promises those semantics.
- Keep platform sender labels, allowlists, cursors, and polling configuration in
  the external tool repository.
- On migration from a legacy `relay_targets` file, create all daemon-owned
  subscriptions first and delete the legacy key only after every import is
  acknowledged. Do not run both delivery paths concurrently.

The IPC transport is the normal Exocortex newline-delimited JSON socket. External
tools may extend their existing small daemon client helper; they must not import
daemon implementation files or write directly into Exocortex's data directory.

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

# Uninstall (soft-delete)
mkdir -p ~/Workspace/Exocortex/config/data/trash/external-tools
trash=~/Workspace/Exocortex/config/data/trash/external-tools/tool-name
if [ -e "$trash" ]; then
  trash="$trash-$(date +%Y%m%d-%H%M%S)"
fi
mv ~/Workspace/Exocortex/external-tools/tool-name "$trash"
```

No symlinks, no config files to edit, no system prompt changes.
The daemon discovers tools automatically and watches for additions/removals.
