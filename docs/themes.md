# Themes

`/theme [name]` shows or sets the theme; the choice is saved as `theme` in
`config/config.json`. Typing `/theme ` lists them with a three-colour swatch.

| Theme | Look |
|---|---|
| `whale` (default) | Blue on near-black |
| `cerberus` | Red on grey |
| `tonikawa` | Rose on plum-charcoal |
| `paper` | Blue-black ink on a white page: the light theme |

A theme is one file in `tui/src/themes/`, an object of the `Theme` type
(`tui/src/theme.ts`), listed in `themes` there. Every colour the TUI draws comes
from the active theme; nothing else holds a colour of its own. The dark themes
share their code colours (`themes/codedark.ts`).

## Paper

Stationery rather than parchment. The page is a warm white and the text is
blue-black fountain-pen ink; the rest is what sits on a desk:

| Thing | Colour | Used for |
|---|---|---|
| Page | `#f5f2eb` | Background, also the terminal's own |
| Ink | `#1d1f26` | Text; the top bar is a band of it with page-coloured text |
| Blue pen | `#2447b8` | Accent: focus rules, prompt, cursor, usage bars |
| Graphite | `#85827a` | Muted labels |
| Red pencil | `#c0342b` | Errors, the unread badge |
| Highlighter | `#ffe14d` | Search matches |
| Blue wash | `#e6ebf7` | Your messages |
| Sticky note | `#f2ecd3` | Automated messages |

Code is set in inks dark enough to read as text: violet keywords, green
strings, rust numbers, teal types, blue functions, graphite comments.

## What a light theme needs

`light: true` and three things follow from it. A new light theme gets them by
setting the same fields.

- **The terminal's default colours.** `terminalFg` / `terminalBg` are sent as
  OSC 10 / 11 on start and on `/theme`, so text the TUI leaves uncoloured is
  ink and st's padding around the cells is page, not black. They are given
  back on exit, or on a switch to a theme without them. The TUI asks the
  terminal for its own colours once at start (`OSC 10;?` and so on) and puts
  them back by value, followed by the reset (OSC 110 / 111): st on macOS
  ignores the resets. The cursor colour (OSC 12) goes the same way.
- **Faint text.** st draws SGR 2 as the colour at half brightness, which on a
  light page is darker than the text around it. `tui/src/lightfaint.ts` reads
  every frame on its way out, as the terminal would, and replaces SGR 2 with
  the text's colour mixed toward the background it sits on (`FAINT_MIX`). Code
  keeps writing `theme.dim` as before; dark themes are not touched.
- **Colours from elsewhere.** Tool colours come from the daemon and from
  external tools, chosen for a dark background. `inkAnsi(hex)` returns them
  unchanged on a dark theme and, on a light one, scaled toward black with the
  hue kept until they reach 4.5:1 on the page. Use it for any colour the theme
  did not pick.

Known gap, in st on Linux and not in the TUI: its GPU renderer repaints the
2-pixel padding only on a resize or a smooth scroll, so after `/theme` or on
exit the padding keeps the previous colour until then.

A light theme must not use the 16 palette colours (`\x1b[31m` and the like):
the terminal's palette is tuned for a dark page. `tui/src/theme.test.ts` checks
that, and that every ink reads on the page.

## Looking at a theme

Run the worktree's TUI in a nested desktop, never on the host:

```bash
dwm start themes
dwm -e themes run -- st -e bash -lc 'cd <worktree> && scripts/dev/exotest <worktree-name>'
dwm -e themes screenshot -o /tmp/theme.png
```
