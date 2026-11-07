# Scratchpad

Each conversation can keep a `scratchpad.md` in its workspace (its working
directory, `config/data/workspaces/<conversation-id>/`, see
[Conversation workspaces](conversation-workspaces.md)). Agents edit it with
their normal file tools; the TUI shows it read-only as a Scratchpad card in the
right-hand column, directly below the Tasks card (or at the column's top when
there is none). A missing or blank file shows no card. The `/scratchpad` macro
asks the agent to set one up; `/scratchpad update` and `/scratchpad clear` ask it to
bring it up to date or empty it.

## Writing it

It is a to-do list for the user, not a status board. Plain words, one line per
item, at most about eight open items. Leave out IDs, file paths, exact
timestamps, thresholds and your own schedules: Tasks already shows Chrono
wakes and running work. Tick items as they finish and drop done items after a
day.

```markdown
# Now
- [ ] Testing on live: E bids closer to the price, aiming for +$13/day
# Waiting on you
- [ ] OK bigger E orders (40 shares), ~+$10–15/day
```

## Format

A small markdown subset, one item per line:

| Line | Shown as |
|---|---|
| `# Heading` (`##`, `###`) | bold heading |
| `- [ ] item` | `○ item`, an open to-do |
| `- [x] item` | `✓ item`, dimmed; done items stay visible |
| `- item` | `• item` |
| anything else | a muted note |

`**text**` anywhere is shown in the warning colour, without the asterisks: use
it for urgent bits such as due times. Indented list items are nested. Blank
lines are dropped. The card's header counts the open `- [ ]` items, and shows
no count when the file has no checkboxes.

```markdown
# Today
- [ ] MAT: TQ3 prep **Wed 11:00**
- [x] ECO Writing 6
## Notes
Claude main renews Nov 8.
```

## In the TUI

Collapsed, the card shows one row per line, truncated, up to the same height
cap as Tasks, and a last row `▸ N more` counting the lines left out. A click
expands it to every line, wrapped, grown leftward like the Tasks card, and
scrolling with the wheel when it is taller than the pane; another click
collapses it. Expanding one of the two cards collapses the other. On a
terminal too narrow for the Tasks card, neither shows.

## How it gets there

Like Tasks, it rides on the conversation summaries, so the card paints with
the Tasks card, before any open, locally and over `/ssh` (the remote daemon's
file), on a fresh TUI start and when switching conversations:

- **The daemon** (`daemon/src/scratchpad.ts`) indexes every conversation's
  file: all of them at start, then a stat every second of the conversations
  a client follows (also `fs.watch`ed), running ones and ones that ran in the
  last 30 s, and of every workspace every 30 s. Only a changed stat reads the
  file, cut to the last whole line within 16 KB.
- **Summaries** carry a 12-hex-digit hash of the contents (`scratchpad`),
  absent for a missing or blank file. A change re-sends the summary like any
  other summary change.
- **Contents** travel apart, keyed by hash, only to clients that lack them:
  `scratchpads` in the bootstrap, ahead of the conversation list (the shown
  conversations first, then the most recent, up to 256 KB), and
  `scratchpad_updated` on a change (ahead of its summary) or on a subscribe.
  The TUI lists the hashes it holds in `client_capabilities`
  (`scratchpadHashes`).
- **The TUI** (`tui/src/scratchpadstore.ts`) keeps contents by hash in
  `config/runtime/scratchpad-cache.json` (512 entries, 2 MiB, least recently
  used out), so a fresh start paints from it with its first summaries (over
  `/ssh`, the cached sidebar list). The card shows the contents the summary's
  hash names, or nothing until they are here: never another version.

Measured on whale's daemon (Nov 7): 3884 conversations, a 1.97 MB sidebar
list; the 5 scratchpads add 140 bytes to it (28 per conversation that has
one) and 3.4 KB of contents to a bootstrap that lacks them, and nothing once
the TUI holds them.
