/**
 * Paper theme — dark brown ink on warm vanilla paper.
 *
 * The only light theme. Everything sits on one sheet of paper; raised
 * surfaces are the same stock a shade darker, never a different hue, and the
 * colours are inks rather than lights: each is dark enough to read as body
 * text, and none is brighter than the page.
 *
 * Paper (backgrounds, light to dark)
 *   #f6eedb  page            app, terminal default
 *   #f0e5cc  card            sidebar, menus, Tasks / Scratchpad cards
 *   #ebe0c5  raised          your messages, selected history line
 *   #e6e2cf  raised, cool    automated messages (same weight, greyer)
 *   #e6d9b9  inset           inline code
 *   #e0d1ad  pressed         sidebar selection
 *   #d9c69d  kraft           top bar, visual selection
 *   #f3d266  highlighter     search matches
 *
 * Rules
 *   #c9b895  pencil          unfocused borders, code gutter
 *   #8a6740  sepia           focused borders
 *
 * Ink (contrast on the page)
 *   #35291f  ink             text                          12.2
 *   #5b4632  heading         card headings                  7.7
 *   #6b5a46  faded           dim / folded text              5.7
 *   #726049  pencil grey     muted labels, comments         5.2
 *
 * Coloured inks
 *   #27598c  blue            accent, links, working         6.3
 *   #3d6e33  green           done / unread                  5.2
 *   #8a5d00  ochre           waiting, warnings              5.0
 *   #a6311f  red             errors, unread badge           5.9
 *   #7a4a8c  violet          goal, visual mode, keywords    5.7
 *   #1f6a72  teal            insert mode, types             5.4
 *   #a34a1c  rust            numbers, removed lines         5.1
 *
 * Tool colours come from the daemon as pastels for dark themes; they are
 * darkened to at least 4.5 on the page (`minToolContrast`).
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(";");
const fg = (hex: string) => `${ESC}38;2;${rgb(hex)}m`;
const bg = (hex: string) => `${ESC}48;2;${rgb(hex)}m`;

const PAGE = "#f6eedb";
const CARD = "#f0e5cc";
const RAISED = "#ebe0c5";
const RAISED_COOL = "#e6e2cf";
const INSET = "#e6d9b9";
const PRESSED = "#e0d1ad";
const KRAFT = "#d9c69d";
const HIGHLIGHTER = "#f3d266";

const PENCIL_RULE = "#c9b895";
const SEPIA = "#8a6740";

const INK = "#35291f";
const HEADING = "#5b4632";
const FADED = "#6b5a46";
const PENCIL = "#726049";

const BLUE = "#27598c";
const GREEN = "#3d6e33";
const OCHRE = "#8a5d00";
const RED = "#a6311f";
const VIOLET = "#7a4a8c";
const TEAL = "#1f6a72";
const RUST = "#a34a1c";

export const paper: Theme = {
  name: "paper",
  previewColors: [BLUE, SEPIA, PAGE],

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      fg(FADED),   // a colour: SGR faint would darken ink on paper
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   fg(BLUE),
  link:     fg(BLUE),
  text:     fg(INK),
  muted:    fg(PENCIL),
  error:    fg(RED),
  warning:  fg(OCHRE),
  success:  fg(GREEN),
  goal:     fg(VIOLET),
  prompt:   fg(BLUE),
  tool:     fg(VIOLET),
  command:  fg(TEAL),

  // Vim mode indicators
  vimNormal: fg(BLUE),
  vimInsert: fg(TEAL),
  vimVisual: fg(VIOLET),

  // Background colors
  topbarBg:        bg(KRAFT),
  userBg:          bg(RAISED),
  automatedUserBg: bg(RAISED_COOL),
  sidebarBg:       bg(CARD),
  sidebarSelBg:    bg(PRESSED),
  cursorBg:        bg(INK),
  historyLineBg:   bg(RAISED),
  selectionBg:     bg(KRAFT),
  searchBg:        bg(HIGHLIGHTER),
  searchFg:        fg(INK),
  notificationBg:  bg(RED),
  notificationFg:  fg(PAGE),
  appBg:           bg(PAGE),
  cursorColor:     INK,

  // Border colors
  borderFocused:   fg(SEPIA),
  borderUnfocused: fg(PENCIL_RULE),

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,

  // The terminal's own defaults: uncoloured text is ink, the window is paper
  terminalFg: INK,
  terminalBg: PAGE,
  minToolContrast: 4.5,

  // Surfaces the dark themes share
  cursorFg:      fg(PAGE),
  heading:       fg(HEADING),
  panelBg:       bg(CARD),
  inlineCodeBg:  bg(INSET),
  topbarDim:     fg("#6a5940"),   // ink sunk into the kraft bar

  // Code blocks
  codeText:      fg(INK),
  codeGutter:    fg(PENCIL_RULE),
  codeLabel:     fg(PENCIL),
  synKeyword:    fg(VIOLET),
  synString:     fg(GREEN),
  synComment:    fg(PENCIL),
  synNumber:     fg(RUST),
  synType:       fg(TEAL),
  synFunction:   fg(BLUE),
  synOperator:   fg(HEADING),
  synPunct:      fg(FADED),

  // Model ladder
  ladderLight:   fg("#c25e14"),   // a step up arrives ember-orange and cools to ink
  ladderRefused: fg(RED),
};
