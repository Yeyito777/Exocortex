/**
 * Gruvbox theme — retro groove color scheme.
 *
 * Based on the Gruvbox dark palette by morhetz.
 * Warm, earthy tones on a dark background.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

// ── Gruvbox dark palette reference ───────────────────────────────
// BG:    #282828  #1d2021  #3c3836  #504945  #665c54
// FG:    #ebdbb2  #d5c4a1  #a89984  #928374
// Red:   #fb4934   Green:  #b8bb26   Yellow: #fabd2f
// Blue:  #83a598   Purple: #d3869b   Aqua:   #8ec07c
// Orange:#fe8019

export const gruvbox: Theme = {
  name: "gruvbox",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;254;128;25m`,     // #fe8019 (orange)
  text:     `${ESC}38;2;235;219;178m`,    // #ebdbb2 (foreground)
  muted:    `${ESC}38;2;146;131;116m`,    // #928374 (gray)
  error:    `${ESC}38;2;251;73;52m`,      // #fb4934 (red)
  warning:  `${ESC}38;2;250;189;47m`,     // #fabd2f (yellow)
  success:  `${ESC}38;2;184;187;38m`,     // #b8bb26 (green)
  prompt:   `${ESC}38;2;131;165;152m`,    // #83a598 (blue)
  tool:     `${ESC}38;2;211;134;155m`,    // #d3869b (purple)
  command:  `${ESC}38;2;142;192;124m`,    // #8ec07c (aqua)

  // Vim mode indicators
  vimNormal: `${ESC}38;2;131;165;152m`,   // #83a598 (blue)
  vimInsert: `${ESC}38;2;184;187;38m`,    // #b8bb26 (green)
  vimVisual: `${ESC}38;2;211;134;155m`,   // #d3869b (purple)

  // Background colors
  topbarBg:      `${ESC}48;2;254;128;25m`,    // #fe8019 (orange)
  userBg:        `${ESC}48;2;60;56;54m`,      // #3c3836 (bg1)
  sidebarBg:     `${ESC}48;2;40;40;40m`,      // #282828 (bg)
  sidebarSelBg:  `${ESC}48;2;80;73;69m`,      // #504945 (bg2)
  cursorBg:      `${ESC}48;2;250;189;47m`,    // #fabd2f (yellow)
  historyLineBg: `${ESC}48;2;60;56;54m`,      // #3c3836 (matches userBg)
  selectionBg:   `${ESC}48;2;80;73;69m`,      // #504945 (bg2)
  appBg:         `${ESC}48;2;29;32;33m`,      // #1d2021 (bg0 hard)
  cursorColor:   "#fabd2f",                   // yellow

  // Border colors
  borderFocused:   `${ESC}38;2;254;128;25m`,  // #fe8019 (orange)
  borderUnfocused: `${ESC}38;2;102;92;84m`,   // #665c54 (bg3)

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
