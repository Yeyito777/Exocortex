/** Ghost text after the cursor of a /macro line (see ./guide for its content). */
import { truncateToWidth } from "../textwidth";
import { theme } from "../theme";

function clean(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "");
}

/** Ghost text that fits after `usedCols` columns of a `width`-column prompt line. */
export function fitGhostText(ghost: string, usedCols: number, width: number): string {
  const room = width - usedCols - 1;
  if (!ghost || room < 2) return "";
  return theme.dim + theme.italic + truncateToWidth(clean(ghost), room) + theme.italicOff + theme.reset;
}
