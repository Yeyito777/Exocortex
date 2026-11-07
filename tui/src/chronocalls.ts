/**
 * Chrono sleeps and waits in progress in the focused conversation, by the
 * tool call that started them. Their collapsed line counts up (`12m of 45m`)
 * from the Chrono task the daemon publishes for each, connected or suspended.
 */

import { formatChronoProgress, msUntilChronoProgressChange, type ChronoCallProgress } from "@exocortex/shared/chrono";
import type { RenderState } from "./state";

const CHRONO_CALL_TASK_PREFIXES = ["chrono:sleep:", "chrono:wait:"];

/** Started and due instants of each running Chrono sleep or wait, by tool call id. */
export function liveChronoCalls(state: Pick<RenderState, "convId" | "sidebar">): Map<string, Omit<ChronoCallProgress, "now">> {
  const calls = new Map<string, Omit<ChronoCallProgress, "now">>();
  if (!state.convId) return calls;
  const conversation = state.sidebar?.conversations.find(candidate => candidate.id === state.convId);
  for (const task of conversation?.tasks ?? []) {
    if (task.kind !== "chrono" || (task.chronoMode !== "sleep" && task.chronoMode !== "wait") || task.dueAt === undefined) continue;
    const prefix = CHRONO_CALL_TASK_PREFIXES.find(candidate => task.id.startsWith(candidate));
    if (prefix) calls.set(task.id.slice(prefix.length), { startedAt: task.startedAt, dueAt: task.dueAt });
  }
  return calls;
}

/** Each running call's progress text at `now`, by tool call id: what its line shows. */
export function liveChronoProgressTexts(
  calls: ReadonlyMap<string, Omit<ChronoCallProgress, "now">>,
  now = Date.now(),
): Map<string, string> {
  const texts = new Map<string, string>();
  for (const [id, call] of calls) texts.set(id, formatChronoProgress({ ...call, now }));
  return texts;
}

/** One key for every running call's progress text: equal keys draw equal lines. */
export function liveChronoFrame(state: Pick<RenderState, "convId" | "sidebar">, now = Date.now()): string {
  let frame = "";
  for (const [id, text] of liveChronoProgressTexts(liveChronoCalls(state), now)) frame += `${id}\u0000${text}\u0001`;
  return frame;
}

/** Milliseconds until a running call's line changes, or null when none runs. */
export function msUntilLiveChronoChange(state: Pick<RenderState, "convId" | "sidebar">, now = Date.now()): number | null {
  let next: number | null = null;
  for (const call of liveChronoCalls(state).values()) {
    const delay = msUntilChronoProgressChange({ ...call, now });
    if (delay !== null) next = Math.min(next ?? delay, delay);
  }
  return next;
}
