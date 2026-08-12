import { randomUUID } from "node:crypto";
import type { RenderState } from "../state";
import { focusPrompt } from "../state";
import { createStartingBtw } from "./state";

export interface BtwDaemonActions {
  startBtw(convId: string, sessionId: string, query: string, startedAt: number): void;
  closeBtw(convId: string, sessionId?: string): void;
}

/** Start an optimistic panel and issue the durable daemon mutation. */
export function startBtwSession(
  state: RenderState,
  daemon: BtwDaemonActions,
  query: string,
  createSessionId: () => string = randomUUID,
  now: () => number = Date.now,
): void {
  if (!state.convId) return;
  const sessionId = createSessionId();
  const startedAt = now();
  state.btw = createStartingBtw(
    state.convId,
    sessionId,
    query,
    state.provider,
    state.model,
    startedAt,
  );
  daemon.startBtw(state.convId, sessionId, query, startedAt);
}

/** Close optimistically; the replay layer retains the mutation until settlement. */
export function closeBtwSession(state: RenderState, daemon: BtwDaemonActions): void {
  const session = state.btw;
  if (!session) return;
  if (state.chatFocus === "btw") focusPrompt(state);
  state.btw = null;
  daemon.closeBtw(session.sourceConvId, session.sessionId);
}
