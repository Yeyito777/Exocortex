/**
 * Dracula theme — a dark theme with vibrant colors.
 *
 * Based on the Dracula color scheme (draculatheme.com).
 * Deep purplish backgrounds with bold, high-contrast accents.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

// ── Dracula palette reference ────────────────────────────────────
// BG:       #282a36   Current Line: #44475a   Selection: #44475a
// FG:       #f8f8f2   Comment:      #6272a4
// Cyan:     #8be9fd   Green:   #50fa7b   Orange: #ffb86c
// Pink:     #ff79c6   Purple:  #bd93f9   Red:    #ff5555
// Yellow:   #f1fa8c

export const dracula: Theme = {
  name: "dracula",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;189;147;249m`,    // #bd93f9 (purple)
  text:     `${ESC}38;2;248;248;242m`,    // #f8f8f2 (foreground)
  muted:    `${ESC}38;2;98;114;164m`,     // #6272a4 (comment)
  error:    `${ESC}38;2;255;85;85m`,      // #ff5555 (red)
  warning:  `${ESC}38;2;241;250;140m`,    // #f1fa8c (yellow)
  success:  `${ESC}38;2;80;250;123m`,     // #50fa7b (green)
  prompt:   `${ESC}38;2;139;233;253m`,    // #8be9fd (cyan)
  tool:     `${ESC}38;2;255;121;198m`,    // #ff79c6 (pink)
  command:  `${ESC}38;2;255;184;108m`,    // #ffb86c (orange)

  // Vim mode indicators
  vimNormal: `${ESC}38;2;189;147;249m`,   // #bd93f9 (purple)
  vimInsert: `${ESC}38;2;80;250;123m`,    // #50fa7b (green)
  vimVisual: `${ESC}38;2;255;121;198m`,   // #ff79c6 (pink)

  // Background colors
  topbarBg:      `${ESC}48;2;189;147;249m`,   // #bd93f9 (purple)
  userBg:        `${ESC}48;2;68;71;90m`,      // #44475a (current line)
  sidebarBg:     `${ESC}48;2;40;42;54m`,      // #282a36 (bg)
  sidebarSelBg:  `${ESC}48;2;68;71;90m`,      // #44475a (selection)
  cursorBg:      `${ESC}48;2;139;233;253m`,   // #8be9fd (cyan)
  historyLineBg: `${ESC}48;2;68;71;90m`,      // #44475a (matches userBg)
  selectionBg:   `${ESC}48;2;68;71;90m`,      // #44475a (selection)
  appBg:         `${ESC}48;2;33;34;44m`,      // #21222c (darker bg)
  cursorColor:   "#8be9fd",                   // cyan

  // Border colors
  borderFocused:   `${ESC}38;2;189;147;249m`, // #bd93f9 (purple)
  borderUnfocused: `${ESC}38;2;98;114;164m`,  // #6272a4 (comment)

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
