import type { ConversationSummary, ConversationTaskSummary } from "./messages";
import { parseDurationMs } from "./duration";

/** A fixed-period Chrono repeat (minutes or hours). */
export interface IntervalRecurrence {
  kind: "interval";
  everyMs: number;
  anchorAt: number;
}

/** A day/week/month Chrono repeat that keeps its wall-clock time in `timezone`. */
export interface CalendarRecurrence {
  kind: "calendar";
  unit: "day" | "week" | "month";
  interval: number;
  timezone: string;
  hour: number;
  minute: number;
  second: number;
  anchorDate: string;
  /** 0 = Sunday. */
  weekdays?: number[];
  dayOfMonth?: number;
}

export interface CronRecurrence {
  /** Legacy migration compatibility. New model-created schedules are structured. */
  kind: "cron";
  expression: string;
}

export type ChronoRecurrence = IntervalRecurrence | CalendarRecurrence | CronRecurrence;

/**
 * Chrono sleeps and waits longer than this suspend the model turn: a native
 * provider turn ends and resumes by replay, while a Claude Code turn, which
 * Exocortex cannot suspend, stays open inside the call. Either way the turn is
 * sleeping rather than working.
 */
export const LONG_CHRONO_SLEEP_THRESHOLD_MS = 5 * 60 * 1_000;

/** Whether a Chrono task is the conversation's own turn sleeping or waiting. */
export function isTurnChronoSleep(task: ConversationTaskSummary): boolean {
  return task.kind === "chrono" && (task.chronoMode === "sleep" || (
    task.chronoMode === "wait" && task.id.startsWith("chrono:wait:")
  ));
}

/**
 * Start of the Chrono sleeps or waits past the suspension threshold that a
 * still streaming turn is blocked in, or null. sleepsOnly: the work timer's
 * question, which waits never pause (a wait for work in progress is work).
 *
 * Claude Code runs these inside the call because Exocortex cannot suspend its
 * turn, so the conversation keeps streaming while it is really sleeping.
 */
export function inlineLongSleepStartedAt(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
  options: { sleepsOnly?: boolean } = {},
): number | null {
  if (!conversation.streaming) return null;
  let startedAt: number | null = null;
  for (const task of conversation.tasks ?? []) {
    if (!isTurnChronoSleep(task) || (options.sleepsOnly && task.chronoMode !== "sleep") || task.dueAt === undefined
        || task.dueAt - task.startedAt <= LONG_CHRONO_SLEEP_THRESHOLD_MS) continue;
    startedAt = Math.min(startedAt ?? task.startedAt, task.startedAt);
  }
  return startedAt;
}

/** The short form of a Chrono schedule id that `/chrono` shows and accepts. */
export function chronoShortId(id: string): string {
  return id.replace(/^chrono:/, "").slice(0, 8);
}

/** Longest `what` a Chrono line shows; a longer one is cut with an ellipsis. */
export const CHRONO_WHAT_MAX_CHARS = 80;

const CHRONO_UNIT_TARGET_PREFIX = "unit:";
/** Words that name no target by themselves ("waiting on the task"). */
const CHRONO_WHAT_FILLER = /\b(?:a|an|the|task|tasks|id|unit|wait|waiting|for|on|until|sleep|sleeping|agent|subagent|conversation|job|process)\b/giu;
/** Daemon conversation and task ids, e.g. 1794036663304-sr0sel. */
const CHRONO_ID_TOKEN = /\b\d{10,}-[a-z0-9]{4,}\b/giu;

/** The systemd unit a `unit:NAME` wait target names, or null for any other target. */
export function chronoUnitTargetName(taskId: string): string | null {
  return taskId.startsWith(CHRONO_UNIT_TARGET_PREFIX) ? taskId.slice(CHRONO_UNIT_TARGET_PREFIX.length).trim() || null : null;
}

function chronoWaitTargetId(input: Record<string, unknown>): string {
  return typeof input.task_id === "string" ? input.task_id.trim() : "";
}

/**
 * A Chrono sleep or wait's `what` on one line, or null when it is missing,
 * blank, or says nothing beyond the target's id.
 */
export function chronoWhat(input: Record<string, unknown>): string | null {
  if (typeof input.what !== "string") return null;
  const what = input.what.replace(/\s+/g, " ").trim();
  if (!what) return null;
  const taskId = chronoWaitTargetId(input);
  let rest = what;
  for (const id of [taskId, chronoUnitTargetName(taskId)]) if (id) rest = rest.split(id).join(" ");
  rest = rest.replace(CHRONO_ID_TOKEN, " ").replace(CHRONO_WHAT_FILLER, " ");
  if (!/[\p{L}\p{N}]/u.test(rest)) return null;
  return what.length > CHRONO_WHAT_MAX_CHARS ? `${what.slice(0, CHRONO_WHAT_MAX_CHARS - 1).trimEnd()}…` : what;
}

/** A span such as 45m, 2h 30m or 1m 20s: its two largest units, whole `unit`s only. */
export function formatChronoSpan(durationMs: number, unit: "s" | "m" = "s"): string {
  const unitMs = unit === "m" ? 60_000 : 1_000;
  const whole = Math.max(0, Math.floor(durationMs / unitMs)) * unitMs;
  const parts: string[] = [];
  let rest = whole;
  for (const [suffix, ms] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const) {
    if (ms < unitMs) break;
    const count = Math.floor(rest / ms);
    rest -= count * ms;
    if (count > 0 || parts.length > 0) parts.push(`${count}${suffix}`);
  }
  const shown = parts.filter((part, index) => index < 2 && !(index === 1 && part.startsWith("0")));
  return shown.length > 0 ? shown.join(" ") : `0${unit}`;
}

/** Where a running Chrono sleep or wait is: started and due instants, and now. */
export interface ChronoCallProgress {
  startedAt: number;
  dueAt: number;
  now: number;
}

/**
 * Shorter sleeps and waits count seconds; longer ones count whole minutes,
 * so their line changes once a minute.
 */
const CHRONO_PROGRESS_SECONDS_BELOW_MS = 2 * 60_000;

/** `12m of 45m` for a running Chrono sleep or wait. */
export function formatChronoProgress({ startedAt, dueAt, now }: ChronoCallProgress): string {
  const total = Math.max(0, dueAt - startedAt);
  const unit = total < CHRONO_PROGRESS_SECONDS_BELOW_MS ? "s" : "m";
  return `${formatChronoSpan(Math.min(total, Math.max(0, now - startedAt)), unit)} of ${formatChronoSpan(total)}`;
}

/** Milliseconds until a running Chrono sleep or wait's progress text changes, or null once it is due. */
export function msUntilChronoProgressChange({ startedAt, dueAt, now }: ChronoCallProgress): number | null {
  if (now >= dueAt) return null;
  const unitMs = dueAt - startedAt < CHRONO_PROGRESS_SECONDS_BELOW_MS ? 1_000 : 60_000;
  const elapsed = Math.max(0, now - startedAt);
  return Math.min(dueAt - now, unitMs - (elapsed % unitMs));
}

/**
 * A Chrono sleep or wait's line after the tool's label: `head` (`wait: `,
 * `waiting on `), then `what` (emphasized), then `meta` (`up to 45m`,
 * `12m of 45m`), which is shown after a ` · `.
 */
export interface ChronoCallLine {
  head: string;
  what: string;
  meta: string;
}

/**
 * How a Chrono sleep or wait reads. A wait whose `what` is unusable names its
 * target by `subject` (resolved by the daemon when the call was made), its
 * unit, or else its raw id. `progress` is set while the call is running.
 */
export function chronoCallLine(
  input: Record<string, unknown>,
  options: { subject?: string; progress?: ChronoCallProgress } = {},
): ChronoCallLine | null {
  const { progress } = options;
  const action = input.action;
  if (action === "wait") {
    const taskId = chronoWaitTargetId(input);
    const what = chronoWhat(input) ?? (options.subject?.trim() || chronoUnitTargetName(taskId) || taskId);
    const maxWaitMs = parseDurationMs(input.max_wait);
    const meta = progress ? formatChronoProgress(progress) : maxWaitMs !== null ? `up to ${formatChronoSpan(maxWaitMs)}` : "";
    return { head: progress ? "waiting on " : "wait: ", what, meta };
  }
  if (action === "sleep") {
    const what = chronoWhat(input) ?? "";
    const durationMs = parseDurationMs(input.duration);
    const span = durationMs !== null ? formatChronoSpan(durationMs) : "";
    if (progress) return { head: what ? "sleeping: " : "sleeping", what, meta: formatChronoProgress(progress) };
    return what ? { head: "sleep: ", what, meta: span } : { head: span ? `sleep: ${span}` : "sleep", what: "", meta: "" };
  }
  return null;
}

/** A Chrono line as plain text: `wait: arm A research agent · up to 45m`. */
export function chronoCallLineText(line: ChronoCallLine): string {
  return `${line.head}${line.what}${line.meta ? ` · ${line.meta}` : ""}`;
}
