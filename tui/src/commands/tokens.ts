import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { theme } from "../theme";
import {
  createTokenUsageTotals,
  formatModelDisplayName,
  type TokenStatsSnapshot,
  type TokenUsageSource,
  type TokenUsageTotals,
  type ProviderId,
} from "../messages";
import { parsePositiveInt } from "./shared";
import type { CompletionItem, SlashCommand } from "./types";

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

interface TokenDateRange {
  start: Date;
  end: Date;
  dayCount: number;
}

const TOKEN_MODELS_ARG: CompletionItem = {
  name: "models",
  desc: "Show token totals broken down by model",
};

const TOKEN_PROVIDERS_ARG: CompletionItem = {
  name: "providers",
  desc: "Show token totals broken down by provider",
};

const TOKEN_SOURCES_ARG: CompletionItem = {
  name: "sources",
  desc: "Show token totals broken down by source",
};

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

function accentSpan(text: string): string {
  return `${theme.accent}${text}${theme.reset}${theme.dim}`;
}

function accentTokenCount(n: number): string {
  return accentSpan(formatTokenCount(n));
}

function accentText(text: string): string {
  return accentSpan(text);
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

function getTokenDateRange(dayCount: number, now = new Date()): TokenDateRange {
  const safeDayCount = Math.max(1, dayCount);
  const end = localMidnight(now);
  const start = addLocalDays(end, -(safeDayCount - 1));
  return { start, end, dayCount: safeDayCount };
}

export function defaultTokenHeatmapDayCount(now = new Date()): number {
  const end = localMidnight(now);
  const start = localMidnight(new Date(end));
  start.setMonth(start.getMonth() - TOKEN_HEATMAP_DEFAULT_MONTHS);
  return countInclusiveLocalDays(start, end);
}

function addUsageTotals(target: TokenUsageTotals, source: TokenUsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.requests += source.requests;
}

function sortUsageEntries<T extends { totalTokens: number }>(entries: Array<[string, T]>): Array<[string, T]> {
  return [...entries].sort((a, b) => b[1].totalTokens - a[1].totalTokens || a[0].localeCompare(b[0]));
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
  const range = getTokenDateRange(dayCount);
  const { start, end } = range;
  const gridStart = addLocalDays(start, -start.getDay());
  const totalGridDays = Math.floor((end.getTime() - gridStart.getTime()) / TOKEN_HEATMAP_DAY_MS) + 1;
  const weekCount = Math.ceil(totalGridDays / 7);
  const totalsByDay = new Map(stats.days.map((day) => [day.day, day.totalTokens]));

  let maxTokenCount = 0;
  let totalTokenCount = 0;
  let activeDayCount = 0;
  for (let i = 0; i < range.dayCount; i++) {
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

function aggregateByRange<T extends string>(
  stats: TokenStatsSnapshot,
  dayCount: number,
  selector: (day: TokenStatsSnapshot["days"][number]) => Record<T, TokenUsageTotals> | Partial<Record<T, TokenUsageTotals>>,
): { range: TokenDateRange; totals: Map<T, TokenUsageTotals> } {
  const range = getTokenDateRange(dayCount);
  const startKey = localDayKey(range.start);
  const endKey = localDayKey(range.end);
  const totals = new Map<T, TokenUsageTotals>();

  for (const day of stats.days) {
    if (day.day < startKey || day.day > endKey) continue;
    for (const [key, usageTotals] of Object.entries(selector(day)) as Array<[T, TokenUsageTotals]>) {
      const current = totals.get(key) ?? createTokenUsageTotals();
      addUsageTotals(current, usageTotals);
      totals.set(key, current);
    }
  }

  return { range, totals };
}

function buildModelBreakdownMessage(stats: TokenStatsSnapshot, dayCount: number): string {
  const { range, totals } = aggregateByRange(stats, dayCount, (day) => day.byModel);

  const lines = [`Models (${formatShortDate(range.start)} → ${formatShortDate(range.end)}):`];
  const sortedModels = sortUsageEntries([...totals.entries()]);
  if (sortedModels.length === 0) {
    lines.push("No token usage recorded yet.");
  } else {
    for (const [model, modelTotals] of sortedModels) {
      lines.push(`  ${formatModelDisplayName(model)}: ${accentTokenCount(modelTotals.inputTokens)}/${accentTokenCount(modelTotals.outputTokens)} • ${accentTokenCount(modelTotals.requests)} req — all`);
    }

    const [topModel, topModelTotals] = sortedModels[0];
    lines.push(
      "",
      `Top model: ${accentText(formatModelDisplayName(topModel))}`,
      `Top model tokens: ${accentTokenCount(topModelTotals.inputTokens)}/${accentTokenCount(topModelTotals.outputTokens)}`,
    );
  }

  return lines.filter((line, index, arr) => !(line === "" && arr[index - 1] === "")).join("\n");
}

function formatProviderLabel(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
  }
}

function buildProviderBreakdownMessage(stats: TokenStatsSnapshot, dayCount: number): string {
  const { range, totals } = aggregateByRange<ProviderId>(stats, dayCount, (day) => day.byProvider);
  const lines = [`Providers (${formatShortDate(range.start)} → ${formatShortDate(range.end)}):`];
  const sortedProviders = sortUsageEntries([...totals.entries()]);

  if (sortedProviders.length === 0) {
    lines.push("No token usage recorded yet.");
  } else {
    for (const [provider, providerTotals] of sortedProviders) {
      lines.push(`    ${formatProviderLabel(provider)}: ${accentTokenCount(providerTotals.inputTokens)}/${accentTokenCount(providerTotals.outputTokens)}`);
    }
  }

  return lines.join("\n");
}

function formatTokenSourceLabel(source: TokenUsageSource): string {
  switch (source) {
    case "conversation":
      return "conversation";
    case "llm_complete":
      return "llm complete";
    case "title_generation":
      return "title generation";
    case "browse_summary":
      return "browse summary";
    case "context_summary":
      return "context summary";
  }
}

function buildSourceBreakdownMessage(stats: TokenStatsSnapshot, dayCount: number): string {
  const { range, totals } = aggregateByRange<TokenUsageSource>(stats, dayCount, (day) => day.bySource);
  const lines = [`Sources (${formatShortDate(range.start)} → ${formatShortDate(range.end)}):`];
  const sortedSources = sortUsageEntries([...totals.entries()]);

  if (sortedSources.length === 0) {
    lines.push("No token usage recorded yet.");
  } else {
    for (const [source, sourceTotals] of sortedSources) {
      lines.push(`    ${formatTokenSourceLabel(source)}: ${accentTokenCount(sourceTotals.inputTokens)}/${accentTokenCount(sourceTotals.outputTokens)}`);
    }
  }

  return lines.join("\n");
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
  description: "Show token usage totals, heatmaps, or breakdowns",
  args: [TOKEN_MODELS_ARG, TOKEN_PROVIDERS_ARG, TOKEN_SOURCES_ARG],
  getArgs: () => ({
    "/tokens": [TOKEN_MODELS_ARG, TOKEN_PROVIDERS_ARG, TOKEN_SOURCES_ARG],
  }),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const subcommand = parts[1]?.toLowerCase();
    const validSubcommands = new Set(["models", "providers", "sources"]);
    const hasSubcommand = !!subcommand && validSubcommands.has(subcommand);

    if ((!hasSubcommand && parts.length > 2) || (hasSubcommand && parts.length > 3)) {
      pushSystemMessage(state, "Usage: /tokens [days]\n       /tokens models [days]\n       /tokens providers [days]\n       /tokens sources [days]");
      clearPrompt(state);
      return { type: "handled" };
    }

    const rawDays = hasSubcommand ? parts[2] : parts[1];
    const days = rawDays ? parsePositiveInt(rawDays) : defaultTokenHeatmapDayCount();
    if (rawDays && days == null) {
      pushSystemMessage(state, "Usage: /tokens [days]\n       /tokens models [days]\n       /tokens providers [days]\n       /tokens sources [days]\n\ndays must be a positive integer.");
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!state.tokenStats) {
      pushSystemMessage(state, "Token stats are still loading. Try again in a moment.");
      clearPrompt(state);
      return { type: "handled" };
    }

    const resolvedDays = days ?? defaultTokenHeatmapDayCount();
    let message: string;
    switch (subcommand) {
      case "models":
        message = buildModelBreakdownMessage(state.tokenStats, resolvedDays);
        break;
      case "providers":
        message = buildProviderBreakdownMessage(state.tokenStats, resolvedDays);
        break;
      case "sources":
        message = buildSourceBreakdownMessage(state.tokenStats, resolvedDays);
        break;
      default:
        message = buildTokenStatsMessage(state.tokenStats, resolvedDays);
        break;
    }

    pushSystemMessage(state, message);
    clearPrompt(state);
    return { type: "handled" };
  },
};
