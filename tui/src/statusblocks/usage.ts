/**
 * Usage status block — 5-hour and weekly rate-limit bars.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import type { UsageWindow } from "../messages";
import { theme } from "../theme";

const BAR_WIDTH = 20;

function renderBar(pct: number | null): string {
  if (pct === null) {
    return theme.muted + "\u2591".repeat(BAR_WIDTH);
  }
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return theme.accent + "\u2588".repeat(filled) + theme.muted + "\u2591".repeat(empty);
}

function formatTimeUntil(resetMs: number | null, now: number): string {
  if (resetMs === null) return "?";
  const diff = Math.floor((resetMs - now) / 1000);
  if (diff <= 0) return "now";

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d:${hours}h:${pad2(mins)}m`;
  return `${hours}h:${pad2(mins)}m`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function windowLineWidth(label: string, pctStr: string, resetStr: string): number {
  // "  label: [bar] pct resets in reset"
  return 2 + label.length + 2 + 1 + BAR_WIDTH + 1 + 1 + pctStr.length + " resets in ".length + resetStr.length;
}

function renderWindowLine(label: string, window: UsageWindow | null, now: number): { line: string; width: number } {
  const pct = window ? Math.round(window.utilization) : null;
  const pctStr = pct !== null ? `${pct}%` : "?%";
  const resetStr = formatTimeUntil(window?.resetsAt ?? null, now);
  const bar = renderBar(pct);
  const line = `${theme.muted}  ${label}: ${theme.text}[${bar}${theme.text}] ${theme.accent}${pctStr}${theme.muted} resets in ${theme.accent}${resetStr}${theme.reset}`;
  const width = windowLineWidth(label, pctStr, resetStr);
  return { line, width };
}

export function usageBlock(state: RenderState): StatusBlock | null {
  const usage = state.usageByProvider[state.provider];
  const now = Date.now();

  const fiveHour = renderWindowLine("5-Hour", usage?.fiveHour ?? null, now);
  const weekly = renderWindowLine("Weekly", usage?.sevenDay ?? null, now);
  const blockWidth = Math.max(fiveHour.width, weekly.width);

  return {
    id: "usage",
    priority: 1,
    width: blockWidth,
    height: 2,
    rows: [
      fiveHour.line + " ".repeat(Math.max(0, blockWidth - fiveHour.width)),
      weekly.line + " ".repeat(Math.max(0, blockWidth - weekly.width)),
    ],
  };
}
