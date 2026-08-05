/**
 * Tonikawa theme — soft pink accents on muted plum-charcoal.
 *
 * Accent: #e47fac (rose pink)
 * Warm dark backgrounds, dusty highlights, gentle contrast.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

export const tonikawa: Theme = {
  name: "tonikawa",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors
  accent:   `${ESC}38;2;228;127;172m`,   // #e47fac
  text:     `${ESC}38;2;238;233;237m`,   // #eee9ed
  muted:    `${ESC}38;2;141;128;138m`,   // #8d808a
  error:    `${ESC}38;2;224;108;117m`,   // #e06c75
  warning:  `${ESC}38;2;214;166;93m`,    // #d6a65d
  success:  `${ESC}38;2;135;182;149m`,   // #87b695
  prompt:   `${ESC}38;2;228;127;172m`,   // #e47fac (rose pink)
  tool:     `${ESC}38;2;185;154;216m`,   // #b99ad8 (dusty lavender)
  command:  `${ESC}38;2;240;175;201m`,   // #f0afc9 (light blush)

  // Vim mode indicators
  vimNormal: `${ESC}38;2;228;127;172m`,  // #e47fac (rose pink)
  vimInsert: `${ESC}38;2;130;185;170m`,  // #82b9aa (muted mint)
  vimVisual: `${ESC}38;2;185;154;216m`,  // #b99ad8 (dusty lavender)

  // Background colors
  topbarBg:       `${ESC}48;2;169;67;113m`,    // #a94371 (deep rose)
  userBg:         `${ESC}48;2;33;26;33m`,      // #211a21
  sidebarBg:      `${ESC}48;2;23;19;26m`,      // #17131a
  sidebarSelBg:   `${ESC}48;2;48;35;49m`,      // #302331
  cursorBg:       `${ESC}48;2;228;127;172m`,   // #e47fac (matches accent)
  historyLineBg:  `${ESC}48;2;33;26;33m`,      // #211a21 (matches userBg)
  selectionBg:    `${ESC}48;2;80;55;73m`,      // #503749
  searchBg:       `${ESC}48;2;216;181;111m`,   // #d8b56f
  searchFg:       `${ESC}38;2;26;21;25m`,      // #1a1519
  notificationBg: `${ESC}48;2;169;67;113m`,    // #a94371
  notificationFg: `${ESC}38;2;255;247;251m`,   // #fff7fb
  appBg:          `${ESC}48;2;19;17;22m`,      // #131116
  cursorColor:    "#e47fac",                   // matches accent / cursorBg

  // Border colors
  borderFocused:   `${ESC}38;2;228;127;172m`, // #e47fac (rose pink)
  borderUnfocused: `${ESC}38;2;101;91;99m`,   // #655b63

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
