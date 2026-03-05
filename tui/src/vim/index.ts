/**
 * Vim module — public API.
 *
 * Re-exports the essential types and the processKey entry point.
 * Consumers import from here, never from internal files.
 */

export { processKey } from "./engine";
export { createVimState, resetPending } from "./types";
export { copyToClipboard, pasteFromClipboard } from "./clipboard";
export type { VimState, VimMode, VimContext, VimResult } from "./types";
