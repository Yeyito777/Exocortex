import type { MessageMetadata } from "./messages";

export const WORK_TIMER_IDLE_BUFFER_MS = 5 * 60_000;

/** Carry completed work forward, but never charge the idle gap as work. */
export function continueWorkTimer(previous: MessageMetadata | null, startedAt: number): number {
  if (!previous || previous.endedAt == null) return startedAt;
  const gap = startedAt - previous.endedAt;
  if (gap < 0 || gap >= WORK_TIMER_IDLE_BUFFER_MS) return startedAt;
  return startedAt - Math.max(0, previous.endedAt - (previous.workTimerStartedAt ?? previous.startedAt));
}
