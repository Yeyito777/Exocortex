/**
 * Nord theme — arctic, north-bluish palette.
 *
 * Based on the Nord color scheme (nordtheme.com).
 * Frost blues and aurora accents on polar night backgrounds.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

// ── Nord palette reference ────────────────────────────────────────
// Polar Night:  #2e3440  #3b4252  #434c5e  #4c566a
// Snow Storm:   #d8dee9  #e5e9f0  #eceff4
// Frost:        #8fbcbb  #88c0d0  #81a1c1  #5e81ac
// Aurora:       #bf616a  #d08770  #ebcb8b  #a3be8c  #b48ead

export const nord: Theme = {
  name: "nord",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;136;192;208m`,    // #88c0d0 (frost cyan)
  text:     `${ESC}38;2;216;222;233m`,    // #d8dee9 (snow storm)
  muted:    `${ESC}38;2;76;86;106m`,      // #4c566a (polar night bright)
  error:    `${ESC}38;2;191;97;106m`,     // #bf616a (aurora red)
  warning:  `${ESC}38;2;235;203;139m`,    // #ebcb8b (aurora yellow)
  success:  `${ESC}38;2;163;190;140m`,    // #a3be8c (aurora green)
  prompt:   `${ESC}38;2;129;161;193m`,    // #81a1c1 (frost blue)
  tool:     `${ESC}38;2;180;142;173m`,    // #b48ead (aurora purple)
  command:  `${ESC}38;2;143;188;187m`,    // #8fbcbb (frost teal)

  // Vim mode indicators
  vimNormal: `${ESC}38;2;129;161;193m`,   // #81a1c1 (frost blue)
  vimInsert: `${ESC}38;2;163;190;140m`,   // #a3be8c (aurora green)
  vimVisual: `${ESC}38;2;180;142;173m`,   // #b48ead (aurora purple)

  // Background colors
  topbarBg:      `${ESC}48;2;94;129;172m`,    // #5e81ac (frost dark blue)
  userBg:        `${ESC}48;2;59;66;82m`,      // #3b4252 (polar night light)
  sidebarBg:     `${ESC}48;2;46;52;64m`,      // #2e3440 (polar night origin)
  sidebarSelBg:  `${ESC}48;2;67;76;94m`,      // #434c5e (polar night brighter)
  cursorBg:      `${ESC}48;2;136;192;208m`,   // #88c0d0 (frost cyan)
  historyLineBg: `${ESC}48;2;59;66;82m`,      // #3b4252 (matches userBg)
  selectionBg:   `${ESC}48;2;67;76;94m`,      // #434c5e (polar night brighter)
  appBg:         `${ESC}48;2;46;52;64m`,      // #2e3440 (polar night origin)
  cursorColor:   "#88c0d0",                   // frost cyan

  // Border colors
  borderFocused:   `${ESC}38;2;129;161;193m`, // #81a1c1 (frost blue)
  borderUnfocused: `${ESC}38;2;76;86;106m`,   // #4c566a (polar night bright)

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
