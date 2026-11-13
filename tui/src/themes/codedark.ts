/**
 * Code colours the dark themes share: light pastels on a dark page.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

export const darkCode: Pick<Theme,
  | "codeBg" | "codeText" | "codeGutter" | "codeLabel"
  | "synKeyword" | "synString" | "synComment" | "synNumber"
  | "synType" | "synFunction" | "synOperator" | "synPunct"
> = {
  codeBg:      `${ESC}48;2;22;32;48m`,     // #162030 subtle tint for inline code
  codeText:    `${ESC}38;2;255;255;255m`,  // #ffffff
  codeGutter:  `${ESC}38;2;55;65;80m`,     // #374150
  codeLabel:   `${ESC}38;2;80;90;105m`,    // #505a69
  synKeyword:  `${ESC}38;2;199;146;234m`,  // #c792ea soft purple
  synString:   `${ESC}38;2;195;232;141m`,  // #c3e88d warm green
  synComment:  `${ESC}38;2;95;105;120m`,   // #5f6978 muted gray
  synNumber:   `${ESC}38;2;247;140;108m`,  // #f78c6c warm orange
  synType:     `${ESC}38;2;137;221;255m`,  // #89ddff soft cyan
  synFunction: `${ESC}38;2;130;170;255m`,  // #82aaff soft blue
  synOperator: `${ESC}38;2;137;221;255m`,  // #89ddff cyan
  synPunct:    `${ESC}38;2;180;180;180m`,  // #b4b4b4 light gray
};
