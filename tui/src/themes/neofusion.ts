/**
 * Neofusion theme — cyberpunk neon on deep ocean.
 *
 * Based on the Neofusion color scheme by diegoulloao.
 * Electric blues and warm accents on an ultra-dark navy background.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

// ── Neofusion palette reference ──────────────────────────────────
// BG:      #070f1c  #030a14  #1a2747  #0d1829
// FG:      #e0d9c7  #a6adc8  #395577
// Blue:    #35b5ff   Cyan:   #66def9   Teal:   #22d3ee
// Red:     #fd5e3a   Orange: #f6955b   Yellow: #e8d27f
// Green:   #5cff9d   Purple: #a855f7

export const neofusion: Theme = {
  name: "neofusion",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;53;181;255m`,     // #35b5ff (blue)
  text:     `${ESC}38;2;224;217;199m`,    // #e0d9c7 (foreground)
  muted:    `${ESC}38;2;57;85;119m`,      // #395577 (comment)
  error:    `${ESC}38;2;253;94;58m`,      // #fd5e3a (red)
  warning:  `${ESC}38;2;232;210;127m`,    // #e8d27f (yellow)
  success:  `${ESC}38;2;92;255;157m`,     // #5cff9d (green)
  prompt:   `${ESC}38;2;102;222;249m`,    // #66def9 (cyan)
  tool:     `${ESC}38;2;168;85;247m`,     // #a855f7 (purple)
  command:  `${ESC}38;2;34;211;238m`,     // #22d3ee (teal)

  // Vim mode indicators
  vimNormal: `${ESC}38;2;53;181;255m`,    // #35b5ff (blue)
  vimInsert: `${ESC}38;2;92;255;157m`,    // #5cff9d (green)
  vimVisual: `${ESC}38;2;168;85;247m`,    // #a855f7 (purple)

  // Background colors
  topbarBg:      `${ESC}48;2;53;181;255m`,    // #35b5ff (blue)
  userBg:        `${ESC}48;2;13;24;41m`,      // #0d1829 (bg light)
  sidebarBg:     `${ESC}48;2;7;15;28m`,       // #070f1c (bg)
  sidebarSelBg:  `${ESC}48;2;26;39;71m`,      // #1a2747 (selection)
  cursorBg:      `${ESC}48;2;102;222;249m`,   // #66def9 (cyan)
  historyLineBg: `${ESC}48;2;13;24;41m`,      // #0d1829 (matches userBg)
  selectionBg:   `${ESC}48;2;26;39;71m`,      // #1a2747 (selection)
  appBg:         `${ESC}48;2;3;10;20m`,       // #030a14 (bg dark)
  cursorColor:   "#66def9",                   // cyan

  // Border colors
  borderFocused:   `${ESC}38;2;53;181;255m`,  // #35b5ff (blue)
  borderUnfocused: `${ESC}38;2;57;85;119m`,   // #395577 (comment)

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
