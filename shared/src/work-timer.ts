import type { MessageMetadata } from "./messages";

export const WORK_TIMER_IDLE_BUFFER_MS = 5 * 60_000;

/** Carry completed work forward, but never charge the idle gap as work. */
export function continueWorkTimer(previous: MessageMetadata | null, startedAt: number): number {
  if (!previous || previous.endedAt == null) return startedAt;
  return resumeWorkTimer(previous.workTimerStartedAt ?? previous.startedAt, previous.endedAt, startedAt);
}

/** Resume a work timer that went idle at `idleSince`, never charging the idle gap. */
export function resumeWorkTimer(workTimerStartedAt: number, idleSince: number, resumedAt: number): number {
  const gap = resumedAt - idleSince;
  if (gap < 0 || gap >= WORK_TIMER_IDLE_BUFFER_MS) return resumedAt;
  return resumedAt - Math.max(0, idleSince - workTimerStartedAt);
}
