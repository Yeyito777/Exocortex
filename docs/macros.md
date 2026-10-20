# Macros

A macro is a slash word that the TUI replaces with longer text before a
message is sent, e.g. `/go` becomes "Go ahead and implement that". Macros work
anywhere in a message, autocomplete as you type, and are highlighted in the
prompt. The built-in ones live in [macros.ts](../tui/src/macros.ts).

## Your own macros

`/macro` adds, edits and deletes macros while the app is running; no restart.

| Command | Action |
|---|---|
| `/macro` or `/macro list` | Your macros with their descriptions, then the built-in names |
| `/macro add /name [description]` | The prompt line becomes the macro's text: type it (several lines are fine), Enter saves, Enter on an empty prompt cancels |
| `/macro edit /name [description]` | The same, prefilled with the current text; a new description replaces the old one |
| `/macro rm /name` (or `delete`) | Delete it; `/macro undo` restores the last one this TUI deleted |

Lines typed below the `/macro add` or `/macro edit` line save at once, so a
whole macro also fits in one multi-line prompt. Without a description,
autocomplete shows the start of the text.

Names start with `/` and use only letters, digits, `_` and `-` (at most 48
characters). They cannot reuse a built-in command, inline command or
built-in macro; if a later update adds a built-in with your macro's name, the
built-in wins and `/macro list` marks yours inactive. A macro's text is not
itself expanded again.

## Where they are stored

Macros are saved by the daemon, in `config/macros.json` on the daemon's host,
and every TUI connected to that daemon sees a change at once. A TUI on a Mac
connected to the whale daemon over `/ssh` therefore uses whale's macros; the
Mac's own daemon keeps its own list. The file is plain JSON
(`{"version": 1, "macros": [{"name", "expansion", "description"?}]}`), may be
edited by hand, and is re-read on each connect and change.
