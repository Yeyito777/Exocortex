# Exocortex

A daemon-driven AI assistant with a clean client/server architecture.

```
┌─────────────┐                              ┌──────────────┐
│  exocortex  │         Unix Socket          │              │
│    (TUI)    │◄────────────────────────────►│              │
│  for humans │   Commands ──►               │  exocortexd  │
└─────────────┘          ◄── Events          │   (daemon)   │
                                             │              │
┌─────────────┐    (JSON-lines protocol)     │              │
│     exo     │◄────────────────────────────►│              │
│    (CLI)    │   Stateless req/response     │              │
│   for AIs   │                              └──────┬───────┘
└─────────────┘                                     │
                                                    │  Anthropic
                                                    │  Messages API
                                                    ▼
                                              ┌──────────┐
                                              │  Claude  │
                                              └──────────┘
```

## Install

Requires [Bun](https://bun.sh) and systemd (Arch Linux).

```bash
git clone https://github.com/Yeyito777/Exocortex.git
cd Exocortex
make install
```

This will:
- Install dependencies (`bun install`)
- Symlink `exocortexd`, `exocortex`, and `exo` into `~/.local/bin/`
- Install and start a systemd user service for the daemon

Then authenticate (one-time):

```bash
exocortexd login
```

Launch the TUI:

```bash
exocortex
```

> **Note:** Make sure `~/.local/bin` is in your `PATH`.
> Add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc if needed.

To uninstall:

```bash
make uninstall
```

## Architecture

**Four packages** in a Bun workspace:

- **`shared/`** — The protocol contract. Type definitions for commands,
  events, messages, and blocks. The single source of truth for the wire
  format between daemon and clients.

- **`daemon/`** — The backend. Owns everything: auth, API calls, streaming,
  conversation state, tool execution, persistence. Runs as a persistent
  background process exposing a Unix socket.

- **`tui/`** — The frontend. A terminal UI that connects to the daemon and
  renders the conversation. Pure presentation — no AI logic. Features vim
  keybindings, a conversations sidebar, visual mode, and autocomplete.

- **`cli/`** — A stateless CLI client for scripting and AI-to-AI interaction.
  Each invocation connects, sends a command, waits for the response, and
  disconnects. Conversation IDs are the state handles.

The protocol between them is newline-delimited JSON over a Unix domain socket.
Commands flow client → daemon. Events flow daemon → client.

## Usage

| Key / Command    | Action                              |
|------------------|-------------------------------------|
| `Enter`          | Send message                        |
| `Ctrl+Q`         | Abort current stream                |
| `Ctrl+C`         | Quit                                |
| `Ctrl+M`         | Toggle sidebar                      |
| `Ctrl+J` / `K`   | Cycle focus (sidebar ↔ chat)        |
| `Ctrl+N`         | Toggle history cursor               |
| `Ctrl+Shift+O`   | New conversation                    |
| `Ctrl+O`         | Toggle tool output                  |
| `Escape`         | Normal mode (vim)                   |
| `i` / `a`        | Insert mode (vim)                   |
| `v` / `V`        | Visual / visual-line mode           |
| `/new`           | Start a new conversation            |
| `/model <m>`     | Switch model (sonnet, haiku, opus)  |
| `/quit`          | Exit                                |

## Protocol

See `shared/src/protocol.ts` — the single source of truth for the IPC contract.

**Commands** (client → daemon):
- `ping` → `pong` + initial state (tools, usage, conversations)
- `new_conversation` → `conversation_created`
- `send_message` → streaming events → `message_complete`
- `load_conversation` → `conversation_loaded`
- `subscribe` / `unsubscribe` → `ack`
- `abort` → `ack`
- `set_model`, `delete_conversation`, `mark_conversation`, `pin_conversation`, `move_conversation`

**Events** (daemon → client):
- `streaming_started` / `streaming_stopped` — broadcast to all clients
- `block_start` / `text_chunk` / `thinking_chunk` — sent to subscribers
- `tool_call` / `tool_result` — tool execution progress
- `message_complete` — canonical blocks + metadata
- `conversation_updated` / `conversation_deleted` — sidebar state
- `usage_update` / `context_update` / `tokens_update` — telemetry
- `error` — sent to relevant client(s)

## File Structure

```
bin/
├── exocortexd         Daemon launcher
├── exocortex          TUI launcher
└── exo                CLI launcher

shared/
└── src/
    ├── protocol.ts        IPC command/event type definitions
    └── messages.ts        Block, message, and domain model types

daemon/
└── src/
    ├── main.ts            Entry point (start daemon or login)
    ├── server.ts          Unix socket server + client tracking
    ├── handler.ts         Command routing (thin dispatcher)
    ├── orchestrator.ts    Wires agent loop to IPC event dispatch
    ├── agent.ts           Stream → tool call → execute loop
    ├── api.ts             Anthropic Messages API + SSE parsing
    ├── conversations.ts   In-memory conversation store + persistence
    ├── streaming.ts       In-flight stream tracking (runtime state)
    ├── persistence.ts     Versioned JSON file storage + migrations
    ├── auth.ts            OAuth login + token refresh
    ├── store.ts           Credential persistence
    ├── usage.ts           Rate-limit / usage tracking
    ├── cache.ts           Prompt caching breakpoint injection
    ├── system.ts          System prompt builder
    ├── display.ts         Conversation → display entry conversion
    ├── messages.ts        Daemon-specific message types (API-level)
    ├── log.ts             File logger
    └── tools/
        ├── registry.ts    Tool collection + executor builder
        ├── types.ts       Tool interface definition
        ├── bash.ts        Shell command execution
        ├── read.ts        File reading
        ├── write.ts       File writing
        ├── edit.ts        String replacement editing
        ├── glob.ts        File pattern matching
        ├── grep.ts        Content search (ripgrep)
        └── browse.ts      URL fetching

cli/
└── src/
    ├── main.ts            Entry point (arg parsing + dispatch)
    ├── conn.ts            Promise-based Unix socket client
    ├── collect.ts         Event collector (subscribe + wait for streaming_stopped)
    ├── format.ts          Output formatting (text, JSON, stream)
    └── commands.ts        All subcommands (send, ls, info, history, rm, etc.)

tui/
└── src/
    ├── main.ts            Entry point + event loop
    ├── state.ts           Centralized render state
    ├── client.ts          Unix socket client
    ├── events.ts          Daemon event → state mutations
    ├── render.ts          Layout composition
    ├── focus.ts           Top-level key routing (panel focus)
    ├── keybinds.ts        Key → action mapping
    ├── input.ts           Raw key event parsing
    ├── chat.ts            Chat panel key handling
    ├── sidebar.ts         Sidebar state, keys, and rendering
    ├── conversation.ts    Message → rendered lines
    ├── promptline.ts      Multi-line prompt input
    ├── commands.ts        Slash command parsing
    ├── autocomplete.ts    Command + path completion
    ├── tabcomplete.ts     Tab completion integration
    ├── historycursor.ts   History panel cursor + motions
    ├── cursorrender.ts    Cursor + selection rendering
    ├── statusline.ts      Bottom status bar
    ├── topbar.ts          Top bar rendering
    ├── terminal.ts        ANSI escape sequences
    ├── theme.ts           Theme loader
    ├── toolstyles.ts      Per-tool display styling
    ├── metadata.ts        Message metadata formatting
    ├── undo.ts            Undo/redo state machine
    └── vim/
        ├── index.ts       Public API (re-exports)
        ├── engine.ts      Vim state machine (key processing)
        ├── keymap.ts      Mode × context → command table
        ├── motions.ts     Cursor motion implementations
        ├── operators.ts   Delete, change, yank operations
        ├── textobjects.ts Inner/around text objects
        ├── visual.ts      Visual mode handling
        ├── buffer.ts      Buffer position utilities
        ├── clipboard.ts   System clipboard integration
        └── types.ts       Vim type definitions
```
