/**
 * Usage status block — 5-hour and weekly rate-limit bars.
 *
 * Usage combined over several accounts (Claude) fills a bar scaled to
 * `capacity` (two accounts: 0–200%) and lists the accounts' two soonest
 * reset times.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import type { UsageWindow } from "../messages";
import { theme } from "../theme";

/** Every usage bar's width (the status bar and the Accounts screen). */
export const BAR_WIDTH = 20;

/** How many accounts' reset times a combined bar lists. */
const MAX_RESETS_SHOWN = 2;

/** Filled cells of a BAR_WIDTH bar showing `pct` of `capacity`. */
export function barFill(pct: number, capacity = 100): number {
  const clamped = Math.max(0, Math.min(capacity, pct));
  return Math.round((clamped / capacity) * BAR_WIDTH);
}

function renderBar(pct: number | null, capacity = 100): string {
  if (pct === null) {
    return theme.muted + "\u2591".repeat(BAR_WIDTH);
  }
  const filled = barFill(pct, capacity);
  const empty = BAR_WIDTH - filled;
  return theme.accent + "\u2588".repeat(filled) + theme.muted + "\u2591".repeat(empty);
}

function formatTimeUntil(resetMs: number, now: number): string {
  const diff = Math.floor((resetMs - now) / 1000);
  if (diff <= 0) return "now";

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d:${hours}h:${pad2(mins)}m`;
  return `${hours}h:${pad2(mins)}m`;
}

/** Compact duration for a list of resets: "1h20m", "3d4h". */
function formatShortTimeUntil(resetMs: number, now: number): string {
  const diff = Math.floor((resetMs - now) / 1000);
  if (diff <= 0) return "now";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h${pad2(mins)}m`;
  return `${mins}m`;
}

function formatResetLabel(window: UsageWindow | null, now: number): string {
  if (!window) return "?";
  if (window.resets && window.resets.length > 1) {
    return window.resets
      .filter(reset => reset > now)
      .slice(0, MAX_RESETS_SHOWN)
      .map(reset => formatShortTimeUntil(reset, now))
      .join(" · ") || "now";
  }
  if (window.resetsAt !== null) return formatTimeUntil(window.resetsAt, now);
  return window.utilization <= 0 ? "now" : "?";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function windowLineWidth(label: string, pctStr: string, resetStr: string): number {
  // "  label: [bar] pct resets in reset"
  return 2 + label.length + 2 + 1 + BAR_WIDTH + 1 + 1 + pctStr.length + " resets in ".length + resetStr.length;
}

function unavailableWindowLineWidth(label: string): number {
  // "  label: [XXXXXXXXXXXXXXXXXXXX] not applicable"
  return 2 + label.length + 2 + 1 + BAR_WIDTH + 1 + 1 + "not applicable".length;
}

function renderWindowLine(label: string, window: UsageWindow | null, now: number, capacity = 100): { line: string; width: number } {
  const pct = window ? Math.round(window.utilization) : null;
  const shown = pct !== null ? `${pct}` : "?";
  const pctStr = capacity !== 100 ? `${shown}/${capacity}%` : `${shown}%`;
  const resetStr = formatResetLabel(window, now);
  const bar = renderBar(pct, capacity);
  const line = `${theme.muted}  ${label}: ${theme.text}[${bar}${theme.text}] ${theme.accent}${pctStr}${theme.muted} resets in ${theme.accent}${resetStr}${theme.reset}`;
  const width = windowLineWidth(label, pctStr, resetStr);
  return { line, width };
}

function renderUnavailableWindowLine(label: string): { line: string; width: number } {
  const bar = `${theme.dim}${"X".repeat(BAR_WIDTH)}${theme.reset}`;
  const line = `${theme.muted}  ${label}: ${theme.text}[${bar}${theme.text}] ${theme.dim}${theme.text}not applicable${theme.reset}`;
  return { line, width: unavailableWindowLineWidth(label) };
}

function summarizeWindow(label: string, window: UsageWindow | null, now: number, capacity: number): string {
  if (!window) return `${label} n/a`;
  const pct = Math.round(window.utilization);
  return `${label} ${capacity !== 100 ? `${pct}/${capacity}` : pct}% (resets in ${formatResetLabel(window, now)})`;
}

/** The status bar's usage windows for the current provider as one plain line; null when it shows none. */
export function usageSummary(state: RenderState, now = Date.now()): string | null {
  if (!state.authByProvider[state.provider]) return null;
  const usage = state.usageByProvider[state.provider];
  if (!usage?.fiveHour && !usage?.sevenDay) return null;
  const capacity = usage.capacity && usage.capacity > 0 ? usage.capacity : 100;
  return `${summarizeWindow("5-hour", usage.fiveHour, now, capacity)} · ${summarizeWindow("weekly", usage.sevenDay, now, capacity)}`;
}

export function usageBlock(state: RenderState): StatusBlock | null {
  if (!state.authByProvider[state.provider]) return null;

  const usage = state.usageByProvider[state.provider];
  if (!usage?.fiveHour && !usage?.sevenDay) return null;

  const now = Date.now();

  const capacity = usage.capacity && usage.capacity > 0 ? usage.capacity : 100;
  const fiveHour = usage.fiveHour
    ? renderWindowLine("5-Hour", usage.fiveHour, now, capacity)
    : renderUnavailableWindowLine("5-Hour");
  const weekly = renderWindowLine("Weekly", usage?.sevenDay ?? null, now, capacity);
  const blockWidth = Math.max(fiveHour.width, weekly.width);

  return {
    id: "usage",
    priority: 3,
    width: blockWidth,
    height: 2,
    rows: [
      fiveHour.line + " ".repeat(Math.max(0, blockWidth - fiveHour.width)),
      weekly.line + " ".repeat(Math.max(0, blockWidth - weekly.width)),
    ],
  };
}
