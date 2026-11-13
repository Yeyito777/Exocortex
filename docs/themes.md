# Themes

`/theme` shows the current theme and the choices; `/theme <name>` switches at
once, with no restart, and saves the choice as `theme` in `config/config.json`.

| Theme | |
|---|---|
| `whale` | The default: blue on near-black |
| `cerberus` | Red on gray |
| `tonikawa` | Rose pink on plum-charcoal |
| `paper` | Light: dark brown ink on warm vanilla paper, kraft top bar, ink-coloured accents |

A theme is one file in `tui/src/themes/`, registered in `tui/src/theme.ts`.
Every colour the TUI draws comes from the active theme; nothing else holds a
colour.

## Slots

`BaseTheme` in `tui/src/theme.ts` is what every theme sets: text, muted and
accent colours, the activity colours (`accent` working, `warning` waiting,
`success` unread or done, `error`), message bubbles, sidebar, selection, search,
borders.

`ThemeSurfaces` are colours the dark themes share (`DARK_SURFACES`): code block
text and syntax colours, the inline-code tint, card background, card headings,
the text under the inline cursor, dim text on the top bar and the model
ladder's glow. A theme overrides them only when the shared ones cannot work on
its background.

## Light themes

`paper` is the only one so far. Three things differ from a dark theme:

- **`dim` is a colour.** The dark themes use SGR faint. st draws faint by
  halving the colour, which on a light background makes text darker, so a
  light theme gives `dim` a faded foreground colour. Code that uses
  `theme.dim` writes it after the colour it fades and ends it with `reset` or
  a colour, never SGR 22.
- **The terminal's defaults follow the theme.** A theme with `terminalFg` and
  `terminalBg` sets the terminal's default foreground and background (OSC
  10/11) while it is active, next to the cursor colour (OSC 12):
  `tui/src/terminaltheme.ts`. Text drawn without a colour, the character under
  the terminal's cursor and the window's padding all use those defaults. The
  TUI asks the terminal for its own colours at startup and puts them back by
  value when it exits or a theme without them is chosen, because st on macOS
  does not implement the reset sequences.
- **Tool colours are darkened.** Each tool's label colour comes from the
  daemon as a pastel picked for dark backgrounds. With `minToolContrast` set,
  `toolColor` darkens the same hue until it reaches that contrast on
  `terminalBg`.

## Adding a theme

Copy the closest theme file, set every `BaseTheme` slot, register it in
`themes` in `tui/src/theme.ts`, and add it to the table above. For a light
theme also set the terminal defaults, `minToolContrast` and every
`ThemeSurfaces` slot, and check it against `tui/src/theme.test.ts`: body text
at least 7:1 on every surface, dim, muted and coloured text at least 4.5:1,
and the three activity colours in clearly different hues. Then look at it in a
real terminal: `/theme <name>` in a test TUI (see
[Test daemons](dev-daemons.md)).

Folder icons, the mute bell and other emoji are drawn by the terminal's emoji
font and keep their own colours in every theme.
