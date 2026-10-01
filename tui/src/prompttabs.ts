/** Prompt soft tabs stay as spaces so wrapping and terminal widths are explicit. */
import { nextGraphemeEnd, previousGraphemeStart } from "./graphemes";

export const PROMPT_TAB_WIDTH = 4;
export const PROMPT_TAB = " ".repeat(PROMPT_TAB_WIDTH);

/** Delete a whole soft tab when immediately before the cursor. */
export function promptDeleteStart(buffer: string, pos: number): number {
  return pos >= PROMPT_TAB_WIDTH && buffer.slice(pos - PROMPT_TAB_WIDTH, pos) === PROMPT_TAB
    ? pos - PROMPT_TAB_WIDTH
    : previousGraphemeStart(buffer, pos);
}

/** Delete a whole soft tab under the cursor, without splitting a grapheme. */
export function promptDeleteEnd(buffer: string, pos: number): number {
  const end = pos + PROMPT_TAB_WIDTH;
  return buffer.slice(pos, end) === PROMPT_TAB && nextGraphemeEnd(buffer, end - 1) === end
    ? end
    : nextGraphemeEnd(buffer, pos);
}
