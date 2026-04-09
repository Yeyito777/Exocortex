/**
 * Cerberus theme — red accents on gray.
 *
 * Accent: #d32f2f (Material Red 700)
 * Gray backgrounds, red highlights, warm muted tones.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

export const cerberus: Theme = {
  name: "cerberus",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;211;47;47m`,     // #d32f2f
  text:     `${ESC}38;2;224;224;224m`,    // #e0e0e0
  muted:    `${ESC}38;2;102;102;102m`,    // #666666
  error:    `${ESC}38;2;244;67;54m`,      // #f44336
  warning:  `${ESC}38;2;255;167;38m`,     // #ffa726
  success:  `${ESC}38;2;102;187;106m`,    // #66bb6a
  prompt:   `${ESC}38;2;211;47;47m`,      // #d32f2f (red)
  tool:     `${ESC}38;2;176;100;100m`,    // #b06464 (muted rose)
  command:  `${ESC}38;2;239;154;154m`,    // #ef9a9a (light red)

  // Vim mode indicators
  vimNormal: `${ESC}38;2;211;47;47m`,     // #d32f2f (red)
  vimInsert: `${ESC}38;2;255;107;107m`,   // #ff6b6b (coral)
  vimVisual: `${ESC}38;2;183;28;28m`,     // #b71c1c (dark red)

  // Background colors
  topbarBg:      `${ESC}48;2;211;47;47m`,    // #d32f2f (red accent as bg)
  userBg:        `${ESC}48;2;37;37;37m`,     // #252525
  sidebarBg:     `${ESC}48;2;26;26;26m`,     // #1a1a1a
  sidebarSelBg:  `${ESC}48;2;51;51;51m`,     // #333333
  cursorBg:      `${ESC}48;2;211;47;47m`,    // #d32f2f (red)
  historyLineBg: `${ESC}48;2;37;37;37m`,     // #252525 (matches userBg)
  selectionBg:   `${ESC}48;2;74;74;74m`,     // #4a4a4a
  searchBg:      `${ESC}48;2;252;224;148m`,  // #fce094
  searchFg:      `${ESC}38;2;20;20;20m`,     // dark text on search
  appBg:         `${ESC}48;2;20;20;20m`,     // #141414
  cursorColor:   "#d32f2f",                  // matches accent / cursorBg

  // Border colors
  borderFocused:   `${ESC}38;2;211;47;47m`,  // #d32f2f (red)
  borderUnfocused: `${ESC}38;2;85;85;85m`,   // #555555

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
