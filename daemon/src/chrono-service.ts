/**
 * Chrono's durable daemon-owned scheduler.
 *
 * Conversation targets are hard wakes: they enqueue a model turn. Command
 * targets are soft wakes: they run without a model and may escalate to a hard
 * wake when the command fails (or whenever the configured condition requests).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import { agentWorkingDirectory } from "@exocortex/shared/config";
import * as convStore from "./conversations";
import { setChronoTaskActive } from "./conversation-activity";
import { onConversationRemoved, onConversationRemoving } from "./conversation-lifecycle";
import { log } from "./log";
import { evaluateToolCallSafety, formatSafetyBlock } from "./safety";
import { executeBashBackgroundable } from "./tools/bash";
import { ensureConversationWorkspace } from "./workspace-service";

const STATE_VERSION = 1;
const MAX_TIMER_MS = 2_000_000_000;
const MAX_COMMAND_OUTPUT_IN_WAKE = 8_000;
export const LONG_CHRONO_SLEEP_THRESHOLD_MS = 5 * 60 * 1_000;
const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export type ChronoMode = "wait" | "sleep" | "wake";

export interface IntervalRecurrence {
  kind: "interval";
  everyMs: number;
  anchorAt: number;
}

export interface CalendarRecurrence {
  kind: "calendar";
  unit: "day" | "week" | "month";
  interval: number;
  timezone: string;
  hour: number;
  minute: number;
  second: number;
  anchorDate: string;
  weekdays?: number[];
  dayOfMonth?: number;
}

export interface CronRecurrence {
  /** Legacy migration compatibility. New model-created schedules are structured. */
  kind: "cron";
  expression: string;
}

export type ChronoRecurrence = IntervalRecurrence | CalendarRecurrence | CronRecurrence;

export interface ConversationWakeTarget {
  kind: "conversation";
  conversationId: string;
  message: string;
}

export interface CommandHardWake {
  conversationId: string;
  when: "failure" | "always";
  message: string;
  includeOutput: boolean;
}

export interface CommandWakeTarget {
  kind: "command";
  command: string;
  timeoutMs: number;
  hardWake?: CommandHardWake;
}

export type ChronoTarget = ConversationWakeTarget | CommandWakeTarget;

export interface ChronoSchedule {
  id: string;
  ownerConversationId?: string;
  title: string;
  createdAt: number;
  nextAt: number;
  recurrence?: ChronoRecurrence;
  target: ChronoTarget;
  source?: "model" | "legacy-cron";
  /** Ephemeral list projection; omitted from persisted schedule records. */
  status?: "scheduled" | "pending" | "running";
}

interface PendingOccurrence {
  id: string;
  scheduleId: string;
  title: string;
  dueAt: number;
  ownerConversationId?: string;
  target: ChronoTarget;
  source?: "model" | "legacy-cron";
  retryAt?: number;
  commandResult?: { failed: boolean; output: string };
}

interface ChronoStateFile {
  version: 1;
  updatedAt: number;
  schedules: ChronoSchedule[];
  pending: PendingOccurrence[];
  /** Deferred tool results for sleep calls that intentionally ended their provider turn. */
  sleeps?: DeferredChronoSleep[];
}

export interface DeferredChronoSleep {
  id: string;
  conversationId: string;
  toolCallId: string;
  startedAt: number;
  dueAt: number;
  durationMs: number;
  state: "sleeping" | "resuming";
  resumedAt?: number;
  resumeReason?: "elapsed" | "user_message";
  retryAt?: number;
}

export interface DeferChronoSleepInput {
  conversationId: string;
  toolCallId: string;
  startedAt: number;
  durationMs: number;
}

export interface RepeatInput {
  unit: "minute" | "hour" | "day" | "week" | "month";
  interval?: number;
  weekdays?: string[];
}

export interface CreateScheduleInput {
  ownerConversationId: string;
  at?: string;
  afterSeconds?: number;
  repeat?: RepeatInput;
  timezone?: string;
  message?: string;
  command?: string;
  title?: string;
  timeoutSeconds?: number;
  hardWake?: {
    when?: "failure" | "always";
    message?: string;
    includeOutput?: boolean;
  };
}

export interface AdoptScheduleInput {
  scheduleId: string;
  ownerConversationId: string;
  hardWake?: {
    when?: "failure" | "always";
    message?: string;
    includeOutput?: boolean;
  };
}

type ConversationChanged = (conversationId: string) => void;
type DeferredSleepReady = (sleep: DeferredChronoSleep) => Promise<void> | void;

const schedules = new Map<string, ChronoSchedule>();
const pending = new Map<string, PendingOccurrence>();
const deferredSleeps = new Map<string, DeferredChronoSleep>();
const processing = new Set<string>();
const processingSleeps = new Set<string>();
const activeCommandControllers = new Map<string, AbortController>();
const cancelledOccurrences = new Set<string>();
let changedListener: ConversationChanged | null = null;
let deferredSleepReadyListener: DeferredSleepReady | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let processingDue = false;
let unregisterConversationRemoval: (() => void) | null = null;
let unregisterConversationRemoving: (() => void) | null = null;

function statePath(): string {
  return join(dataDir(), "chrono.json");
}

function ensureDataDir(): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
}

function snapshotState(): ChronoStateFile {
  return {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    schedules: [...schedules.values()],
    pending: [...pending.values()],
    sleeps: [...deferredSleeps.values()],
  };
}

function persist(): void {
  ensureDataDir();
  const path = statePath();
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(snapshotState(), null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTarget(value: unknown): value is ChronoTarget {
  if (!isRecord(value)) return false;
  if (value.kind === "conversation") {
    return typeof value.conversationId === "string" && typeof value.message === "string";
  }
  if (value.kind !== "command" || typeof value.command !== "string" || !Number.isFinite(value.timeoutMs)) return false;
  return true;
}

function validSchedule(value: unknown): value is ChronoSchedule {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.title === "string"
    && Number.isFinite(value.createdAt)
    && Number.isFinite(value.nextAt)
    && validTarget(value.target);
}

function validPending(value: unknown): value is PendingOccurrence {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.scheduleId === "string"
    && typeof value.title === "string"
    && Number.isFinite(value.dueAt)
    && validTarget(value.target);
}

function validDeferredSleep(value: unknown): value is DeferredChronoSleep {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.conversationId === "string"
    && typeof value.toolCallId === "string"
    && Number.isFinite(value.startedAt)
    && Number.isFinite(value.dueAt)
    && Number.isFinite(value.durationMs)
    && (value.state === "sleeping" || value.state === "resuming")
    && (value.resumeReason === undefined || value.resumeReason === "elapsed" || value.resumeReason === "user_message");
}

function load(): void {
  schedules.clear();
  pending.clear();
  deferredSleeps.clear();
  const path = statePath();
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ChronoStateFile>;
    if (parsed.version !== STATE_VERSION) {
      log("warn", `chrono: unsupported state version ${String(parsed.version)}; starting empty`);
      return;
    }
    for (const schedule of parsed.schedules ?? []) {
      if (validSchedule(schedule)) schedules.set(schedule.id, schedule);
    }
    for (const occurrence of parsed.pending ?? []) {
      if (validPending(occurrence)) pending.set(occurrence.id, occurrence);
    }
    for (const sleep of parsed.sleeps ?? []) {
      if (validDeferredSleep(sleep)) deferredSleeps.set(sleep.id, sleep);
    }
  } catch (err) {
    log("error", `chrono: failed to load state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function notifyConversation(conversationId: string | undefined): void {
  if (conversationId) changedListener?.(conversationId);
}

function publishSchedule(schedule: ChronoSchedule, active: boolean): void {
  const owner = schedule.ownerConversationId;
  if (!owner) return;
  if (setChronoTaskActive(owner, schedule.id, active, active ? {
    title: schedule.title,
    startedAt: schedule.createdAt,
    dueAt: schedule.nextAt,
    chronoMode: "wake",
  } : undefined)) notifyConversation(owner);
}

function replacePublishedSchedule(before: ChronoSchedule, after?: ChronoSchedule): void {
  if (after && before.id === after.id) publishSchedule(after, true);
  else publishSchedule(before, false);
}

function publishAllSchedules(): void {
  for (const schedule of schedules.values()) publishSchedule(schedule, true);
}

function publishDeferredSleep(sleep: DeferredChronoSleep, active: boolean): void {
  if (setChronoTaskActive(sleep.conversationId, sleep.id, active, active ? {
    title: `Sleeping until ${new Date(sleep.dueAt).toISOString()}`,
    startedAt: sleep.startedAt,
    dueAt: sleep.dueAt,
    chronoMode: "sleep",
  } : undefined)) notifyConversation(sleep.conversationId);
}

function publishAllDeferredSleeps(): void {
  for (const sleep of deferredSleeps.values()) {
    if (sleep.state === "sleeping") publishDeferredSleep(sleep, true);
  }
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function armTimer(): void {
  clearTimer();
  if (!started) return;
  let earliest = Number.POSITIVE_INFINITY;
  for (const occurrence of pending.values()) {
    if (!processing.has(occurrence.id)) earliest = Math.min(earliest, occurrence.retryAt ?? 0);
  }
  for (const schedule of schedules.values()) earliest = Math.min(earliest, schedule.nextAt);
  for (const sleep of deferredSleeps.values()) {
    if (processingSleeps.has(sleep.id)) continue;
    earliest = Math.min(earliest, sleep.state === "sleeping" ? sleep.dueAt : sleep.retryAt ?? 0);
  }
  if (!Number.isFinite(earliest)) return;
  const delay = Math.min(MAX_TIMER_MS, Math.max(0, earliest - Date.now()));
  timer = setTimeout(() => { void processPendingAndDue(); }, delay);
}

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zonedParts(timestamp: number, timezone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(timestamp))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values as unknown as ZonedParts;
}

function localDateString(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateOrdinal(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function calendarDateFromOrdinal(ordinal: number): { year: number; month: number; day: number } {
  const date = new Date(ordinal * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Convert a timezone-local wall time to epoch milliseconds; null for DST gaps. */
function localToEpoch(parts: ZonedParts, timezone: string): number | null {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const actual = zonedParts(guess, timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = desired - represented;
    guess += delta;
    if (delta === 0) break;
  }
  const actual = zonedParts(guess, timezone);
  return actual.year === parts.year && actual.month === parts.month && actual.day === parts.day
    && actual.hour === parts.hour && actual.minute === parts.minute && actual.second === parts.second
    ? guess
    : null;
}

function nextCalendar(recurrence: CalendarRecurrence, after: number): number {
  const afterLocal = zonedParts(after, recurrence.timezone);
  const startOrdinal = dateOrdinal(localDateString(afterLocal));
  const anchorOrdinal = dateOrdinal(recurrence.anchorDate);
  for (let offset = 0; offset <= 3660; offset++) {
    const ordinal = startOrdinal + offset;
    const date = calendarDateFromOrdinal(ordinal);
    const daysSinceAnchor = ordinal - anchorOrdinal;
    if (daysSinceAnchor < 0) continue;
    if (recurrence.unit === "day" && daysSinceAnchor % recurrence.interval !== 0) continue;
    if (recurrence.unit === "week") {
      if (Math.floor(daysSinceAnchor / 7) % recurrence.interval !== 0) continue;
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
      if (!(recurrence.weekdays ?? []).includes(weekday)) continue;
    }
    if (recurrence.unit === "month") {
      const [anchorYear, anchorMonth] = recurrence.anchorDate.split("-").map(Number);
      const monthsSinceAnchor = (date.year - anchorYear) * 12 + date.month - anchorMonth;
      if (monthsSinceAnchor < 0 || monthsSinceAnchor % recurrence.interval !== 0) continue;
      if (date.day !== recurrence.dayOfMonth) continue;
    }
    const candidate = localToEpoch({
      ...date,
      hour: recurrence.hour,
      minute: recurrence.minute,
      second: recurrence.second,
    }, recurrence.timezone);
    if (candidate !== null && candidate > after) return candidate;
  }
  throw new Error("Could not find the next calendar occurrence within ten years");
}

interface ParsedCronField { any: boolean; values: Set<number> }

function parseCronField(raw: string, min: number, max: number): ParsedCronField | null {
  if (raw === "*") return { any: true, values: new Set() };
  const values = new Set<number>();
  for (const item of raw.split(",")) {
    const [base, stepRaw] = item.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return null;
    let start: number;
    let end: number;
    if (base === "*") [start, end] = [min, max];
    else if (base.includes("-")) [start, end] = base.split("-").map(Number);
    else [start, end] = [Number(base), stepRaw === undefined ? Number(base) : max];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? { any: false, values } : null;
}

function nextCron(expression: string, after: number): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid migrated cron expression: ${expression}`);
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const dow = parseCronField(fields[4], 0, 6);
  if (!minute || !hour || !dom || !month || !dow) throw new Error(`Invalid migrated cron expression: ${expression}`);
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let checked = 0; checked < 5 * 366 * 24 * 60; checked++) {
    const domMatch = dom.any || dom.values.has(candidate.getDate());
    const dowMatch = dow.any || dow.values.has(candidate.getDay());
    const dayMatch = dom.any && dow.any ? true : dom.any ? dowMatch : dow.any ? domMatch : domMatch || dowMatch;
    if ((minute.any || minute.values.has(candidate.getMinutes()))
      && (hour.any || hour.values.has(candidate.getHours()))
      && (month.any || month.values.has(candidate.getMonth() + 1))
      && dayMatch) return candidate.getTime();
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`No occurrence found for migrated cron expression: ${expression}`);
}

/** Next occurrence for one-time migration of legacy five-field schedules. */
export function nextMigratedCronOccurrence(expression: string, after = Date.now()): number {
  return nextCron(expression, after);
}

function nextOccurrence(schedule: ChronoSchedule, after: number): number | null {
  const recurrence = schedule.recurrence;
  if (!recurrence) return null;
  if (recurrence.kind === "interval") {
    const elapsed = Math.max(0, after - recurrence.anchorAt);
    return recurrence.anchorAt + (Math.floor(elapsed / recurrence.everyMs) + 1) * recurrence.everyMs;
  }
  if (recurrence.kind === "calendar") return nextCalendar(recurrence, after);
  return nextCron(recurrence.expression, after);
}

function validateTimezone(timezone: string): boolean {
  try {
    formatter(timezone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseAt(at: string | undefined, afterSeconds: number | undefined, now: number): { value?: number; error?: string } {
  if (at !== undefined && afterSeconds !== undefined) return { error: "Use either 'at' or 'after_seconds', not both." };
  if (afterSeconds !== undefined) {
    if (!Number.isFinite(afterSeconds) || afterSeconds <= 0) return { error: "'after_seconds' must be greater than zero." };
    return { value: now + Math.round(afterSeconds * 1000) };
  }
  if (!at?.trim()) return { error: "Wake requires 'at' or 'after_seconds'." };
  const normalized = at.trim();
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    return { error: "'at' must be an ISO-8601 date/time with an explicit offset." };
  }
  const value = Date.parse(normalized);
  if (!Number.isFinite(value)) return { error: "'at' must be an ISO-8601 date/time with an explicit offset." };
  if (value <= now) return { error: "Wake time must be in the future." };
  return { value };
}

function recurrenceFromInput(repeat: RepeatInput | undefined, firstAt: number, timezoneInput?: string): { value?: ChronoRecurrence; error?: string } {
  if (!repeat) return {};
  const interval = repeat.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 10_000) return { error: "repeat.interval must be an integer from 1 to 10000." };
  if (repeat.unit === "minute" || repeat.unit === "hour") {
    const everyMs = interval * (repeat.unit === "minute" ? 60_000 : 3_600_000);
    return { value: { kind: "interval", everyMs, anchorAt: firstAt } };
  }
  if (repeat.unit !== "day" && repeat.unit !== "week" && repeat.unit !== "month") return { error: "repeat.unit must be minute, hour, day, week, or month." };
  const maxCalendarInterval = repeat.unit === "day" ? 3_660 : repeat.unit === "week" ? 522 : 120;
  if (interval > maxCalendarInterval) {
    return { error: `${repeat.unit} recurrence interval cannot exceed ${maxCalendarInterval}.` };
  }
  const timezone = timezoneInput?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!validateTimezone(timezone)) return { error: `Invalid IANA timezone: ${timezone}` };
  const local = zonedParts(firstAt, timezone);
  let weekdays: number[] | undefined;
  if (repeat.unit === "week") {
    const requested = repeat.weekdays?.length ? repeat.weekdays : [Object.keys(WEEKDAY_INDEX)[new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()]];
    weekdays = [];
    for (const day of requested) {
      const index = WEEKDAY_INDEX[day.toLowerCase().slice(0, 3)];
      if (index === undefined) return { error: `Invalid weekday: ${day}` };
      if (!weekdays.includes(index)) weekdays.push(index);
    }
  }
  return {
    value: {
      kind: "calendar",
      unit: repeat.unit,
      interval,
      timezone,
      hour: local.hour,
      minute: local.minute,
      second: local.second,
      anchorDate: localDateString(local),
      ...(weekdays ? { weekdays } : {}),
      ...(repeat.unit === "month" ? { dayOfMonth: local.day } : {}),
    },
  };
}

function defaultTitle(input: CreateScheduleInput): string {
  const content = (input.message ?? input.command ?? "Scheduled wake").replace(/\s+/g, " ").trim();
  return content.length > 80 ? `${content.slice(0, 79)}…` : content;
}

function conversationHasSleepToolCall(sleep: DeferredChronoSleep): boolean {
  return convStore.get(sleep.conversationId)?.messages.some((message) =>
    message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_use"
      && block.id === sleep.toolCallId
      && block.name === "chrono")
  ) ?? false;
}

function conversationHasSleepToolResult(sleep: DeferredChronoSleep): boolean {
  return convStore.get(sleep.conversationId)?.messages.some((message) =>
    message.role === "user"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_result" && block.tool_use_id === sleep.toolCallId)
  ) ?? false;
}

function formatElapsedDuration(durationMs: number): string {
  const clamped = Math.max(0, Math.round(durationMs));
  if (clamped < 1_000) return `${clamped}ms`;
  const totalSeconds = clamped / 1_000;
  if (totalSeconds < 60) return `${Number(totalSeconds.toFixed(totalSeconds < 10 ? 2 : 1))}s`;
  const totalWholeSeconds = Math.floor(totalSeconds);
  const days = Math.floor(totalWholeSeconds / 86_400);
  const hours = Math.floor((totalWholeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalWholeSeconds % 3_600) / 60);
  const seconds = totalWholeSeconds % 60;
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    seconds ? `${seconds}s` : "",
  ].filter(Boolean).join(" ");
}

function deferredSleepOutput(sleep: DeferredChronoSleep): string {
  const resumedAt = sleep.resumedAt ?? Date.now();
  const elapsed = formatElapsedDuration(resumedAt - sleep.startedAt);
  const requested = formatElapsedDuration(sleep.durationMs);
  const reason = sleep.resumeReason === "user_message"
    ? " The sleep ended early because the user sent a message."
    : "";
  return `Sleep finished after ${elapsed} (requested ${requested}).${reason}`;
}

function removeDeferredSleep(sleep: DeferredChronoSleep): void {
  if (!deferredSleeps.delete(sleep.id)) return;
  publishDeferredSleep(sleep, false);
  persist();
  armTimer();
}

/**
 * Persist a long sleep before returning control to the agent loop. The matching
 * assistant tool_use is committed immediately afterward; resume paths verify it
 * exists before ever appending a tool_result, which safely prunes an orphan if
 * the daemon dies in that narrow interval.
 */
export function deferChronoSleep(input: DeferChronoSleepInput): { sleep?: DeferredChronoSleep; error?: string } {
  if (!convStore.hasConversation(input.conversationId)) {
    return { error: `Conversation ${input.conversationId} not found.` };
  }
  if (!input.toolCallId.trim()) return { error: "Chrono sleep requires a tool call id." };
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= LONG_CHRONO_SLEEP_THRESHOLD_MS) {
    return { error: "Only Chrono sleeps longer than five minutes can be deferred." };
  }
  const existing = [...deferredSleeps.values()].find((sleep) =>
    sleep.conversationId === input.conversationId && sleep.state === "sleeping"
  );
  if (existing) return { error: `Conversation already has a deferred Chrono sleep: ${existing.id}` };
  const sleep: DeferredChronoSleep = {
    id: `chrono:sleep:${input.toolCallId}`,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    startedAt: input.startedAt,
    dueAt: input.startedAt + input.durationMs,
    durationMs: input.durationMs,
    state: "sleeping",
  };
  deferredSleeps.set(sleep.id, sleep);
  persist();
  publishDeferredSleep(sleep, true);
  armTimer();
  return { sleep: structuredClone(sleep) };
}

export function listDeferredChronoSleeps(conversationId?: string): DeferredChronoSleep[] {
  return [...deferredSleeps.values()]
    .filter((sleep) => !conversationId || sleep.conversationId === conversationId)
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
    .map((sleep) => structuredClone(sleep));
}

function prepareDeferredSleepResume(
  sleep: DeferredChronoSleep,
  reason: "elapsed" | "user_message",
  resumedAt: number,
): DeferredChronoSleep | null {
  if (!convStore.hasConversation(sleep.conversationId) || !conversationHasSleepToolCall(sleep)) {
    log("warn", `chrono: dropping orphaned deferred sleep ${sleep.id}; its tool call is not in conversation history`);
    removeDeferredSleep(sleep);
    return null;
  }
  const resuming: DeferredChronoSleep = {
    ...sleep,
    state: "resuming",
    resumedAt,
    resumeReason: reason,
  };
  if (reason === "user_message") resuming.retryAt = resumedAt + 30_000;
  else delete resuming.retryAt;
  deferredSleeps.set(resuming.id, resuming);
  // Persist wake intent before the tool result. A crash in between retries this
  // exact idempotent attachment and replay on startup.
  persist();
  if (!conversationHasSleepToolResult(resuming)) {
    const appended = convStore.appendMessages(resuming.conversationId, [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: resuming.toolCallId,
        content: deferredSleepOutput(resuming),
        is_error: false,
      }],
      metadata: null,
    }], { updatedAt: resumedAt });
    if (!appended) throw new Error(`Could not attach deferred Chrono sleep result to ${resuming.conversationId}`);
  }
  publishDeferredSleep(resuming, false);
  armTimer();
  return structuredClone(resuming);
}

/** Attach an early result synchronously so an incoming user turn can replay valid history. */
export function interruptDeferredChronoSleep(
  conversationId: string,
  resumedAt = Date.now(),
): DeferredChronoSleep | null {
  for (const sleep of [...deferredSleeps.values()]
    .filter((candidate) => candidate.conversationId === conversationId && candidate.state === "sleeping")
    .sort((a, b) => a.startedAt - b.startedAt)) {
    const prepared = prepareDeferredSleepResume(sleep, "user_message", resumedAt);
    if (prepared) return prepared;
  }
  return null;
}

/** The caller invokes this after it has started the replay that consumed an early wake. */
export function completeDeferredChronoSleepResume(sleepId: string): void {
  const sleep = deferredSleeps.get(sleepId);
  if (sleep) removeDeferredSleep(sleep);
}

export function createChronoSchedule(input: CreateScheduleInput, now = Date.now()): { schedule?: ChronoSchedule; error?: string } {
  const when = parseAt(input.at, input.afterSeconds, now);
  if (when.error || when.value === undefined) return { error: when.error };
  const hasMessage = !!input.message?.trim();
  const hasCommand = !!input.command?.trim();
  if (hasMessage === hasCommand) return { error: "Wake requires exactly one of 'message' or 'command'." };
  if (hasMessage && input.hardWake) return { error: "hard_wake is only valid for command soft-wakes." };
  if (input.hardWake?.when && input.hardWake.when !== "failure" && input.hardWake.when !== "always") {
    return { error: "hard_wake.when must be failure or always." };
  }
  const recurrence = recurrenceFromInput(input.repeat, when.value, input.timezone);
  if (recurrence.error) return { error: recurrence.error };

  let target: ChronoTarget;
  if (hasMessage) {
    target = { kind: "conversation", conversationId: input.ownerConversationId, message: input.message!.trim() };
  } else {
    const safety = evaluateToolCallSafety("bash", { command: input.command! });
    if (!safety.allowed) return { error: formatSafetyBlock(safety) };
    const timeoutSeconds = input.timeoutSeconds ?? 300;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
      return { error: "timeout_seconds must be greater than zero and no more than 86400." };
    }
    target = {
      kind: "command",
      command: input.command!.trim(),
      timeoutMs: Math.round(timeoutSeconds * 1000),
      ...(input.hardWake ? {
        hardWake: {
          conversationId: input.ownerConversationId,
          when: input.hardWake.when ?? "failure",
          message: input.hardWake.message?.trim() || "Investigate the scheduled command result and take appropriate action.",
          includeOutput: input.hardWake.includeOutput !== false,
        },
      } : {}),
    };
  }

  const schedule: ChronoSchedule = {
    id: `chrono:${randomUUID()}`,
    ownerConversationId: input.ownerConversationId,
    title: input.title?.trim() || defaultTitle(input),
    createdAt: now,
    nextAt: when.value,
    ...(recurrence.value ? { recurrence: recurrence.value } : {}),
    target,
    source: "model",
  };
  schedules.set(schedule.id, schedule);
  persist();
  publishSchedule(schedule, true);
  armTimer();
  return { schedule: { ...schedule } };
}

export function installMigratedSchedule(schedule: ChronoSchedule): boolean {
  if (schedules.has(schedule.id)) return false;
  schedules.set(schedule.id, schedule);
  persist();
  publishSchedule(schedule, true);
  armTimer();
  return true;
}

/**
 * Attach an ownerless daemon command schedule to the active conversation.
 * Adoption is deliberately limited to idle command schedules: conversation
 * wakes already have an owner, and mutating an in-flight occurrence would make
 * its escalation destination timing-dependent.
 */
export function adoptChronoSchedule(input: AdoptScheduleInput): { schedule?: ChronoSchedule; error?: string } {
  const schedule = schedules.get(input.scheduleId);
  if (!schedule) return { error: `Chrono schedule not found: ${input.scheduleId}` };
  if (schedule.ownerConversationId) {
    return { error: schedule.ownerConversationId === input.ownerConversationId
      ? `Chrono schedule is already owned by this conversation: ${input.scheduleId}`
      : `Chrono schedule is owned by another conversation: ${input.scheduleId}` };
  }
  if (schedule.target.kind !== "command") {
    return { error: "Only ownerless command schedules can be adopted." };
  }
  if ([...pending.values()].some(occurrence => occurrence.scheduleId === schedule.id)) {
    return { error: "Chrono schedule is currently running or pending; retry after this occurrence finishes." };
  }

  const adopted: ChronoSchedule = {
    ...schedule,
    ownerConversationId: input.ownerConversationId,
    source: "model",
    target: {
      ...schedule.target,
      hardWake: {
        conversationId: input.ownerConversationId,
        when: input.hardWake?.when ?? "failure",
        message: input.hardWake?.message?.trim()
          || `The Chrono automation '${schedule.title}' failed. Investigate and recover it.`,
        includeOutput: input.hardWake?.includeOutput ?? true,
      },
    },
  };
  schedules.set(adopted.id, adopted);
  persist();
  publishSchedule(adopted, true);
  armTimer();
  return { schedule: structuredClone(adopted) };
}

export function listChronoSchedules(ownerConversationId?: string): ChronoSchedule[] {
  const entries: ChronoSchedule[] = [...schedules.values()].map(schedule => ({ ...schedule, status: "scheduled" }));
  for (const occurrence of pending.values()) {
    if (schedules.has(occurrence.scheduleId)) continue;
    entries.push({
      id: occurrence.scheduleId,
      ...(occurrence.ownerConversationId ? { ownerConversationId: occurrence.ownerConversationId } : {}),
      title: occurrence.title,
      createdAt: occurrence.dueAt,
      nextAt: occurrence.dueAt,
      target: structuredClone(occurrence.target),
      source: occurrence.source,
      status: processing.has(occurrence.id) ? "running" : "pending",
    });
  }
  return entries
    .filter(schedule => !ownerConversationId || schedule.ownerConversationId === ownerConversationId)
    .sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id))
    .map(schedule => structuredClone(schedule));
}

export function cancelChronoSchedule(id: string, ownerConversationId?: string): { cancelled?: { id: string; title: string }; error?: string } {
  const foundSchedule = schedules.get(id);
  const schedule = foundSchedule && (!ownerConversationId || foundSchedule.ownerConversationId === ownerConversationId)
    ? foundSchedule
    : undefined;
  const occurrences = [...pending.values()].filter(item => item.scheduleId === id
    && (!ownerConversationId || item.ownerConversationId === ownerConversationId));
  if (!schedule && occurrences.length === 0) return { error: `Chrono schedule not found: ${id}` };
  if (schedule) schedules.delete(id);
  for (const occurrence of occurrences) {
    pending.delete(occurrence.id);
    const controller = activeCommandControllers.get(occurrence.id);
    if (controller) {
      cancelledOccurrences.add(occurrence.id);
      controller.abort("Chrono schedule cancelled");
    }
    if (occurrence.ownerConversationId && setChronoTaskActive(occurrence.ownerConversationId, occurrence.id, false)) {
      notifyConversation(occurrence.ownerConversationId);
    }
  }
  persist();
  if (schedule) publishSchedule(schedule, false);
  armTimer();
  return { cancelled: { id, title: schedule?.title ?? occurrences[0].title } };
}

export function cancelChronoSchedulesForConversation(conversationId: string): number {
  const ids = new Set<string>();
  for (const schedule of schedules.values()) {
    if (schedule.ownerConversationId === conversationId
      || (schedule.target.kind === "conversation" && schedule.target.conversationId === conversationId)) ids.add(schedule.id);
  }
  for (const occurrence of pending.values()) {
    if (occurrence.ownerConversationId === conversationId
      || (occurrence.target.kind === "conversation" && occurrence.target.conversationId === conversationId)) ids.add(occurrence.scheduleId);
  }
  for (const id of ids) cancelChronoSchedule(id);
  let deferredCount = 0;
  for (const sleep of [...deferredSleeps.values()]) {
    if (sleep.conversationId !== conversationId) continue;
    removeDeferredSleep(sleep);
    deferredCount++;
  }
  return ids.size + deferredCount;
}

/** Abort active commands before their owner's workspace is moved. Durable schedules remain until deletion commits. */
export function quiesceChronoCommandsForConversation(conversationId: string): number {
  let stopped = 0;
  for (const [occurrenceId, controller] of activeCommandControllers) {
    if (pending.get(occurrenceId)?.ownerConversationId !== conversationId) continue;
    controller.abort("Conversation is being deleted");
    stopped++;
  }
  return stopped;
}

function occurrenceAlreadyDelivered(occurrence: PendingOccurrence): boolean {
  if (occurrence.target.kind !== "conversation") return false;
  return convStore.get(occurrence.target.conversationId)?.messages
    .some(message => message.metadata?.queueEntryId === occurrence.id) ?? false;
}

function capOutput(output: string): string {
  if (output.length <= MAX_COMMAND_OUTPUT_IN_WAKE) return output;
  return `${output.slice(0, MAX_COMMAND_OUTPUT_IN_WAKE)}\n… [truncated]`;
}

function enqueueHardWake(occurrence: PendingOccurrence, hardWake: CommandHardWake, failed: boolean, output: string): void {
  if (hardWake.when !== "always" && !failed) return;
  if (!convStore.hasConversation(hardWake.conversationId)) {
    log("warn", `chrono: cannot hard-wake missing conversation ${hardWake.conversationId} for ${occurrence.id}`);
    return;
  }
  const queueId = `${occurrence.id}:hard-wake`;
  const alreadyDelivered = convStore.get(hardWake.conversationId)?.messages
    .some(message => message.metadata?.queueEntryId === queueId) ?? false;
  if (alreadyDelivered || convStore.getQueuedMessageById(queueId)) return;
  const status = failed ? "failed or reported an escalation condition" : "completed";
  const text = [
    `[chrono hard wake: ${occurrence.scheduleId}]`,
    `Scheduled command ${status}.`,
    `Task: ${occurrence.title}`,
    `Due: ${new Date(occurrence.dueAt).toISOString()}`,
    hardWake.message,
    ...(hardWake.includeOutput ? ["", "Command output:", capOutput(output || "(no output)")] : []),
  ].join("\n");
  convStore.pushQueuedMessage(
    hardWake.conversationId,
    text,
    "next-turn",
    undefined,
    null,
    undefined,
    queueId,
    undefined,
    { kind: "chrono_hard_wake", sourceId: occurrence.scheduleId },
  );
}

async function executeOccurrence(occurrence: PendingOccurrence): Promise<void> {
  if (processing.has(occurrence.id)) return;
  processing.add(occurrence.id);
  const commandOwner = occurrence.target.kind === "command" ? occurrence.ownerConversationId : undefined;
  if (commandOwner && setChronoTaskActive(commandOwner, occurrence.id, true, {
    title: `Running: ${occurrence.title}`,
    startedAt: Date.now(),
    chronoMode: "wake",
  })) notifyConversation(commandOwner);
  try {
    if (occurrence.source === "model" && occurrence.ownerConversationId && !convStore.hasConversation(occurrence.ownerConversationId)) {
      log("warn", `chrono: dropping ${occurrence.id}; its owning conversation no longer exists`);
      pending.delete(occurrence.id);
      persist();
      return;
    }
    if (occurrence.target.kind === "conversation") {
      if (!convStore.hasConversation(occurrence.target.conversationId)) {
        log("warn", `chrono: dropping wake ${occurrence.id}; conversation ${occurrence.target.conversationId} no longer exists`);
      } else if (!occurrenceAlreadyDelivered(occurrence)) {
        const text = `[chrono wake: ${occurrence.scheduleId}]\n${occurrence.target.message}`;
        convStore.pushQueuedMessage(
          occurrence.target.conversationId,
          text,
          "next-turn",
          undefined,
          null,
          undefined,
          occurrence.id,
          undefined,
          { kind: "chrono_wake", sourceId: occurrence.scheduleId },
        );
      }
    } else {
      let { output, failed } = occurrence.commandResult ?? { output: "", failed: false };
      if (!occurrence.commandResult) {
        const safety = evaluateToolCallSafety("bash", { command: occurrence.target.command });
        if (!safety.allowed) {
          output = formatSafetyBlock(safety);
          failed = true;
        } else {
          const controller = new AbortController();
          activeCommandControllers.set(occurrence.id, controller);
          let timedOut = false;
          const commandTarget = occurrence.target;
          const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(`Chrono command timed out after ${commandTarget.timeoutMs}ms`);
          }, commandTarget.timeoutMs);
          let result: Awaited<ReturnType<typeof executeBashBackgroundable>>;
          try {
            result = await executeBashBackgroundable({
              command: `export CHRONO_OCCURRENCE_ID=${occurrence.id};\n${commandTarget.command}`,
              // Chrono's controller owns the real deadline and kills the whole
              // process group. Keep Bash's spawn timeout later so its one-hour
              // default cannot terminate long soft-wakes first.
              timeout_seconds: commandTarget.timeoutMs / 1_000 + 60,
              max_output_chars: 12_000,
            }, controller.signal, undefined, occurrence.ownerConversationId ? {
              conversationId: occurrence.ownerConversationId,
              cwd: ensureConversationWorkspace(occurrence.ownerConversationId),
            } : { cwd: agentWorkingDirectory() });
          } finally {
            clearTimeout(timeout);
            activeCommandControllers.delete(occurrence.id);
          }
          if (controller.signal.aborted && !timedOut) {
            throw new Error("Scheduled command interrupted before completion");
          }
          output = result.output;
          failed = result.isError || timedOut;
        }
        occurrence.commandResult = { failed, output };
        delete occurrence.retryAt;
        pending.set(occurrence.id, occurrence);
        persist();
      }
      if (failed) log("warn", `chrono: soft wake ${occurrence.scheduleId} failed: ${capOutput(output)}`);
      else log("info", `chrono: soft wake ${occurrence.scheduleId} completed`);
      if (occurrence.target.hardWake) enqueueHardWake(occurrence, occurrence.target.hardWake, failed, output);
    }
    pending.delete(occurrence.id);
    persist();
  } catch (err) {
    log("error", `chrono: occurrence ${occurrence.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (cancelledOccurrences.has(occurrence.id)) {
      pending.delete(occurrence.id);
      persist();
    } else {
      // Keep the durable outbox entry for retry after a short delay/restart.
      occurrence.retryAt = Date.now() + 5_000;
      pending.set(occurrence.id, occurrence);
      persist();
    }
  } finally {
    if (commandOwner && setChronoTaskActive(commandOwner, occurrence.id, false)) notifyConversation(commandOwner);
    processing.delete(occurrence.id);
    activeCommandControllers.delete(occurrence.id);
    cancelledOccurrences.delete(occurrence.id);
    armTimer();
  }
}

async function executeDeferredSleep(sleep: DeferredChronoSleep): Promise<void> {
  if (processingSleeps.has(sleep.id)) return;
  processingSleeps.add(sleep.id);
  try {
    const current = deferredSleeps.get(sleep.id);
    if (!current) return;
    const prepared = current.state === "sleeping"
      ? prepareDeferredSleepResume(current, "elapsed", Math.max(Date.now(), current.dueAt))
      : prepareDeferredSleepResume(
          current,
          current.resumeReason ?? "elapsed",
          current.resumedAt ?? Math.max(Date.now(), current.dueAt),
        );
    if (!prepared) return;
    if (!deferredSleepReadyListener) {
      throw new Error("Deferred Chrono sleep replay runtime is not configured");
    }
    await deferredSleepReadyListener(prepared);
    const latest = deferredSleeps.get(prepared.id);
    if (latest) removeDeferredSleep(latest);
  } catch (err) {
    log("error", `chrono: deferred sleep ${sleep.id} failed to resume: ${err instanceof Error ? err.message : String(err)}`);
    const latest = deferredSleeps.get(sleep.id);
    if (latest) {
      latest.state = "resuming";
      latest.retryAt = Date.now() + 5_000;
      deferredSleeps.set(latest.id, latest);
      persist();
    }
  } finally {
    processingSleeps.delete(sleep.id);
    armTimer();
  }
}

async function processPendingAndDue(): Promise<void> {
  if (!started || processingDue) return;
  processingDue = true;
  clearTimer();
  try {
    const now = Date.now();
    for (const schedule of [...schedules.values()]) {
      if (schedule.nextAt > now) continue;
      const missingConversationTarget = schedule.target.kind === "conversation" && !convStore.hasConversation(schedule.target.conversationId);
      const missingModelOwner = schedule.source === "model" && schedule.ownerConversationId && !convStore.hasConversation(schedule.ownerConversationId);
      if (missingConversationTarget || missingModelOwner) {
        schedules.delete(schedule.id);
        replacePublishedSchedule(schedule);
        log("warn", `chrono: cancelled ${schedule.id}; its conversation no longer exists`);
        continue;
      }
      const alreadyPending = [...pending.values()].some(item => item.scheduleId === schedule.id);
      if (!alreadyPending) {
        const occurrence: PendingOccurrence = {
          id: `${schedule.id}:${schedule.nextAt}`,
          scheduleId: schedule.id,
          title: schedule.title,
          dueAt: schedule.nextAt,
          ...(schedule.ownerConversationId ? { ownerConversationId: schedule.ownerConversationId } : {}),
          target: structuredClone(schedule.target),
          ...(schedule.source ? { source: schedule.source } : {}),
        };
        pending.set(occurrence.id, occurrence);
      }
      let nextAt: number | null;
      try {
        nextAt = nextOccurrence(schedule, now);
      } catch (err) {
        log("error", `chrono: cancelling invalid recurrence ${schedule.id}: ${err instanceof Error ? err.message : String(err)}`);
        nextAt = null;
      }
      if (nextAt === null) {
        schedules.delete(schedule.id);
        replacePublishedSchedule(schedule);
      } else {
        const updated = { ...schedule, nextAt };
        schedules.set(schedule.id, updated);
        replacePublishedSchedule(schedule, updated);
      }
    }
    persist();
    for (const occurrence of pending.values()) {
      if ((occurrence.retryAt ?? 0) <= now) void executeOccurrence(occurrence);
    }
    for (const sleep of deferredSleeps.values()) {
      const readyAt = sleep.state === "sleeping" ? sleep.dueAt : sleep.retryAt ?? 0;
      if (readyAt <= now) void executeDeferredSleep(sleep);
    }
  } finally {
    processingDue = false;
    armTimer();
  }
}

export function configureChronoService(
  listener: ConversationChanged | null,
  sleepReadyListener: DeferredSleepReady | null = null,
): void {
  changedListener = listener;
  deferredSleepReadyListener = sleepReadyListener;
}

export async function startChronoService(): Promise<number> {
  if (started) return schedules.size;
  load();
  started = true;
  unregisterConversationRemoving ??= onConversationRemoving(quiesceChronoCommandsForConversation);
  unregisterConversationRemoval ??= onConversationRemoved(cancelChronoSchedulesForConversation);
  let pruned = false;
  for (const schedule of [...schedules.values()]) {
    const conversationId = schedule.target.kind === "conversation"
      ? schedule.target.conversationId
      : schedule.source === "model" ? schedule.ownerConversationId : undefined;
    if (conversationId && !convStore.hasConversation(conversationId)) {
      schedules.delete(schedule.id);
      pruned = true;
    }
  }
  for (const sleep of [...deferredSleeps.values()]) {
    if (!convStore.hasConversation(sleep.conversationId)) {
      deferredSleeps.delete(sleep.id);
      pruned = true;
    }
  }
  if (pruned) persist();
  try {
    const { migrateLegacyCronJobs } = await import("./chrono-migration");
    const migrated = migrateLegacyCronJobs();
    if (migrated > 0) log("info", `chrono: migrated ${migrated} legacy cron job(s)`);
  } catch (err) {
    log("error", `chrono: legacy cron migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  publishAllSchedules();
  publishAllDeferredSleeps();
  armTimer();
  if (pending.size > 0
      || [...schedules.values()].some(schedule => schedule.nextAt <= Date.now())
      || [...deferredSleeps.values()].some(sleep => sleep.state === "resuming" || sleep.dueAt <= Date.now())) {
    void processPendingAndDue();
  }
  log("info", `chrono: started with ${schedules.size} schedule(s), ${pending.size} pending occurrence(s), ${deferredSleeps.size} deferred sleep(s)`);
  return schedules.size;
}

export function stopChronoService(): void {
  clearTimer();
  started = false;
  for (const controller of activeCommandControllers.values()) controller.abort("daemon shutdown");
  activeCommandControllers.clear();
  unregisterConversationRemoval?.();
  unregisterConversationRemoval = null;
  unregisterConversationRemoving?.();
  unregisterConversationRemoving = null;
  persist();
  log("info", "chrono: stopped");
}

/** Test-only hooks kept explicit so production callers use the lifecycle API. */
export const chronoInternalsForTest = {
  nextCalendar,
  nextCron,
  recurrenceFromInput,
  processPendingAndDue,
  reset() {
    stopChronoService();
    schedules.clear();
    pending.clear();
    deferredSleeps.clear();
    processing.clear();
    processingSleeps.clear();
    cancelledOccurrences.clear();
    changedListener = null;
    deferredSleepReadyListener = null;
    rmSync(statePath(), { force: true });
  },
  statePath,
};
