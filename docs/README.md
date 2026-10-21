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
- [Local links](local-links.md)
- [Inline images](inline-images.md)
- [Next-message suggestions (experimental)](next-message-suggestions.md)
- [Macros](macros.md)
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
| `Right Shift` / `→` / normal-mode `Tab` | Put the next-message suggestion (experimental ghost text in the empty prompt) into the prompt |
| `Tab` | In prompt insert mode, complete a popup/path or insert a four-space soft tab |
| `Backspace` / `Delete` | Remove an adjacent four-space soft tab in one press |
| `>>` / `<<` | Shift prompt lines right / left by four spaces |
| `{` / `}` | In chat normal mode, focus history and jump among user-message starts |
| `[` / `]` | In chat normal mode, focus history and jump among final AI-response text blocks |
| `;` | In history visual mode, quote selection into the draft |
| `;` / right click | On a sidebar conversation or folder, open its actions menu (a folder's starts on Edit instructions) |
| `g a` | In normal mode (prompt, history or sidebar), open the Accounts screen |

In prompt normal mode, `3>>` shifts three lines once. In visual modes, shifts
apply to every selected logical line and return to normal mode. Shifts support
undo/redo; outdenting removes at most four leading spaces without removing text.

## Instructions

Instructions are not shown in the chat. `/instructions` opens a picker of the
three scopes: **Conversation** (this chat only), **Folder** (every chat in the
conversation's folder; `;` or a right click on a sidebar folder, then Edit
instructions, opens it directly) and
**Global** (every conversation). Each row shows the first
line and size, or `empty`. `j`/`k` (or `1`–`3`) choose, `Enter` edits, `Esc`
closes.

The editor is a centred card with the prompt's Vim keys (insert, normal, visual,
motions, operators, undo/redo). `:w` or `Ctrl+S` saves, `:wq`/`:x` saves and
closes, `:q` closes (refused with unsaved changes), `:q!` discards; `Esc` in
normal mode closes, asking once more when there are unsaved changes. Saving an
empty document clears that scope. Global saves are refused if `config/system.md`
changed since it was opened; `:w!` overwrites it.

Global instructions are two files, sent in this order: `config/system.base.md`,
the tracked upstream base every install gets, and `config/system.md`, this
install's own additions, which git ignores. The Global editor edits only
`config/system.md` and shows the base above it, read-only, under its own rule.
Agents edit the base only when the user explicitly asks; edits made through
`/instructions` (or by agents to `config/system.md`) stay on this machine. Edits
to either file apply to the next request without a restart. On start the daemon
removes sections of `config/system.md` that are identical to a base section (left
over from when it held the base too), after copying it to
`config/system.md.pre-split-<time>.bak`; sections you changed are kept.

Everything acts locally first, so it feels the same over `/ssh`: the TUI keeps
each scope's text (fetched in the background once a conversation has been open
a second, and kept current by the daemon's update events), the picker shows it
at once and re-checks it in the background, and saves update the preview and
close straight away while the daemon write follows. A save is sent only when
the TUI knows the daemon still has the text the edit started from; otherwise it
waits for a check and fails rather than write over newer text. A failed save
puts the old text back on the picker row with the reason (or, when the modal is
closed, a notice in the chat); `Enter` on that scope brings the unsaved text
back. If the link drops before a save is confirmed, the TUI reads the scope back
after reconnecting: the save is kept if it landed, sent again if the old text is
still there, and failed (text kept) if it changed elsewhere meanwhile.

## Slash commands

`/help` lists the same commands; the registry in
[commands.ts](../tui/src/commands.ts) is authoritative, and a test keeps this
table in step with it.

| Command | Action |
|---|---|
| `/help` | List the commands |
| `/quit` / `/exit` | Exit |
| `/new` | Start a new conversation |
| `/account [<openai-email>]` / `/account claude [add <name> [config-dir] \| remove <name>]` | List or switch OpenAI accounts; list, add or remove Claude accounts ([Claude accounts](claude-accounts.md)) |
| `/accounts` | Accounts screen: every Claude and OpenAI account with its state and usage (needs more than one account; also `g a`) |
| `/replay` | Run the assistant again on the history as it stands, without a new message; `/queue [target] /replay` defers it |
| `/btw <query>` / `/btw close` | Ask a read-only aside in a side panel, or close it |
| `/compact` | Compact the context now; `/queue [target] /compact` defers it. For Claude Code this starts a fresh session from the checkpoint |
| `/rename [title]` | Rename the conversation, or generate a title |
| `/model [<provider> [<model>]]` | Show or switch provider/model, e.g. `/model openai gpt-6-sol-daybreak` when the account advertises it |
| `/default-model [current \| reset \| <provider> <model> <effort> <fast>]` | Show or set the defaults for new conversations |
| `/trim [messages\|thinking\|toolresults <n>]` | Trim old context; a resumed Claude Code session keeps it, so use `/compact` there |
| `/effort [level]` | Show or set reasoning effort; also a prompt modifier |
| `/fast [on\|off]` / `/ultrafast [on\|off]` | Toggle OpenAI's fast or ultrafast tier; also prompt modifiers |
| `/queue [conversation\|folder\|duration]` | In a message or before `/replay`/`/compact`: send once the scope is idle or the delay passes |
| `/goal [pause\|resume\|complete\|clear\|max-time <duration>] [objective]` | Set or manage a persistent goal ([Goals](goals.md)) |
| `/chrono list\|cancel\|in\|at\|every …` | Schedule a message or shell command ([Chrono](chrono.md)) |
| `/convo` | Copy the conversation's title, id, model and dates to the clipboard |
| `/tokens [days]` / `/tokens models\|providers\|sources [days]` / `/tokens cost` | Context meter and usage windows for the open conversation, then token heatmap, totals, breakdowns or API-cost estimates |
| `/usage reset` | Spend an earned OpenAI usage-limit reset |
| `/time [n]` | Timestamp of the latest (or nth-latest) chat message |
| `/diagnostics [on\|off]` | Show output-token counts in response metadata |
| `/theme [name]` | Show or set the theme |
| `/folders [tree\|navigate]` | Expand sidebar folders in place (`l` expands, `h` collapses, `Enter` toggles) or open them as their own list |
| `/hide [on\|off]` | Censor emails in the UI |
| `/ping [sound\|notif\|both [file] \| off]` | Signal when a response finishes |
| `/ssh [<alias>\|cancel]` | Route through another machine's daemon over SSH |
| `/proxy [<openai\|anthropic> <alias\|off>]` | Send one provider's model requests through another machine's login ([/proxy](provider-proxy.md)) |
| `/instructions [text\|clear]` | Open the instructions picker and editor for this conversation, its folder or every conversation ([Instructions](#instructions)); with text, set or clear this conversation's |
| `/system` | Show the system prompt (for Claude Code, what Exocortex appends) |
| `/macro add /name [description] = text` / `/macro [list \| edit /name \| rm /name \| undo]` | Add, edit, delete or list your own macros ([Macros](macros.md)) |
| `/login [provider [...]]` | Show login status or sign in to a provider |
| `/logout <provider>` | Log out of a provider |
