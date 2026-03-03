/**
 * Status line renderer.
 *
 * Renders the usage bars below the input prompt.
 * This is the only file that knows how to display usage data.
 * Always renders both windows — shows ?% and resets in ? when data is unavailable.
 */

import type { UsageData, UsageWindow } from "./messages";

// ── ANSI ────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const FG_ACCENT = `${ESC}38;2;29;154;239m`;  // #1d9aef
const FG_WHITE = `${ESC}37m`;

// ── Formatting ──────────────────────────────────────────────────────

const BAR_WIDTH = 20;

function renderBar(pct: number | null): string {
  if (pct === null) {
    return DIM + "\u2591".repeat(BAR_WIDTH);
  }
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return FG_ACCENT + "\u2588".repeat(filled) + DIM + "\u2591".repeat(empty);
}

function formatTimeUntil(resetMs: number | null, now: number): string {
  if (resetMs === null) return "?";
  const diff = Math.floor((resetMs - now) / 1000);
  if (diff <= 0) return "?";

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d:${hours}h:${pad2(mins)}m`;
  return `${hours}h:${pad2(mins)}m`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function renderWindowLine(label: string, window: UsageWindow | null, now: number): string {
  const pct = window ? Math.round(window.utilization) : null;
  const pctStr = pct !== null ? `${pct}%` : "?%";
  const resetStr = formatTimeUntil(window?.resetsAt ?? null, now);
  const bar = renderBar(pct);
  return `${DIM}${label}: ${FG_WHITE}[${bar}${FG_WHITE}]${DIM} ${FG_ACCENT}${pctStr}${DIM} resets in ${FG_ACCENT}${resetStr}${RESET}`;
}

// ── Public renderer ─────────────────────────────────────────────────

/** Always returns 2 lines — 5-Hour and Weekly. */
export function renderStatusLine(usage: UsageData | null): string[] {
  const now = Date.now();
  return [
    renderWindowLine("5-Hour", usage?.fiveHour ?? null, now),
    renderWindowLine("Weekly", usage?.sevenDay ?? null, now),
  ];
}

/** Always 2 rows. */
export const STATUS_LINE_HEIGHT = 2;
