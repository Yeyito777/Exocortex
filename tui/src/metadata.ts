/**
 * Message metadata renderer.
 *
 * Takes MessageMetadata and produces display lines.
 * This is the only file that knows how to render metadata.
 */

import { formatModelDisplayName, type MessageMetadata } from "./messages";
import { theme } from "./theme";
import { truncateToWidth } from "./textwidth";
import type { ClockFormat } from "./clock";
import { generationTokensPerSecond } from "@exocortex/shared/generation-throughput";

// ── Formatting ──────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${minutes}m ${seconds}s`;
  const hours = totalHours % 24;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 7) return `${totalDays}d ${hours}h ${minutes}m ${seconds}s`;
  const days = totalDays % 7;
  const weeks = Math.floor(totalDays / 7);

  return `${weeks}w ${days}d ${hours}h ${minutes}m ${seconds}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ClockParts { year: number; month: number; day: number; hour: number; minute: number }

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of an instant in `timeZone` (default: this machine's zone). */
function clockParts(ms: number, timeZone?: string): ClockParts {
  const key = timeZone ?? "";
  let formatter = clockFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    clockFormatters.set(key, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(ms)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

/** Local calendar day of `ms`; changes exactly when "today"/"yesterday" labels change. */
export function localDayKey(ms: number, timeZone?: string): string {
  const { year, month, day } = clockParts(ms, timeZone);
  return `${year}-${month}-${day}`;
}

/** Milliseconds from `now` until the next local midnight (DST-safe: re-derived from wall-clock fields). */
export function msUntilLocalMidnight(now: number, timeZone?: string): number {
  const { hour, minute } = clockParts(now, timeZone);
  const sinceMidnight = (hour * 60 + minute) * 60_000 + (now % 60_000 + 60_000) % 60_000;
  return Math.max(1_000, Math.min(26 * 3_600_000, 24 * 3_600_000 - sinceMidnight));
}

/**
 * When the AI finished, in the viewer's zone. 12h (default): `2:03pm` today,
 * `yesterday 10:41pm`, `Oct 19 9:12am`, `Oct 19 2025 9:12am` in another year.
 * 24h: `14:03`, `yesterday 22:41`, `Oct 19 09:12`, `Oct 19 2025 09:12`.
 * Returns null for a missing/invalid timestamp.
 */
export function formatFinishTime(
  endedAt: number | null | undefined,
  now: number,
  timeZone?: string,
  clock: ClockFormat = "12h",
): string | null {
  if (typeof endedAt !== "number" || !Number.isFinite(endedAt)) return null;
  const then = clockParts(endedAt, timeZone);
  const current = clockParts(now, timeZone);
  const minute = String(then.minute).padStart(2, "0");
  const time = clock === "24h"
    ? `${String(then.hour).padStart(2, "0")}:${minute}`
    : `${then.hour % 12 || 12}:${minute}${then.hour < 12 ? "am" : "pm"}`;
  const dayDiff = Math.round((Date.UTC(current.year, current.month - 1, current.day)
    - Date.UTC(then.year, then.month - 1, then.day)) / 86_400_000);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `yesterday ${time}`;
  const year = then.year === current.year ? "" : ` ${then.year}`;
  return `${MONTHS[then.month - 1]} ${then.day}${year} ${time}`;
}

function formatTokenCount(tokens: number): string {
  if (Number.isInteger(tokens) && tokens > -1000 && tokens < 1000) return `${tokens}`;
  return tokens.toLocaleString("en-US");
}

// ── Renderer ────────────────────────────────────────────────────────

/**
 * Render message metadata into display lines.
 *
 * Format: model | N tokens/s | Xs [| N tokens with diagnostics enabled] [| finish time]
 *
 * The finish time is metadata.endedAt (the instant the duration stops) in the
 * TUI machine's local zone, so it is right over /ssh. It is omitted while the
 * message is live and for old messages that carry no endedAt.
 *
 * Throughput is an exponentially weighted average of this message's last ten
 * API rounds, supplied by the daemon. Each sample is output tokens / request
 * seconds (TTFT + generation). A new message starts at zero.
 * Tool time, message duration, and the work timer never enter this calculation.
 *
 * @param metadata  The metadata to render (null = no output).
 * @param options.active  Keep elapsed time live even if endedAt is persisted.
 * @param options.width  Available pane columns, including the assistant indent.
 * @param options.diagnostics  Also display the accumulated output-token count.
 * @param options.clock  12h (default) or 24h finish time.
 * @param options.timeZone  IANA zone for the finish time (default: this machine's).
 * @returns Lines to append below the message content.
 */
export function renderMetadata(
  metadata: MessageMetadata | null,
  options: { active?: boolean; now?: number; width?: number; diagnostics?: boolean; timeZone?: string; clock?: ClockFormat } = {},
): string[] {
  if (!metadata) return [];

  const parts: string[] = [];

  // Model
  parts.push(formatModelDisplayName(metadata.model));

  const now = options.now ?? Date.now();
  const end = options.active ? now : metadata.endedAt ?? now;

  // Never estimate generation throughput from the message's elapsed time.
  const throughput = metadata.generationThroughput;
  const measuredRate = generationTokensPerSecond(throughput?.model === metadata.model ? throughput : undefined);
  // Optimistic messages exist before streaming_started supplies the fresh
  // daemon history. Show zero, never a prior message's rate, while waiting.
  const rate = measuredRate ?? (metadata.endedAt === null ? 0 : null);
  parts.push(`${rate === null ? "—" : rate.toFixed(1)} tokens/s`);

  // Duration retains the independent work-stretch timer.
  const elapsed = end - (metadata.workTimerStartedAt ?? metadata.startedAt);
  parts.push(formatDuration(elapsed));

  if (options.diagnostics) parts.push(`${formatTokenCount(metadata.tokens)} tokens`);

  if (!options.active) {
    const finished = formatFinishTime(metadata.endedAt, now, options.timeZone, options.clock);
    if (finished) parts.push(finished);
  }

  // Metadata is single-line chrome, not a wrapped content block. Include the
  // indent in its column budget so it cannot paint into a neighboring pane.
  const line = truncateToWidth(`  ${parts.join(" | ")}`, options.width ?? Infinity);
  return [`${theme.dim}${line}${theme.reset}`];
}
