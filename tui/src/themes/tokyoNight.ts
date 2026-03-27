/**
 * Tokyo Night theme — a clean dark theme with vivid accents.
 *
 * Based on the Tokyo Night color scheme by Enkia.
 * Storm variant: deep blue backgrounds with pastel neon accents.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

// ── Tokyo Night palette reference ────────────────────────────────
// BG:       #1a1b26  #16161e  #24283b  #283457
// FG:       #a9b1d6  #c0caf5  #565f89  #414868
// Red:      #f7768e   Orange: #ff9e64   Yellow: #e0af68
// Green:    #9ece6a   Cyan:   #7dcfff   Blue:   #7aa2f7
// Purple:   #bb9af7   Teal:   #2ac3de

export const tokyoNight: Theme = {
  name: "tokyoNight",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;122;162;247m`,    // #7aa2f7 (blue)
  text:     `${ESC}38;2;169;177;214m`,    // #a9b1d6 (foreground)
  muted:    `${ESC}38;2;86;95;137m`,      // #565f89 (comment)
  error:    `${ESC}38;2;247;118;142m`,    // #f7768e (red)
  warning:  `${ESC}38;2;224;175;104m`,    // #e0af68 (yellow)
  success:  `${ESC}38;2;158;206;106m`,    // #9ece6a (green)
  prompt:   `${ESC}38;2;125;207;255m`,    // #7dcfff (cyan)
  tool:     `${ESC}38;2;187;154;247m`,    // #bb9af7 (purple)
  command:  `${ESC}38;2;42;195;222m`,     // #2ac3de (teal)

  // Vim mode indicators
  vimNormal: `${ESC}38;2;122;162;247m`,   // #7aa2f7 (blue)
  vimInsert: `${ESC}38;2;158;206;106m`,   // #9ece6a (green)
  vimVisual: `${ESC}38;2;187;154;247m`,   // #bb9af7 (purple)

  // Background colors
  topbarBg:      `${ESC}48;2;122;162;247m`,   // #7aa2f7 (blue)
  userBg:        `${ESC}48;2;36;40;59m`,      // #24283b (bg highlight)
  sidebarBg:     `${ESC}48;2;26;27;38m`,      // #1a1b26 (bg)
  sidebarSelBg:  `${ESC}48;2;40;52;87m`,      // #283457 (selection)
  cursorBg:      `${ESC}48;2;125;207;255m`,   // #7dcfff (cyan)
  historyLineBg: `${ESC}48;2;36;40;59m`,      // #24283b (matches userBg)
  selectionBg:   `${ESC}48;2;40;52;87m`,      // #283457 (selection)
  appBg:         `${ESC}48;2;22;22;30m`,      // #16161e (bg dark)
  cursorColor:   "#7dcfff",                   // cyan

  // Border colors
  borderFocused:   `${ESC}38;2;122;162;247m`, // #7aa2f7 (blue)
  borderUnfocused: `${ESC}38;2;65;72;104m`,   // #414868 (dark fg)

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
