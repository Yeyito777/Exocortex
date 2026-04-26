/**
 * Conversation title generation client shim.
 *
 * The daemon owns the actual LLM call, sanitization, persistence, and recovery.
 * The TUI only requests generation so disconnects cannot strand a title in the
 * persisted "pending" state.
 */

import type { DaemonClient } from "./client";
import type { RenderState } from "./state";

/** Placeholder title shown while daemon-owned generation is in-flight. */
export const PENDING_TITLE = "pending";

export function generateTitle(
  convId: string,
  _state: RenderState,
  daemon: DaemonClient,
  _scheduleRender: () => void,
): void {
  daemon.generateTitle(convId);
}
