/**
 * The Scratchpad panel's shared rules (docs/scratchpad.md): a conversation's
 * scratchpad.md travels as a short content hash in its summary, and its
 * contents separately, keyed by that hash, so a client that holds them (in
 * memory or on disk) paints the card with the summary.
 */

import { createHash } from "node:crypto";

/** The most of a file a client is sent; longer files are cut to their last whole line within it. */
export const SCRATCHPAD_MAX_BYTES = 16 * 1024;

/** The hash summaries carry for `content` (12 hex digits). */
export function scratchpadHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
