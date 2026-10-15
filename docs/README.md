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
- [/proxy: another machine's provider login](provider-proxy.md)
- [Several Claude accounts](claude-accounts.md)
- [Goals](goals.md)
- [Delegation models](delegation-models.md)
- [External call adapters and realtime delegation](external-call-adapters.md)
- [Local links](local-links.md)
- [Inline images](inline-images.md)
- [Update status](update-status.md)
- [Network outages](network-outages.md)

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
| `Ctrl+P` / `Ctrl+Shift+O` | New conversation (in the open folder; with `/folders tree`, `Ctrl+P` uses the sidebar cursor's folder and `Ctrl+Shift+O` the top level) |
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
| `g a` | In normal mode (prompt, history or sidebar), open the Accounts screen |
| `/new` | Start a new conversation |
| `/folders tree` / `navigate` | Expand sidebar folders in place (`l` expands, `h` collapses, `Enter` toggles) or open them as their own list |
| `/model <provider> <model>` | Switch provider/model |
| `/model openai gpt-6-sol-daybreak` | Select Sol Daybreak Blue when advertised by the connected account |
| `/trim <mode> <n>` | Trim old context |
| `/accounts` | Accounts screen: every Claude and OpenAI account, its sign-in, usage and conversations (needs more than one account) |
| `/quit` | Exit |

In prompt normal mode, `3>>` shifts three lines once. In visual modes, shifts
apply to every selected logical line and return to normal mode. Shifts support
undo/redo; outdenting removes at most four leading spaces without removing text.
