# Exocortex documentation

For installation, authentication, updates, and supported platforms, see the
[root README](../README.md).

## Architecture and operations

The Bun workspace has three packages: `shared/` defines the domain and IPC
types, `daemon/` owns assistant execution and persistence, and `tui/` is the
terminal client. The separate `exo` CLI is an external tool, not a workspace
package. Clients exchange newline-delimited JSON with the daemon; `/ssh`
selects another daemon without moving client-side UI operations to that host.

- [Direct daemon commands](daemon-ipc.md) and the
  [wire specification](../shared/src/protocol.ts)
- [Architecture roadmap](architecture-roadmap.md)
- [SQLite conversation storage](sqlite-conversation-store/README.md)
- [Conversation display pages](conversation-display-pages.md)
- [Conversation workspaces](conversation-workspaces.md)
- [SSH history cache](ssh-history-cache.md)
- [Goals](goals.md)
- [Delegation models](delegation-models.md)
- [External call adapters and realtime delegation](external-call-adapters.md)
- [Local links](local-links.md)
- [Update status](update-status.md)

## Keyboard reference

The implementation in [keybinds.ts](../tui/src/keybinds.ts) and
[focus.ts](../tui/src/focus.ts) is authoritative.

| Key / command | Action |
|---|---|
| `Enter` | Send message |
| `Ctrl+Q` | Abort current stream |
| `Ctrl+C` | Quit |
| `Ctrl+M` | Toggle sidebar |
| `Ctrl+J` / `K` | Cycle focus between sidebar and chat |
| `Ctrl+N` | Toggle history cursor |
| `Ctrl+Shift+O` | New conversation |
| `Ctrl+O` | Toggle tool output |
| `Shift+H` / `M` / `L` | In sidebar, jump to top / middle / bottom visible conversation |
| `Escape` | Normal mode (vim) |
| `i` / `a` | Insert mode (vim) |
| `v` / `V` | Visual / visual-line mode |
| `Tab` | In prompt insert mode, complete a popup/path or insert a four-space soft tab |
| `Backspace` / `Delete` | Remove an adjacent four-space soft tab in one press |
| `>>` / `<<` | Shift prompt lines right / left by four spaces |
| `{` / `}` | In chat normal mode, focus history and jump among user-message starts |
| `[` / `]` | In chat normal mode, focus history and jump among final AI-response text blocks |
| `;` | In history visual mode, quote selection into the draft |
| `/new` | Start a new conversation |
| `/model <provider> <model>` | Switch provider/model |
| `/model openai gpt-6-sol-daybreak` | Select Sol Daybreak Blue when advertised by the connected account |
| `/trim <mode> <n>` | Trim old context |
| `/quit` | Exit |

In prompt normal mode, `3>>` shifts three lines once. In visual modes, shifts
apply to every selected logical line and return to normal mode. Shifts support
undo/redo; outdenting removes at most four leading spaces without removing text.
