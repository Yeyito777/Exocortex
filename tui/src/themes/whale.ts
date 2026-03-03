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
  text:     `${ESC}37m`,                 // white
  muted:    `${ESC}38;2;100;100;100m`,   // #646464
  error:    `${ESC}31m`,                 // red
  warning:  `${ESC}33m`,                 // yellow
  success:  `${ESC}32m`,                 // green
  prompt:   `${ESC}34m`,                 // blue
  tool:     `${ESC}35m`,                 // magenta

  // Background colors
  topbarBg: `${ESC}48;2;29;155;240m`,    // accent (#1d9bf0) as background
  userBg:   `${ESC}48;2;9;13;53m`,       // #090d35
};
