import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { theme } from "../theme";
import type { TokenStatsSnapshot } from "../messages";
import { parsePositiveInt } from "./shared";
import type { SlashCommand } from "./types";

const TOKEN_HEATMAP_DEFAULT_MONTHS = 6;
const TOKEN_HEATMAP_DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_HEATMAP_WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const ANSI_TRUECOLOR_RE = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface TokenHeatmapData {
  lines: string[];
  maxTokenCount: number;
  averageTokenCount: number;
}

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

function accentTokenCount(n: number): string {
  return `${theme.accent}${formatTokenCount(n)}${theme.reset}`;
}

function parseTruecolorAnsi(ansi: string): RgbColor | null {
  const match = ANSI_TRUECOLOR_RE.exec(ansi);
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  };
}

function rgbToAnsi(color: RgbColor): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `\x1b[38;2;${clamp(color.r)};${clamp(color.g)};${clamp(color.b)}m`;
}

function blendRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  };
}

function localMidnight(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addLocalDays(date: Date, delta: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + delta);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function countInclusiveLocalDays(start: Date, end: Date): number {
  const cursor = localMidnight(start);
  const target = localMidnight(end);
  let count = 1;
  while (cursor < target) {
    cursor.setDate(cursor.getDate() + 1);
    count += 1;
  }
  return count;
}

export function defaultTokenHeatmapDayCount(now = new Date()): number {
  const end = localMidnight(now);
  const start = localMidnight(new Date(end));
  start.setMonth(start.getMonth() - TOKEN_HEATMAP_DEFAULT_MONTHS);
  return countInclusiveLocalDays(start, end);
}

function buildHeatmapSquare(tokenCount: number, maxTokenCount: number): string {
  if (tokenCount <= 0 || maxTokenCount <= 0) {
    return `${theme.muted}■${theme.reset}${theme.dim}`;
  }

  const accent = parseTruecolorAnsi(theme.accent);
  const muted = parseTruecolorAnsi(theme.muted);
  if (!accent || !muted) {
    return `${theme.accent}■${theme.reset}${theme.dim}`;
  }

  const ratio = Math.max(0, Math.min(1, tokenCount / maxTokenCount));
  const shade = Math.sqrt(ratio);
  const color = rgbToAnsi(blendRgb(muted, accent, shade));
  return `${color}■${theme.reset}${theme.dim}`;
}

function buildTokenHeatmap(stats: TokenStatsSnapshot, dayCount: number): TokenHeatmapData {
  const count = Math.max(1, dayCount);
  const end = localMidnight(new Date());
  const start = addLocalDays(end, -(count - 1));
  const gridStart = addLocalDays(start, -start.getDay());
  const totalGridDays = Math.floor((end.getTime() - gridStart.getTime()) / TOKEN_HEATMAP_DAY_MS) + 1;
  const weekCount = Math.ceil(totalGridDays / 7);
  const totalsByDay = new Map(stats.days.map((day) => [day.day, day.totalTokens]));

  let maxTokenCount = 0;
  let totalTokenCount = 0;
  let activeDayCount = 0;
  for (let i = 0; i < count; i++) {
    const tokenCount = totalsByDay.get(localDayKey(addLocalDays(start, i))) ?? 0;
    if (tokenCount > 0) {
      totalTokenCount += tokenCount;
      activeDayCount += 1;
    }
    if (tokenCount > maxTokenCount) maxTokenCount = tokenCount;
  }

  const lines = [`Heatmap (${formatShortDate(start)} → ${formatShortDate(end)}):`];
  for (let row = 0; row < TOKEN_HEATMAP_WEEKDAY_LABELS.length; row++) {
    const cells: string[] = [];
    for (let col = 0; col < weekCount; col++) {
      const cellDate = addLocalDays(gridStart, col * 7 + row);
      if (cellDate < start || cellDate > end) {
        cells.push(" ");
        continue;
      }
      const tokenCount = totalsByDay.get(localDayKey(cellDate)) ?? 0;
      cells.push(buildHeatmapSquare(tokenCount, maxTokenCount));
    }
    lines.push(`  ${TOKEN_HEATMAP_WEEKDAY_LABELS[row]}  ${cells.join(" ")}`);
  }

  const legendRatios = [0, 0.25, 0.5, 0.75, 1];
  const legendSquares = legendRatios.map((ratio) => buildHeatmapSquare(maxTokenCount * ratio, maxTokenCount));
  lines.push(`  Less ${legendSquares.join(" ")} More`);
  return {
    lines,
    maxTokenCount,
    averageTokenCount: activeDayCount > 0 ? Math.round(totalTokenCount / activeDayCount) : 0,
  };
}

function buildTokenStatsMessage(stats: TokenStatsSnapshot, heatmapDayCount: number): string {
  const today = stats.today;
  const heatmap = buildTokenHeatmap(stats, heatmapDayCount);
  const lines: string[] = [
    ...heatmap.lines,
    "",
    `Tokens today: ${accentTokenCount(today.totalTokens)}`,
    `Maximum tokens: ${accentTokenCount(heatmap.maxTokenCount)}`,
    `Average tokens: ${accentTokenCount(heatmap.averageTokenCount)}`,
    `Lifetime tokens: ${accentTokenCount(stats.lifetime.totalTokens)}`,
  ];

  return lines.filter((line, index, arr) => !(line === "" && arr[index - 1] === "")).join("\n");
}

export const TOKENS_COMMAND: SlashCommand = {
  name: "/tokens",
  description: "Show token usage totals and a heatmap",
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 2) {
      pushSystemMessage(state, "Usage: /tokens [days]");
      clearPrompt(state);
      return { type: "handled" };
    }

    const days = parts.length === 2 ? parsePositiveInt(parts[1]) : defaultTokenHeatmapDayCount();
    if (parts.length === 2 && days == null) {
      pushSystemMessage(state, "Usage: /tokens [days]\n\ndays must be a positive integer.");
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!state.tokenStats) {
      pushSystemMessage(state, "Token stats are still loading. Try again in a moment.");
      clearPrompt(state);
      return { type: "handled" };
    }

    pushSystemMessage(state, buildTokenStatsMessage(state.tokenStats, days ?? defaultTokenHeatmapDayCount()));
    clearPrompt(state);
    return { type: "handled" };
  },
};
