# Macros

A macro is a slash word that the TUI replaces with longer text before a
message is sent, e.g. `/go` becomes "Go ahead and implement that". Macros work
anywhere in a message, autocomplete as you type, and are highlighted in the
prompt. The built-in ones live in [macros.ts](../tui/src/macros.ts).

## Your own macros

`/macro` adds, edits and deletes macros while the app is running, in one
prompt line:

```
/macro add /brief = Answer in one short sentence.
/macro add /brief Answer briefly = Answer in one short sentence.
/macro edit /brief = Two sentences at most.
/macro rm /brief
/macro undo
/macro            (or /macro list)
```

Everything after the first `=` is the macro's text, so the text may itself
contain `=`; Shift+Enter adds a line to it. Words between the name and `=`
are an optional description shown in autocomplete (without one, autocomplete
shows the start of the text). `/macro edit` keeps the description unless you
give a new one.

Leave out `=` to write the text in the centred editor that `/instructions`
uses: `/macro add /name [description]` opens it empty and `/macro edit /name`
opens it with the current text (`:w` saves, `:wq` saves and closes).

While you type, each part of the line has its own colour (name, description,
text) and a wrong part turns red once typing pauses: a name a built-in
command or macro already uses, an invalid name, an existing name for `add`,
an unknown one for `edit` or `rm`, or nothing after `=`. Dim text after the
cursor names what comes next. Above the prompt, one row shows the syntax with
the current part lit; a second shows the reason for a red part, the Tab
completions (subcommands, or your macros with their text for `edit` and
`rm`), or, once there is text after `=`, what the macro expands to.

Names start with `/` and use only letters, digits, `_` and `-` (at most 48
characters). They cannot reuse a built-in command, inline command or
built-in macro; if a later update adds a built-in with your macro's name, the
built-in wins and `/macro list` marks yours inactive. A macro's text is not
itself expanded again. `/macro undo` restores the macro this TUI last deleted.

## Where they are stored

Macros are saved by the daemon, in `config/macros.json` on the daemon's host,
and every TUI connected to that daemon sees a change at once. A TUI on a Mac
connected to the whale daemon over `/ssh` therefore uses whale's macros; the
Mac's own daemon keeps its own list. The file is plain JSON
(`{"version": 1, "macros": [{"name", "expansion", "description"?}]}`), may be
edited by hand, and is re-read on each connect and change.

Changes take effect in the TUI at once and are confirmed in the background
([usermacros/store.ts](../tui/src/usermacros/store.ts)), so over a slow
`/ssh` link nothing waits on a round trip. If the daemon refuses a change, it
is undone with a notice and the command goes back into the prompt. A change
made while the link is down is checked against the daemon's list after
reconnecting: sent if it still applies, dropped if it already landed, and
reported if the macro changed elsewhere meanwhile.
