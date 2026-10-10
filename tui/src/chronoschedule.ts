/**
 * `/chrono` syntax and display. Times are the user's: they are read and shown
 * in this TUI's local timezone, which day/week/month repeats keep.
 */

import { chronoShortId, type ChronoRecurrence } from "@exocortex/shared/chrono";
import { parseDurationMs } from "@exocortex/shared/duration";
import { formatGoalDuration } from "@exocortex/shared/goals";
import type { ChronoRepeat, ChronoResultEvent, ChronoScheduleSummary } from "./protocol";
import { formatQueueDueTime } from "./queue";

export const CHRONO_USAGE = [
  "Usage: /chrono <when> <message, or !command to run in the shell>",
  "  once:   30m · in 2h 30m · at 9am · tomorrow 14:30 · fri 5pm · 2026-12-24 18:00",
  "  repeat: every 2h · every day at 9am · every weekday at 8:30 · every mon,thu at 18:00 · every month at 2026-11-01 9am",
  "/chrono [list] shows this conversation's schedules · /chrono cancel <id|all>",
].join("\n");

export type ChronoRequest =
  | { action: "list" }
  | { action: "cancel"; scheduleId: string }
  | { action: "create"; at: number; repeat?: ChronoRepeat; message?: string; command?: string };

type Weekday = NonNullable<ChronoRepeat["weekdays"]>[number];
const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const DAY_MS = 86_400_000;

interface Token { lower: string; end: number }
interface Clock { hour: number; minute: number; second: number }
type Day =
  | { kind: "today" | "tomorrow" }
  | { kind: "weekday"; weekday: number }
  | { kind: "date"; year: number; month: number; day: number };
/** `[<day>] <time>`, or one ISO-8601 instant. */
type When = { day?: Day; clock?: Clock; instant?: number };
type Period =
  | { kind: "fixed"; ms: number }
  | { kind: "calendar"; unit: "day" | "week" | "month"; interval: number }
  | { kind: "weekdays"; weekdays: number[] };

class ChronoSyntaxError extends Error {}

function fail(message: string): never {
  throw new ChronoSyntaxError(message);
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/\S+/g)].map(match => ({ lower: match[0].toLowerCase(), end: match.index + match[0].length }));
}

function durationToken(token: Token | undefined): number | null {
  return token && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(token.lower) ? parseDurationMs(token.lower) : null;
}

/** One or more adjacent duration tokens, such as `2h 30m`. */
function readDuration(tokens: Token[], i: number): { ms: number; next: number } | null {
  let ms = 0;
  let next = i;
  for (let part = durationToken(tokens[next]); part !== null; part = durationToken(tokens[next])) {
    ms += part;
    next++;
  }
  return next > i ? { ms, next } : null;
}

function readClock(tokens: Token[], i: number): { clock: Clock; next: number } | null {
  const token = tokens[i]?.lower;
  if (!token) return null;
  if (token === "noon") return { clock: { hour: 12, minute: 0, second: 0 }, next: i + 1 };
  if (token === "midnight") return { clock: { hour: 0, minute: 0, second: 0 }, next: i + 1 };
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(am|pm|a|p)?$/.exec(token);
  if (!match) return null;
  let next = i + 1;
  let meridiem = match[4];
  if (!meridiem && /^(?:am|pm)$/.test(tokens[next]?.lower ?? "")) meridiem = tokens[next++].lower;
  // A bare number is prose, not a time: require 9:00, 9am or 9 pm.
  if (!meridiem && match[2] === undefined) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const second = Number(match[3] ?? 0);
  if (minute > 59 || second > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridiem.startsWith("p") ? 12 : 0);
  } else if (hour > 23) return null;
  return { clock: { hour, minute, second }, next };
}

function readDay(tokens: Token[], i: number): { day: Day; next: number } | null {
  const token = tokens[i]?.lower;
  if (!token) return null;
  if (token === "today" || token === "tomorrow") return { day: { kind: token }, next: i + 1 };
  if (token in WEEKDAY_NAMES) return { day: { kind: "weekday", weekday: WEEKDAY_NAMES[token] }, next: i + 1 };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(year, month - 1, day);
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) fail(`Not a date: ${token}`);
  return { day: { kind: "date", year, month, day }, next: i + 1 };
}

function readWhen(tokens: Token[], i: number): { when: When; next: number } | null {
  const token = tokens[i]?.lower ?? "";
  if (/^\d{4}-\d{2}-\d{2}t\d{1,2}:\d{2}/.test(token)) {
    // Without an offset, ISO-8601 date-times are local.
    const instant = Date.parse(token.toUpperCase());
    if (!Number.isFinite(instant)) fail(`Not a date/time: ${token}`);
    return { when: { instant }, next: i + 1 };
  }
  const day = readDay(tokens, i);
  const clock = readClock(tokens, day?.next ?? i);
  if (!day && !clock) return null;
  if (!clock) fail("Add a time to the day, such as tomorrow 9am or fri 17:30.");
  return { when: { ...(day ? { day: day.day } : {}), clock: clock.clock }, next: clock.next };
}

function localTime(base: Date, dayOffset: number, clock: Clock): number {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, clock.hour, clock.minute, clock.second).getTime();
}

function clockLabel(clock: Clock): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(clock.hour)}:${pad(clock.minute)}${clock.second ? `:${pad(clock.second)}` : ""}`;
}

/** The next instant a day and time names, from now. */
function resolveWhen(when: When, now: number): number {
  if (when.instant !== undefined) {
    if (when.instant <= now) fail("That time has already passed.");
    return when.instant;
  }
  const clock = when.clock!;
  const today = new Date(now);
  const day = when.day;
  if (!day) {
    const at = localTime(today, 0, clock);
    return at > now ? at : localTime(today, 1, clock);
  }
  if (day.kind === "today") {
    const at = localTime(today, 0, clock);
    if (at <= now) fail(`Today at ${clockLabel(clock)} has already passed.`);
    return at;
  }
  if (day.kind === "tomorrow") return localTime(today, 1, clock);
  if (day.kind === "weekday") {
    for (let offset = 0; offset <= 7; offset++) {
      const at = localTime(today, offset, clock);
      if (new Date(at).getDay() === day.weekday && at > now) return at;
    }
  }
  if (day.kind === "date") {
    const at = new Date(day.year, day.month - 1, day.day, clock.hour, clock.minute, clock.second).getTime();
    if (at <= now) fail("That time has already passed.");
    return at;
  }
  return fail("Could not resolve that time.");
}

function readPeriod(tokens: Token[], i: number): { period: Period; next: number } {
  const duration = readDuration(tokens, i);
  if (duration) {
    if (duration.ms % DAY_MS === 0) return { period: { kind: "calendar", unit: "day", interval: duration.ms / DAY_MS }, next: duration.next };
    if (duration.ms % 60_000 !== 0) fail("Repeat periods must be whole minutes.");
    return { period: { kind: "fixed", ms: duration.ms }, next: duration.next };
  }
  const token = tokens[i]?.lower ?? "";
  if (token === "weekday" || token === "weekdays") return { period: { kind: "weekdays", weekdays: [1, 2, 3, 4, 5] }, next: i + 1 };
  if (token === "weekend" || token === "weekends") return { period: { kind: "weekdays", weekdays: [6, 0] }, next: i + 1 };
  const weekdays = new Set<number>();
  let afterDays = i;
  for (; afterDays < tokens.length; afterDays++) {
    const days = tokens[afterDays].lower.split(",").filter(Boolean);
    if (!days.length || !days.every(day => day in WEEKDAY_NAMES)) break;
    for (const day of days) weekdays.add(WEEKDAY_NAMES[day]);
  }
  if (weekdays.size) return { period: { kind: "weekdays", weekdays: [...weekdays] }, next: afterDays };
  let next = i;
  let interval = 1;
  if (/^\d+$/.test(token)) {
    interval = Number(token);
    next++;
  }
  const unit = (tokens[next]?.lower ?? "").replace(/s$/, "");
  if (interval >= 1) {
    if (unit === "minute" || unit === "min") return { period: { kind: "fixed", ms: interval * 60_000 }, next: next + 1 };
    if (unit === "hour") return { period: { kind: "fixed", ms: interval * 3_600_000 }, next: next + 1 };
    if (unit === "day" || unit === "week" || unit === "month") return { period: { kind: "calendar", unit, interval }, next: next + 1 };
  }
  return fail("Say how often, such as every 2h, every day, every weekday, or every mon,thu.");
}

const PERIOD_ALIASES: Record<string, string> = { hourly: "hour", daily: "day", weekly: "week", monthly: "month" };

function addCalendar(now: number, unit: "day" | "week" | "month", interval: number): number {
  const date = new Date(now);
  if (unit === "month") date.setMonth(date.getMonth() + interval);
  else date.setDate(date.getDate() + interval * (unit === "week" ? 7 : 1));
  return date.getTime();
}

function scheduleRepeat(tokens: Token[], i: number, now: number): { at: number; repeat: ChronoRepeat; next: number } {
  const alias = PERIOD_ALIASES[tokens[i]?.lower ?? ""];
  const { period, next: afterPeriod } = alias
    ? { period: readPeriod([{ lower: alias, end: 0 }], 0).period, next: i + 1 }
    : readPeriod(tokens, i + 1);
  let next = afterPeriod;
  const hasAt = tokens[next]?.lower === "at";
  const parsedWhen = readWhen(tokens, hasAt ? next + 1 : next);
  if (hasAt && !parsedWhen) fail("Add a time after at, such as at 9am or at fri 17:30.");
  const when = parsedWhen?.when;
  if (parsedWhen) next = parsedWhen.next;

  if (period.kind === "fixed") {
    const repeat: ChronoRepeat = period.ms % 3_600_000 === 0
      ? { unit: "hour", ...(period.ms === 3_600_000 ? {} : { interval: period.ms / 3_600_000 }) }
      : { unit: "minute", ...(period.ms === 60_000 ? {} : { interval: period.ms / 60_000 }) };
    return { at: when ? resolveWhen(when, now) : now + period.ms, repeat, next };
  }
  if (period.kind === "calendar") {
    const repeat: ChronoRepeat = { unit: period.unit, ...(period.interval === 1 ? {} : { interval: period.interval }) };
    return { at: when ? resolveWhen(when, now) : addCalendar(now, period.unit, period.interval), repeat, next };
  }
  if (when && (when.day || when.instant !== undefined)) fail("Give only a time with weekdays, such as every mon,thu at 18:00.");
  const today = new Date(now);
  const clock = when?.clock ?? { hour: today.getHours(), minute: today.getMinutes(), second: today.getSeconds() };
  let at = 0;
  for (let offset = 0; offset <= 7 && !at; offset++) {
    const candidate = localTime(today, offset, clock);
    if (candidate > now && period.weekdays.includes(new Date(candidate).getDay())) at = candidate;
  }
  const weekdays = [...period.weekdays].sort((a, b) => a - b).map(day => WEEKDAYS[day]);
  return { at, repeat: { unit: "week", weekdays }, next };
}

function scheduleOnce(tokens: Token[], i: number, now: number): { at: number; next: number } {
  const start = tokens[i]?.lower === "in" || tokens[i]?.lower === "at" ? i + 1 : i;
  if (tokens[i]?.lower !== "at") {
    const duration = readDuration(tokens, start);
    if (duration) return { at: now + duration.ms, next: duration.next };
    if (tokens[i]?.lower === "in") fail("Add a delay after in, such as in 30m or in 2h 30m.");
  }
  const when = readWhen(tokens, start);
  if (!when) fail(CHRONO_USAGE);
  return { at: resolveWhen(when.when, now), next: when.next };
}

/** Parse the text after `/chrono`. */
export function parseChronoArgs(text: string, now = Date.now()): ChronoRequest | { error: string } {
  const tokens = tokenize(text);
  const first = tokens[0]?.lower;
  if (!first || (first === "list" && tokens.length === 1)) return { action: "list" };
  if (first === "cancel") {
    if (tokens.length !== 2) return { error: "Usage: /chrono cancel <id|all>" };
    return { action: "cancel", scheduleId: text.trim().split(/\s+/)[1] };
  }

  try {
    const repeating = first === "every" || first in PERIOD_ALIASES;
    const schedule: { at: number; repeat?: ChronoRepeat; next: number } = repeating
      ? scheduleRepeat(tokens, 0, now)
      : scheduleOnce(tokens, 0, now);
    const payload = text.slice(schedule.next > 0 ? tokens[schedule.next - 1].end : 0).trim();
    if (!payload) fail("Add a message to send, or !command to run in the shell.");
    const target = payload.startsWith("!") ? { command: payload.slice(1).trim() } : { message: payload };
    if (target.command === "") fail("Add a shell command after !.");
    return { action: "create", at: schedule.at, ...(schedule.repeat ? { repeat: schedule.repeat } : {}), ...target };
  } catch (error) {
    if (error instanceof ChronoSyntaxError) return { error: error.message };
    throw error;
  }
}

// ── Display ─────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ordinal(day: number): string {
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${suffix}`;
}

export function formatChronoRecurrence(recurrence: ChronoRecurrence, localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  if (recurrence.kind === "interval") return `every ${formatGoalDuration(recurrence.everyMs)}`;
  if (recurrence.kind === "cron") return `cron ${recurrence.expression}`;
  const every = (unit: string) => recurrence.interval === 1 ? `every ${unit}` : `every ${recurrence.interval} ${unit}s`;
  const at = `at ${clockLabel(recurrence)}${recurrence.timezone === localTimezone ? "" : ` ${recurrence.timezone}`}`;
  if (recurrence.unit === "day") return `${every("day")} ${at}`;
  if (recurrence.unit === "month") return `${every("month")} on the ${ordinal(recurrence.dayOfMonth ?? 1)} ${at}`;
  const days = [...(recurrence.weekdays ?? [])].sort((a, b) => a - b);
  const dayList = days.join() === "1,2,3,4,5" ? "weekday" : days.join() === "0,6" ? "weekend day" : days.map(day => WEEKDAY_LABELS[day]).join(", ");
  return recurrence.interval === 1 ? `every ${dayList} ${at}` : `${every("week")} on ${dayList} ${at}`;
}

function formatDue(nextAt: number, now: number): string {
  const remaining = nextAt - now;
  const relative = remaining <= 0 ? "due now"
    : `in ${formatGoalDuration(remaining >= 3_600_000 ? Math.round(remaining / 60_000) * 60_000 : remaining)}`;
  return `${formatQueueDueTime(nextAt, now)} (${relative})`;
}

function payloadLabel(schedule: ChronoScheduleSummary): string {
  const text = schedule.kind === "command" ? `!${schedule.payload}` : schedule.payload;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function formatChronoSchedule(schedule: ChronoScheduleSummary, now = Date.now()): string {
  const repeat = schedule.recurrence ? formatChronoRecurrence(schedule.recurrence) : "once";
  const status = schedule.status === "scheduled" ? "" : ` · ${schedule.status}`;
  return `${chronoShortId(schedule.id)}  ${formatDue(schedule.nextAt, now)} · ${repeat}${status} · ${payloadLabel(schedule)}`;
}

export function formatChronoList(schedules: ChronoScheduleSummary[], now = Date.now()): string {
  if (!schedules.length) return "No Chrono schedules in this conversation. /chrono help shows how to add one.";
  return [`Chrono schedules (${schedules.length}):`, ...schedules.map(schedule => `  ${formatChronoSchedule(schedule, now)}`)].join("\n");
}


export function formatChronoResult(event: ChronoResultEvent, now = Date.now()): string {
  if (event.created) return `Scheduled ${formatChronoSchedule(event.created, now)}`;
  if (event.cancelled) {
    const [only] = event.cancelled;
    return event.cancelled.length === 1
      ? `Cancelled ${chronoShortId(only.id)} · ${only.title}`
      : `Cancelled ${event.cancelled.length} Chrono schedules.`;
  }
  return formatChronoList(event.schedules, now);
}
