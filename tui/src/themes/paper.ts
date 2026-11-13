/**
 * Paper theme — blue-black ink on a sheet of paper. The light theme.
 *
 * Stationery, not parchment: the page is a warm white, text is the blue-black
 * of fountain-pen ink, and everything else is something you would find on a
 * desk. Blue pen is the accent, red pencil marks errors, graphite is the
 * muted grey, a yellow highlighter marks search matches, your own messages
 * sit on a blue wash and automated ones on a sticky note.
 *
 * Colours here are hex, turned into escapes by `fg` / `bg`.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

function channels(hex: string): string {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(";");
}
const fg = (hex: string) => `${ESC}38;2;${channels(hex)}m`;
const bg = (hex: string) => `${ESC}48;2;${channels(hex)}m`;

const PAGE = "#f5f2eb";      // the sheet
const INK = "#1d1f26";       // blue-black ink
const BLUE = "#2447b8";      // blue pen
const GRAPHITE = "#85827a";  // pencil

export const paper: Theme = {
  name: "paper",
  previewColors: [BLUE, "#c0342b", PAGE],
  light: true,

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   fg(BLUE),
  link:     fg("#1e5bc6"),    // a lighter blue than the pen
  text:     fg(INK),
  muted:    fg(GRAPHITE),
  error:    fg("#c0342b"),    // red pencil
  warning:  fg("#9b5c00"),    // amber
  success:  fg("#2c7a4b"),    // green ink
  goal:     fg("#7c4dbb"),    // violet ink
  prompt:   fg(BLUE),
  tool:     fg("#0f766e"),    // teal ink
  command:  fg("#2f55cc"),

  // Vim mode indicators
  vimNormal: fg(BLUE),
  vimInsert: fg("#1f7a5c"),
  vimVisual: fg("#7c4dbb"),

  // Background colors
  topbarBg:        bg("#23252d"),
  topbarFg:        fg("#fbfaf6"),
  userBg:          bg("#e6ebf7"),   // blue wash
  automatedUserBg: bg("#f2ecd3"),   // sticky note
  sidebarBg:       bg("#ece9e0"),
  sidebarSelBg:    bg("#d8e0f3"),
  cursorBg:        bg(BLUE),
  cursorFg:        fg(PAGE),
  historyLineBg:   bg("#ebe7dd"),
  selectionBg:     bg("#c8d6f4"),
  searchBg:        bg("#ffe14d"),   // highlighter
  searchFg:        fg(INK),
  notificationBg:  bg("#c0342b"),
  notificationFg:  fg("#ffffff"),
  appBg:           bg(PAGE),
  panelBg:         bg(PAGE),
  cursorColor:     BLUE,
  terminalFg:      INK,
  terminalBg:      PAGE,

  // Border colors
  borderFocused:   fg(BLUE),
  borderUnfocused: fg("#c7c2b6"),

  // Code
  codeBg:      bg("#e8e4d9"),
  codeText:    fg(INK),
  codeGutter:  fg("#cbc6ba"),
  codeLabel:   fg("#a09c91"),
  synKeyword:  fg("#7b3fb0"),
  synString:   fg("#2f7d3b"),
  synComment:  fg("#89857b"),
  synNumber:   fg("#a84e14"),
  synType:     fg("#0e7482"),
  synFunction: fg("#1e5bc6"),
  synOperator: fg("#56657a"),
  synPunct:    fg("#6d6a62"),

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
