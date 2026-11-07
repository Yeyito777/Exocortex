# Scratchpad

Each conversation can keep a `scratchpad.md` in its workspace (its working
directory, `config/data/workspaces/<conversation-id>/`, see
[Conversation workspaces](conversation-workspaces.md)). Agents edit it with
their normal file tools; the TUI shows it read-only as a Scratchpad card in the
right-hand column, directly below the Tasks card (or at the column's top when
there is none). A missing or blank file shows no card.

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

The daemon watches the file of each conversation a client with the
`scratchpad` capability is subscribed to (`daemon/src/scratchpad.ts`):
`fs.watch` on the workspace, debounced, plus a stat every second. It sends
`scratchpad_updated` (`convId`, `content`) when the client subscribes and
whenever the contents change; `content` is null for a missing or blank file
and is cut to the last whole line within 16 KB. Over `/ssh` the file is the
remote daemon's; with `/proxy` tools run locally, so it is this machine's.
