# Scroll regions

When the conversation pane scrolls by a few rows (wheel, `j`/`k`, `Ctrl+u`/`Ctrl+d`,
following streamed output), the TUI tells the terminal to move that band of
rows and draws only the rows the move exposed, instead of repainting the pane.
That sends far fewer bytes (cheaper scrolling over `/ssh`). On st the TUI also
animates the scroll itself (below).

## App-driven smooth scrolling

On a terminal that supports st's mode 2032 (`~/Config/st`
`docs/app-smooth-scroll.md`), the TUI animates scrolls itself instead of
leaving the glide to the terminal. At startup it asks with DECRQM
(`CSI ? 2032 $ p`) and, if supported, turns the mode on (`CSI ? 2032 h`; off
on exit). `tui/src/smoothscroll.ts` then:

- turns each scroll into one eased move that st times itself at the
  display's refresh rate (`OSC 2032 ; m`: the step, plus an easing term that
  cancels it at first and eases out over 100 ms, st's `smoothscroll_ms`
  feel). Inputs mid-glide add up. Nothing is sent between rows, so pty or ssh
  jitter never shows as judder. The animation sits at layout time, not in
  the input handlers, so every way of scrolling glides: wheel,
  `Ctrl+u`/`Ctrl+d`/`Ctrl+e`/`Ctrl+y`/`Ctrl+b`/`Ctrl+f`, `j`/`k` at the
  edge, `gg`/`G` and search jumps (those glide in from one screen away);
- keeps the same curve, and lays the history out at the whole row 30 ms
  ahead of it in the direction of travel, but never more than the row just
  past it (laid out a quarter row early, so st's clock, a little behind,
  never reaches the laid-out rows; the TUI wakes when the next row is due
  rather than polling), so the offset st draws stays within about a row however fast
  inputs stack up (laid out further ahead, rows that re-wrap beside the Tasks
  panel were drawn several rows from where they belong, leaving a dark band
  below the panel during fast scrolls). Each row is a normal frame: a
  region scroll plus the rows it exposed or re-wrapped (the text beside the
  Tasks panel re-wraps a row at a time), with the matching base change in
  the same synchronized update;
- declares the moving rectangles (`OSC 2032 ; r`): the history columns of the
  band, and with the Tasks panel open, the columns left of it for the full
  height plus the panel's columns from the row below it. The sidebar and the
  panel never move;
- while a glide runs, places images that reach the band's last row
  uncropped below it, so the part leaving at the bottom keeps showing (st
  clips images to the moving rectangles while they move), and crops them
  again with one more frame when the glide ends; st keeps the rows of images
  leaving through the top. At rest images are placed exactly as without
  smooth scrolling;
- glides content that moved by itself only when it is output arriving at
  the bottom while following it (see below).

Only scrolling glides: the wheel or trackpad, scroll keys, history-cursor
motions, `gg`/`G` and search jumps mark the change as the user's
(`markScrollIntent`). Everything else that moves the offset or the content
snaps without any motion: re-layouts that keep the user's place (Ctrl+I /
Ctrl+O, the sidebar or Tasks panel changing the pane's width, a resize, a turn
finishing, rows re-wrapping), pinning while scrolled up, a jump to the bottom
after sending, a different conversation, and frames that had to be repainted.
Content that moves by itself glides only when the bottom grows or shrinks
while following it (output arriving, the live Working block or its latest
step changing height), both ways: every row the region scroll moved arrived
intact (the two rows above the newly exposed ones aside, for the previous
message's footer). Explicit re-layouts mark themselves (`markRelayout`:
Ctrl+I / Ctrl+O, the sidebar, a resize, a history reload, frames anchored to
a row) and snap even when what they change sits at the bottom. `tui/src/smoothscroll-relayout.test.ts` checks each case.

Other terminals, and `tui.scrollRegions: false`, keep the behaviour described
below. The rows beside the Tasks panel then stay out of the band.

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
