import { randomUUID } from "node:crypto";
import type { RenderState } from "../state";
import { focusPrompt } from "../state";
import { appendStartingBtwFollowup, createStartingBtw } from "./state";

export interface BtwDaemonActions {
  startBtw(convId: string, sessionId: string, query: string, startedAt: number): void;
  followupBtw(convId: string, sessionId: string, turnId: string, query: string, startedAt: number): void;
  closeBtw(convId: string, sessionId?: string): void;
}

/** Start a panel, or append a follow-up when that conversation already owns one. */
export function startBtwSession(
  state: RenderState,
  daemon: BtwDaemonActions,
  query: string,
  createSessionId: () => string = randomUUID,
  now: () => number = Date.now,
): void {
  if (!state.convId) return;
  const startedAt = now();
  if (state.btw?.sourceConvId === state.convId) {
    const turnId = createSessionId();
    const sessionId = state.btw.sessionId;
    appendStartingBtwFollowup(state.btw, turnId, query, startedAt);
    daemon.followupBtw(state.convId, sessionId, turnId, query, startedAt);
    return;
  }
  const sessionId = createSessionId();
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
