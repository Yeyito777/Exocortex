# Scroll regions

When the conversation pane scrolls by a few rows (wheel, `j`/`k`, `Ctrl+u`/`Ctrl+d`,
following streamed output), the TUI tells the terminal to move that band of
rows and draws only the rows the move exposed, instead of repainting the pane.
That sends far fewer bytes (cheaper scrolling over `/ssh`), and a terminal that
animates region scrolls, such as st's smooth-scroll branch, can glide.

## Switch

On by default. To turn it off, set this in `config/config.json` and restart the
TUI:

```json
{ "tui": { "scrollRegions": false } }
```

Off restores the earlier behaviour byte for byte: region scrolls only while the
history spans the full width with no images or overlays on screen, done with
LF/RI.

## How a frame is flushed

`tui/src/frame.ts` keeps the previous frame's row payloads. When the scrolled
band is unchanged, it looks for how far the content moved (at most the band
height minus 3 rows): first by how far the first visible history line moved,
then, if that explains nothing, by the rows themselves (the shift that explains
at least 60% of the rows that changed). The second check matters when the
line's index jumps while the content moves by one step: older history pages
arriving over `/ssh`, or more history laid out above the view. Before it,
every page arrival was a full repaint, including the last one at the top. When
a shift is found, the frame is, inside one synchronized update (mode 2026):

1. `CSI top;bottom r` (DECSTBM for the message rows), `CSI n S` or `CSI n T`
   (SU/SD), `CSI r`. The Linux console has no SU/SD, so with `TERM=linux` the
   scroll is LF at the bottom margin or RI at the top margin instead.
2. Rows whose content did not arrive with the scroll (exposed rows, the cursor
   line highlight, reflow beside the Tasks panel) are drawn in full; other
   rows' changes go through the normal row diff.
3. Image placements are sent again (see below).

Bigger jumps (Page Up/Down, `gg`/`G`, search jumps), resizes, theme changes and
other full repaints draw rows as before.

### Sidebar

st, like most terminals, has no left/right margins (DECLRMM), so a region
scroll moves the sidebar's columns along with the history. Each row payload
records its sidebar segment (`RenderFrame.pinned`), and rows are compared
without it. After the scroll, rows whose history moved intact get only their
sidebar segment drawn again (about 120 bytes a row in a truecolor theme, skipped where the
sidebar row is the same), all in the same synchronized frame, so the terminal
never shows a displaced sidebar. This works on every terminal, unlike margins.
### Floating elements

The scrolled band is the longest run of message rows that no floating element
touches: the Tasks panel and the row under it (the rows beside it reflow),
autocomplete, the queue and edit prompts, the sidebar's conversation menu, the
image viewer, the accounts screen and `/instructions`. Rows beside one are drawn
in place. A terminal that animates region scrolls therefore glides only rows
that really moved; with the Tasks panel inside the band, st glided the panel
along with the history and it tore. The search bar and BTW panel sit below the
message area and do not limit the band.

### Images

Kitty placements are anchored to a cell. st and kitty move them with a region
scroll and drop those whose anchor row scrolls out; other terminals may not
move them at all. After a region scroll the TUI therefore places every visible
image again (`a=p` with the same ids replaces a placement; image data is not
sent again), so the result is the same on every terminal. Images that left the
view are deleted as usual.

## Bytes

Measured in st (190×52, whale theme, 40 distinct sidebar titles, markdown
history with images), average bytes per scroll step:

| Scroll | Sidebar | Before | Now |
| --- | --- | --- | --- |
| 1 row | open | 8,004 | 5,168 |
| 3 rows | open | 7,816 | 5,545 |
| 1 row | closed, images in view | 3,906 | 200 |
| mixed 1–5 rows | closed, images in view | 3,856 | 304 |

With the sidebar open almost all of what remains is the sidebar's own rows
(about 120 bytes each in a truecolor theme). Terminal left/right margins
(DECLRMM) would remove that, and would keep a smooth-scrolling terminal from
gliding the sidebar along with the history; st does not support them yet.

## Tests

`tui/src/render-scrollregions.test.ts` checks the emitted bytes and, with the
VT model in `tui/src/testhelpers/terminalscreen.ts` (DECSTBM, SU/SD, LF/RI,
Kitty placements moving and dropping like st), that the screen after any
scroll sequence equals a full repaint, with the sidebar open or closed, beside
the Tasks panel, and with images.
