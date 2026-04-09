/**
 * Whale theme — the default Exocortex palette.
 *
 * Accent: #1d9bf0 (Twitter blue)
 * Dark background, muted grays, clean contrast.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

export const whale: Theme = {
  name: "whale",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;29;155;240m`,   // #1d9bf0
  text:     `${ESC}38;2;255;255;255m`,    // #ffffff
  muted:    `${ESC}38;2;100;100;100m`,   // #646464
  error:    `${ESC}31m`,                 // red
  warning:  `${ESC}33m`,                 // yellow
  success:  `${ESC}38;2;80;200;120m`,    // #50c878 green
  prompt:   `${ESC}34m`,                 // blue
  tool:     `${ESC}35m`,                 // magenta
  command:  `${ESC}38;2;174;214;254m`,   // #aed6fe

  // Vim mode indicators
  vimNormal: `${ESC}38;2;72;202;228m`,    // #48cae4
  vimInsert: `${ESC}38;2;46;196;182m`,    // #2ec4b6
  vimVisual: `${ESC}38;2;199;146;234m`,   // #c792ea (purple)

  // Background colors
  topbarBg:      `${ESC}48;2;29;155;240m`,    // accent (#1d9bf0) as background
  userBg:        `${ESC}48;2;9;13;53m`,       // #090d35
  sidebarBg:     `${ESC}48;2;3;8;20m`,        // #030814
  sidebarSelBg:  `${ESC}48;2;15;25;60m`,      // #0f193c
  cursorBg:      `${ESC}48;2;72;202;228m`,    // #48cae4 (matches vimNormal)
  historyLineBg: `${ESC}48;2;9;13;53m`,     // #090d35 (matches userBg)
  selectionBg:   `${ESC}48;2;79;82;88m`,    // #4f5258
  searchBg:      `${ESC}48;2;252;224;148m`, // #fce094
  searchFg:      `${ESC}38;2;0;5;15m`,      // #00050f
  appBg:         `${ESC}48;2;0;5;15m`,      // #00050f
  cursorColor:   "#48cae4",                 // matches vimNormal / cursorBg

  // Border colors
  borderFocused:   `${ESC}38;2;28;148;229m`,  // #1c94e5
  borderUnfocused: `${ESC}38;2;85;85;85m`,    // #555555

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
