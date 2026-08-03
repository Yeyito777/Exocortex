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

## Helper tools

A **helper tool** is an ordinary executable that opts into custom
Exocortex TUI presentation through an adjacent `exo-manifest.json`. It is
useful for project scripts and one-off tools that should remain outside the
installed external-tool registry.

See [`helper-tools/HELPER_TOOLS_STANDARD.md`](../helper-tools/HELPER_TOOLS_STANDARD.md)
for the focused authoring standard and the repository's local helper-tool
directory.

Use this layer when the model already knows about the tool from the user's
request, an `AGENTS.md`, or project documentation, and the only Exocortex
integration needed is a recognizable label and color. Use a full external tool
manifest below when the tool needs global discovery, system-prompt instructions,
PATH installation, auth, notifications, or daemon supervision.

### Creating one

1. Create an executable with the desired tool name.
2. Put `exo-manifest.json` in the same directory.
3. Tell the model when to use the tool in `AGENTS.md`, project documentation,
   or the request itself. The display manifest is deliberately not a discovery
   or instruction mechanism.
4. Invoke it through a static relative or absolute path.

For example:

```
project/
  scripts/
    deploy
    exo-manifest.json
```

```bash
#!/usr/bin/env bash
set -euo pipefail

environment="${1:?usage: deploy <environment>}"
# Perform the project-local operation.
printf 'Deployed to %s.\n' "$environment"
```

```json
{
  "version": 1,
  "display": {
    "label": "Deploy",
    "color": "#7aa2f7"
  }
}
```

```bash
chmod +x ./scripts/deploy
./scripts/deploy production
```

The Bash tool call is rendered as `Deploy production`, while execution and
stdout remain those of the original command. One manifest applies to every
eligible executable in its directory; put commands in separate
directories when they need different labels or colors.

### Contract and boundaries

- The helper tool is still an ordinary executable invoked through Bash. The
  manifest cannot affect arguments, stdin, environment, permissions, execution,
  output, auth, or daemon supervision.
- The executable must be called through a static relative or absolute path.
  PATH-only `deploy`, `bash deploy`, shell expansion, and command
  substitution are not eligible.
- Relative lookup uses the Bash tool's initial working directory. Relative
  invocations after a preceding `cd`, `pushd`, `popd`, `source`, or `eval` are
  conservatively left unstyled; use a direct path from the initial directory or
  an absolute path instead.
- The executable must have a non-empty basename, and the manifest must be in
  the executable's lexical directory.
- `version` must be `1`; `display.label` is at most 64 characters and
  `display.color` is a six-digit hex color.
- Missing, unreadable, oversized, slow, or invalid manifests fall back to
  ordinary Bash presentation and never block command execution.
- Presentation is snapshotted into the tool call, so conversation history does
  not change when the manifest is edited or removed later.
- Helper tools with a primary opaque payload should follow the stdin convention
  described below. A display manifest does not make freeform inline shell
  arguments literal-safe.

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

## Primary opaque payloads

If a command has one primary opaque payload—message, body, prompt, JavaScript,
or raw IPC—it comes from stdin. Everything structural remains argv.

Read stdin as exact UTF-8: do not trim it, decode escapes, interpolate it, or
otherwise rewrite it. Reject inline payload arguments and reject a missing
required payload before external mutation, with an actionable stdin error.
Keep IDs, recipients, flags, names, titles, subjects, queries, and paths in argv.
If a command needs a second opaque payload, give it an explicit file or other
structured source. Document the contract in top-level and command-specific
`-h` output. Commands with a valid bodyless mode may explicitly allow empty
stdin.

## External call media adapters

Tools that join or answer platform calls act only as media adapters. Exocortex
owns the realtime model, conversation context, transcript, delegation, and call
lifecycle. A model-launched tool process receives:

```text
EXOCORTEX_PARENT_CONV_ID=<invoking conversation>
EXOCORTEX_SOCKET=<current daemon endpoint>
```

Use an explicit conversation override when supplied; otherwise bind the call to
`EXOCORTEX_PARENT_CONV_ID`. Only a manually-launched adapter with no invoking
conversation should create a dedicated conversation.

Start the call over the daemon JSONL protocol with a generic adapter identity:

```json
{"type":"start_call","reqId":"1","convId":"…","adapter":{"type":"external","id":"discord:paramount:1482111776505204953","toolName":"discord","accountAlias":"paramount","endpointId":"1482111776505204953","label":"#voice"}}
```

Wait for that adapter's `call_state: waiting_for_media`, send its WebRTC offer
with `attach_call_media`, apply the matching `call_sdp_answer`, and stop the
exact `callId` with `stop_call`. Adapter IDs must be stable and unique per
simultaneously usable platform endpoint. Platform input audio feeds the WebRTC
input track; WebRTC output returns directly to the platform.

Calling commands should expose one canonical behavior such as
`discord call join CHANNEL`, not a backend-selection flag. Keep platform session,
encryption, codec, participant, and mute/deafen mechanics in the external tool;
do not duplicate ASR, conversation transcripts, delegation, or spoken-response
generation there. See [`docs/external-call-adapters.md`](../docs/external-call-adapters.md).

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
{"type":"subscribe_external_notification","reqId":"3b","toolName":"discord","sourceId":"account:paramount:notifications","convId":"<conversation-id>","delivery":"soft","softWake":{"command":"./filter-event.sh","timeoutMs":30000,"hardWake":{"when":"failure","message":"Handle the selected external event.","includeOutput":false}}}
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
  Exit `0` means the filter did not select the event, while exit `10` explicitly
  selects it for a hard wake. Other non-zero exits, timeouts, signals, and safety
  blocks are actual filter failures. `softWake.hardWake.when` may be `failure`
  (selected events and failures) or `always`; capped diagnostic output can be
  included in the resulting hard wake.

Soft-wake commands run at least once across crash windows. Exocortex exports a
stable `EXOCORTEX_NOTIFICATION_OCCURRENCE_ID` plus subscription, source, and
event ID environment variables so side-effecting scripts can deduplicate. The
stdin JSON has this shape:

```json
{"type":"external_notification","subscription":{"id":"…","conversationId":"…","toolName":"discord","sourceId":"…","sourceLabel":"…"},"event":{"id":"discord-message-123","occurredAt":1770000000000,"text":"DM from Fede: …","data":{"schemaVersion":1,"accountAlias":"paramount","kind":"dm","channel":{"id":"456","type":"dm","name":"Fede","participants":["fede"],"participantIds":["123"]},"guild":null,"messageId":"discord-message-123","author":{"id":"123","username":"fede","displayName":"Fede"},"content":"…","mentionsAssistant":false,"replyTo":null}}}
```

`event.text` is a human-readable rendering for the model and UI. It is not a
machine-readable interface: publishers may wrap lines, truncate previews, or
change punctuation without versioning. `event.data` is the stable structured
interface for routing and filtering. Soft-wake commands should inspect
`event.data` and must not parse fields such as sender IDs, event kinds, message
bodies, mentions, or reply metadata back out of `event.text` when those fields
are available structurally.

The publisher's `text` is the event body, not another provenance envelope.
Exocortex adds the canonical `[notification] Tool/account · kind`
header exactly once. Event bodies should be compact but action-complete:

- Put the location and its actionable ID first, for example
  `raw mutton › #yeyo-dev [ch:1492179045167796224]` or
  `Family Chat [chat:120363…@g.us]`.
- When a source is configured to include context, preserve that context in
  chronological order under `Context:`. Do not re-rank or suppress it at render
  time.
- Render each contextual message as
  `Name <platform-user-id> [trust]: content [msg:message-id]`. For platforms
  with native mention syntax, preserve it (for example Discord `<@user-id>`).
- Render reply relationships inline as `↳ [reply-to:message-id]`.
- Separate the triggering event with `→`, preserve its original line breaks,
  and put its message ID on the final line.
- Do not repeat event IDs, timestamps, schema versions, subscription IDs,
  routing status, raw JSON, or generic untrusted-content prose in normal event
  text. Keep those in structured data/metadata. Actual filter failures may show
  concise diagnostics separately.

For example, a Discord publisher body can be:

```text
raw mutton › #yeyo-dev [ch:1492179045167796224]

Context:
Yeyito <@310543961825738754> [owner]: previous message [msg:1531350891586916523]
Paramount <@1031059414846808234> [assistant] ↳ [reply-to:1531350891586916523]: response [msg:1531350947148726345]

→ Yeyito <@310543961825738754> [owner]:
full multiline message
[msg:1531747966119968879]
```

Commands are selected by the subscription owner, never by the publisher.
Implementations must enforce timeouts, output limits, bounded concurrency, and
the normal Bash safety policy. The daemon also applies bounded durable-backlog
quotas; a publisher receives `failed` backpressure and must not treat that event
as accepted. Managed command runners enforce their timeout and terminate their
process group if the owning daemon channel disappears. Command output and event
content remain explicitly untrusted when included in a model wake.

Filter stdout is for concise diagnostics or an intentional presentation
addition, not event transport. A selecting filter should normally print
nothing and exit `10`; it must not echo the stdin payload or `event.text`, which
Exocortex already retains and renders once. Set `includeOutput` only when that
extra output is genuinely useful.

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
{"type":"publish_external_notification","reqId":"7","toolName":"discord","sourceId":"account:paramount:notifications","eventId":"discord-message-123","occurredAt":1770000000000,"text":"DM from Fede: …","data":{"schemaVersion":1,"accountAlias":"paramount","kind":"dm","channel":{"id":"456","type":"dm","name":"Fede","participants":["fede"],"participantIds":["123"]},"guild":null,"messageId":"discord-message-123","author":{"id":"123","username":"fede","displayName":"Fede"},"content":"…","mentionsAssistant":false,"replyTo":null}}
```

The daemon finds enabled subscriptions, adds an explicit untrusted-external-
content envelope, deduplicates per subscription/event ID, and returns
`external_notification_publish_result` with a `deliveries` array. A tool may
retry the same event ID safely. Treat `queued`, `inbox`, `started`, and
`duplicate` as accepted outcomes; retain/retry events whose routes report
`failed` according to the platform listener's normal retry policy.

Requirements:

- Never include a target conversation ID in a publish request.
- Sources with independently routable or filterable event attributes must
  publish them in `data`; omit `data` only when an event genuinely has no
  structured attributes. Include a positive integer `schemaVersion`, a stable
  event-kind discriminator, platform IDs, and the untruncated content and
  mention/reply metadata needed by subscribers. Treat the schema as an API:
  make changes backward-compatible or increment `schemaVersion`.
- `data` must be JSON-compatible untrusted event data. Keep it compact (at most
  100,000 serialized characters) and do not include secrets. Human-oriented
  history/context may remain in `text`; do not duplicate an unbounded transcript
  into `data`.
- Subscribers must route on `data`, not the presentation format of `text`.
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
