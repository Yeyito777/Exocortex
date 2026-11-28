import { clearPrompt } from "../promptstate";
import { getProviderInfo, pushSystemMessage, type RenderState } from "../state";
import { contextMeter } from "../statusblocks/context";
import { apiCreditPickSummary, usageSummary } from "../statusblocks/usage";
import { terminalColorLevel, theme } from "../theme";
import { ansiColorToRgb, rgbToAnsi as terminalRgbToAnsi } from "../terminalcolors";
import { estimateUncapturedCost, pricedModelProvider } from "@exocortex/shared/token-pricing";
import {
  createTokenUsageTotals,
  formatModelDisplayName,
  type TokenStatsSnapshot,
  type TokenUsageSource,
  type TokenUsageTotals,
  type ProviderId,
  type ModelId,
} from "../messages";
import { parsePositiveInt } from "./shared";
import type { CompletionItem, SlashCommand } from "./types";

const TOKEN_HEATMAP_DEFAULT_MONTHS = 6;
const TOKEN_HEATMAP_DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_HEATMAP_WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

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

const TOKEN_COST_ARG: CompletionItem = {
  name: "cost",
  desc: "Show what usage would cost at API list prices, by period, provider and model",
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

function parseAnsiForeground(ansi: string): RgbColor | null {
  const rgb = ansiColorToRgb(ansi, 38);
  return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2] } : null;
}

function rgbToAnsi(color: RgbColor): string {
  return terminalRgbToAnsi(38, color.r, color.g, color.b, terminalColorLevel);
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
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheMissInputTokens += source.cacheMissInputTokens;
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.unmeasuredInputTokens += source.unmeasuredInputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.requests += source.requests;
  target.estimatedInputCostUsd += source.estimatedInputCostUsd;
  target.estimatedOutputCostUsd += source.estimatedOutputCostUsd;
  target.pricedInputTokens += source.pricedInputTokens;
  target.pricedOutputTokens += source.pricedOutputTokens;
}

function sortUsageEntries<K extends string, T extends { totalTokens: number }>(entries: Array<[K, T]>): Array<[K, T]> {
  return [...entries].sort((a, b) => b[1].totalTokens - a[1].totalTokens || a[0].localeCompare(b[0]));
}

function buildHeatmapSquare(tokenCount: number, maxTokenCount: number): string {
  if (tokenCount <= 0 || maxTokenCount <= 0) {
    return `${theme.muted}■${theme.reset}${theme.dim}`;
  }

  const accent = parseAnsiForeground(theme.accent);
  const muted = parseAnsiForeground(theme.muted);
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
      lines.push(
        `  ${formatModelDisplayName(model)}: ${accentTokenCount(modelTotals.inputTokens)}/${accentTokenCount(modelTotals.outputTokens)} • ${accentTokenCount(modelTotals.requests)} req`,
        `    cache hit/miss/no-cache/unknown: ${accentTokenCount(modelTotals.cachedInputTokens)}/${accentTokenCount(modelTotals.cacheMissInputTokens)}/${accentTokenCount(modelTotals.uncachedInputTokens)}/${accentTokenCount(modelTotals.unmeasuredInputTokens)}`,
      );
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
    case "deepseek":
      return "DeepSeek";
    case "opencode":
      return "OpenCode Zen";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    case "openrouter":
      return "OpenRouter";
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
    case "goal_controller":
      return "goal controller";
    case "btw":
      return "BTW";
    case "llm_complete":
      return "llm complete";
    case "title_generation":
      return "title generation";
    case "browse_summary":
      return "browse summary";
    case "context_summary":
      return "context summary";
    case "context_compaction":
      return "context compaction";
    case "next_message_suggestion":
      return "next-message suggestions";
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
      lines.push(`    ${formatTokenSourceLabel(source)}: ${accentTokenCount(sourceTotals.inputTokens)}/${accentTokenCount(sourceTotals.outputTokens)} • ${accentTokenCount(sourceTotals.requests)} req`);
    }
  }

  return lines.join("\n");
}

// ── /tokens cost ────────────────────────────────────────────────────

type CostPeriod = "today" | "week" | "lifetime";
const COST_PERIODS: readonly CostPeriod[] = ["today", "week", "lifetime"];
const COST_PERIOD_LABELS: Record<CostPeriod, string> = { today: "Today", week: "Week", lifetime: "Lifetime" };

/** What one model, provider or period would have cost at API list prices. */
interface CostCell {
  /** Priced per request when it ran, at its exact rate. */
  measuredUsd: number;
  /** Bounds for tokens recorded without a per-request cost, priced from stored totals. */
  estimatedLowUsd: number;
  estimatedHighUsd: number;
  measuredTokens: number;
  estimatedTokens: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

type CostCells = Record<CostPeriod, CostCell>;

function createCostCell(): CostCell {
  return { measuredUsd: 0, estimatedLowUsd: 0, estimatedHighUsd: 0, measuredTokens: 0, estimatedTokens: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 };
}

function createCostCells(): CostCells {
  return { today: createCostCell(), week: createCostCell(), lifetime: createCostCell() };
}

function addCost(cell: CostCell, model: ModelId, usage: TokenUsageTotals, timestamp: number): void {
  const inputTokens = Math.max(0, usage.inputTokens);
  const outputTokens = Math.max(0, usage.outputTokens);
  cell.measuredUsd += Math.max(0, usage.estimatedInputCostUsd) + Math.max(0, usage.estimatedOutputCostUsd);
  cell.measuredTokens += Math.min(inputTokens, Math.max(0, usage.pricedInputTokens)) + Math.min(outputTokens, Math.max(0, usage.pricedOutputTokens));
  const estimate = estimateUncapturedCost(model, usage, timestamp);
  if (estimate) {
    cell.estimatedLowUsd += estimate.lowUsd;
    cell.estimatedHighUsd += estimate.highUsd;
    cell.estimatedTokens += estimate.inputTokens + estimate.outputTokens;
  }
  cell.totalTokens += inputTokens + outputTokens;
  cell.inputTokens += inputTokens;
  cell.outputTokens += outputTokens;
}

function unpricedTokens(cell: CostCell): number {
  return Math.max(0, cell.totalTokens - cell.measuredTokens - cell.estimatedTokens);
}

/** Group label for a model no price list has; display only. */
function guessCostProvider(model: ModelId): ProviderId | null {
  if (model.includes("/")) return "openrouter";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("deepseek")) return "deepseek";
  if (model.startsWith("gpt-") || model.startsWith("codex")) return "openai";
  return null;
}

function costModelLabel(model: ModelId): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (claude) return `Claude ${capitalize(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  if (model.startsWith("gpt-")) {
    const [version, ...rest] = model.slice(4).split("-");
    return [`GPT-${version}`, ...rest.map(capitalize)].join(" ");
  }
  return formatModelDisplayName(model);
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function unpricedReason(model: ModelId, provider: ProviderId | null, cell: CostCell): string {
  if (cell.measuredTokens + cell.estimatedTokens > 0) return "some token types have no published rate";
  if (provider === "openrouter") return "OpenRouter rates depend on the upstream; not cataloged";
  if (model === "deepseek-reasoner" || model === "deepseek-chat") return "retired name, not on DeepSeek's price list";
  if (provider === "openai") return "not on OpenAI's API price list";
  return "no published API price";
}

function formatCostUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return "<$0.01";
  if (amount < 1000) return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function formatCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  const [divisor, suffix] = n >= 1e9 ? [1e9, "B"] : n >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  return `${(n / divisor).toFixed(1)}${suffix}`;
}

function formatShare(part: number, whole: number): string {
  const percent = whole > 0 ? part / whole * 100 : 0;
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent > 99.9 && percent < 100) return ">99.9%";
  return `${Number(percent.toFixed(1))}%`;
}

/** Measured plus estimated: one figure when exact, low–high otherwise; ~ marks estimates. */
function formatCostTotal(cell: CostCell): string {
  if (cell.totalTokens === 0) return "—";
  if (cell.measuredTokens + cell.estimatedTokens === 0) return "unpriced";
  const low = cell.measuredUsd + cell.estimatedLowUsd;
  const high = cell.measuredUsd + cell.estimatedHighUsd;
  const prefix = cell.estimatedTokens > 0 ? "~" : "";
  const lowText = formatCostUsd(low);
  const highText = formatCostUsd(high);
  return lowText === highText ? `${prefix}${lowText}` : `${prefix}${lowText}–${highText}`;
}

function formatEstimate(cell: CostCell): string {
  if (cell.estimatedTokens === 0) return "—";
  const lowText = formatCostUsd(cell.estimatedLowUsd);
  const highText = formatCostUsd(cell.estimatedHighUsd);
  return lowText === highText ? lowText : `${lowText}–${highText}`;
}

function formatCoverage(cell: CostCell): string {
  if (cell.totalTokens === 0) return "—";
  return [cell.measuredTokens, cell.estimatedTokens, unpricedTokens(cell)].map((part) => formatShare(part, cell.totalTokens)).join(" / ");
}

/** Rows of plain cells, padded into columns; accent marks the money columns. */
function costTable(rows: string[][], accentColumns: ReadonlySet<number>): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  return rows.map((row, rowIndex) => row.map((cell, i) => {
    const padded = i === row.length - 1 ? cell : cell.padEnd(widths[i]);
    if (rowIndex === 0 || !accentColumns.has(i) || cell === "—" || cell === "") return padded;
    return `${accentText(cell)}${" ".repeat(padded.length - cell.length)}`;
  }).join("  ").trimEnd());
}

function buildCostBreakdownMessage(stats: TokenStatsSnapshot): string {
  if (stats.lifetime.requests === 0 && stats.lifetime.totalTokens === 0) {
    return "API cost at list prices (USD):\nNo token usage recorded yet.";
  }

  const week = getTokenDateRange(7);
  const weekStart = localDayKey(week.start);
  const todayKey = localDayKey(new Date());
  const totals = createCostCells();
  const byModel = new Map<ModelId, CostCells>();
  for (const day of stats.days) {
    const periods = COST_PERIODS.filter((period) => period === "lifetime"
      || (period === "week" && day.day >= weekStart && day.day <= todayKey)
      || (period === "today" && day.day === todayKey));
    // Dated rate changes: price a day's totals at that day's rates.
    const timestamp = new Date(`${day.day}T12:00:00`).getTime();
    for (const [model, usage] of Object.entries(day.byModel) as Array<[ModelId, TokenUsageTotals]>) {
      const cells = byModel.get(model) ?? createCostCells();
      byModel.set(model, cells);
      for (const period of periods) {
        addCost(cells[period], model, usage, timestamp);
        addCost(totals[period], model, usage, timestamp);
      }
    }
  }

  const lines = [
    "API cost at list prices (USD):",
    ...costTable([
      ["", "Measured", "Estimated", "Total", "Tokens measured/est./unpriced"],
      ...COST_PERIODS.map((period) => {
        const cell = totals[period];
        return [`  ${COST_PERIOD_LABELS[period]}`, cell.totalTokens === 0 ? "—" : formatCostUsd(cell.measuredUsd), formatEstimate(cell), formatCostTotal(cell), formatCoverage(cell)];
      }),
    ], new Set([1, 2, 3])),
  ];

  const byProvider = new Map<string, { label: string; cells: CostCells; models: ModelId[] }>();
  const unpriced: Array<{ model: ModelId; provider: ProviderId | null; cell: CostCell }> = [];
  for (const [model, cells] of byModel) {
    const provider = pricedModelProvider(model) ?? guessCostProvider(model);
    if (unpricedTokens(cells.lifetime) > 0) unpriced.push({ model, provider, cell: cells.lifetime });
    if (cells.lifetime.measuredTokens + cells.lifetime.estimatedTokens === 0) continue;
    const key = provider ?? "other";
    const group = byProvider.get(key) ?? { label: provider ? formatProviderLabel(provider) : "Other", cells: createCostCells(), models: [] };
    byProvider.set(key, group);
    group.models.push(model);
    for (const period of COST_PERIODS) {
      const from = cells[period];
      const into = group.cells[period];
      into.measuredUsd += from.measuredUsd;
      into.estimatedLowUsd += from.estimatedLowUsd;
      into.estimatedHighUsd += from.estimatedHighUsd;
      into.measuredTokens += from.measuredTokens;
      into.estimatedTokens += from.estimatedTokens;
      into.totalTokens += from.totalTokens;
      into.inputTokens += from.inputTokens;
      into.outputTokens += from.outputTokens;
    }
  }

  const lifetimeHigh = (cells: CostCells) => cells.lifetime.measuredUsd + cells.lifetime.estimatedHighUsd;
  const providerRows: string[][] = [["", "Today", "Week", "Lifetime", "Tokens in/out"]];
  for (const group of [...byProvider.values()].sort((a, b) => lifetimeHigh(b.cells) - lifetimeHigh(a.cells) || a.label.localeCompare(b.label))) {
    providerRows.push([`  ${group.label}`, ...COST_PERIODS.map((period) => formatCostTotal(group.cells[period])), ""]);
    group.models.sort((a, b) => lifetimeHigh(byModel.get(b)!) - lifetimeHigh(byModel.get(a)!) || a.localeCompare(b));
    for (const model of group.models) {
      const cells = byModel.get(model)!;
      providerRows.push([
        `    ${costModelLabel(model)}`,
        ...COST_PERIODS.map((period) => formatCostTotal(cells[period])),
        `${formatCompactTokens(cells.lifetime.inputTokens)}/${formatCompactTokens(cells.lifetime.outputTokens)}`,
      ]);
    }
  }
  if (providerRows.length > 1) lines.push("", "By provider and model:", ...costTable(providerRows, new Set([1, 2, 3])));

  if (unpriced.length > 0) {
    unpriced.sort((a, b) => unpricedTokens(b.cell) - unpricedTokens(a.cell) || a.model.localeCompare(b.model));
    lines.push("", "Unpriced (left out of every total):", ...costTable(unpriced.map(({ model, provider, cell }) => [
      `    ${costModelLabel(model)}`,
      formatCompactTokens(unpricedTokens(cell)),
      unpricedReason(model, provider, cell),
    ]), new Set()));
  }

  lines.push("", "Measured: priced per request when it ran (speed, cache writes, long context).");
  if (totals.lifetime.estimatedTokens > 0) {
    lines.push("~: includes usage recorded without a per-request cost, estimated from stored token totals at standard-speed, short-context list rates; a range covers what the totals don't record (cache-write TTL, cache write vs fresh input, DeepSeek peak hours).");
  }
  lines.push("Rates: Claude, OpenAI, Gemini and DeepSeek list prices, checked 2026-11-27.");
  return lines.join("\n");
}

/** The open conversation's context meter and its provider's usage windows, as the status bar shows them. */
function buildCurrentConversationLines(state: RenderState): string[] {
  const providerLabel = getProviderInfo(state, state.provider)?.label ?? formatProviderLabel(state.provider);
  const meter = contextMeter(state);
  const context = meter.tokens === null ? "?" : formatTokenCount(meter.tokens);
  const max = meter.max > 0 ? ` / ${formatTokenCount(meter.max)}` : "";
  const percent = meter.tokens !== null && meter.max > 0 ? ` (${Math.round(meter.tokens / meter.max * 100)}%)` : "";
  const lines = [
    `${state.convId ? "This conversation" : "New conversation"}: ${accentText(`${providerLabel} · ${formatModelDisplayName(state.model)}`)}`,
    `  Context: ${accentText(context)}${max} tokens${percent}`,
  ];
  const usage = usageSummary(state);
  if (usage) lines.push(`  ${providerLabel} usage: ${accentText(usage)}`);
  const pick = apiCreditPickSummary(state);
  if (pick) lines.push(`  New credit turns go to ${accentText(pick)}`);
  return lines;
}

function formatProviderSplit(bucket: TokenStatsSnapshot["today"]): string | null {
  const entries = sortUsageEntries(Object.entries(bucket.byProvider) as Array<[ProviderId, TokenUsageTotals]>);
  if (entries.length === 0) return null;
  return entries
    .map(([provider, totals]) => `${formatProviderLabel(provider)} ${accentTokenCount(totals.inputTokens)}/${accentTokenCount(totals.outputTokens)}`)
    .join(" · ");
}

function buildTokenStatsMessage(state: RenderState, stats: TokenStatsSnapshot, heatmapDayCount: number): string {
  const today = stats.today;
  const heatmap = buildTokenHeatmap(stats, heatmapDayCount);
  const providerSplit = formatProviderSplit(today);
  const lines: string[] = [
    ...buildCurrentConversationLines(state),
    "",
    ...heatmap.lines,
    "",
    `Tokens today: ${accentTokenCount(today.totalTokens)} • ${accentTokenCount(today.requests)} req`,
    ...(providerSplit ? [`Today by provider (input/output): ${providerSplit}`] : []),
    `Input today (hit/miss-write/no-cache/unknown): ${accentTokenCount(today.cachedInputTokens)}/${accentTokenCount(today.cacheMissInputTokens)}/${accentTokenCount(today.uncachedInputTokens)}/${accentTokenCount(today.unmeasuredInputTokens)}`,
    `Output today: ${accentTokenCount(today.outputTokens)}`,
    `Maximum tokens: ${accentTokenCount(heatmap.maxTokenCount)}`,
    `Average tokens: ${accentTokenCount(heatmap.averageTokenCount)}`,
    `Lifetime tokens: ${accentTokenCount(stats.lifetime.totalTokens)}`,
  ];

  return lines.filter((line, index, arr) => !(line === "" && arr[index - 1] === "")).join("\n");
}

/** Which /tokens report to show once the daemon's snapshot arrives. */
export interface TokenStatsView {
  subcommand?: "models" | "providers" | "sources" | "cost";
  days: number;
}

export function buildTokenStatsViewMessage(state: RenderState, stats: TokenStatsSnapshot, view: TokenStatsView): string {
  switch (view.subcommand) {
    case "models": return buildModelBreakdownMessage(stats, view.days);
    case "providers": return buildProviderBreakdownMessage(stats, view.days);
    case "sources": return buildSourceBreakdownMessage(stats, view.days);
    case "cost": return buildCostBreakdownMessage(stats);
    default: return buildTokenStatsMessage(state, stats, view.days);
  }
}

export const TOKENS_COMMAND: SlashCommand = {
  name: "/tokens",
  description: "Show context, usage limits, token totals, heatmaps, or breakdowns",
  args: [TOKEN_MODELS_ARG, TOKEN_PROVIDERS_ARG, TOKEN_SOURCES_ARG, TOKEN_COST_ARG],
  getArgs: () => ({
    "/tokens": [TOKEN_MODELS_ARG, TOKEN_PROVIDERS_ARG, TOKEN_SOURCES_ARG, TOKEN_COST_ARG],
  }),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const subcommand = parts[1]?.toLowerCase();
    const validSubcommands = new Set(["models", "providers", "sources", "cost"]);
    const hasSubcommand = !!subcommand && validSubcommands.has(subcommand);
    const isCostView = subcommand === "cost";
    const usage = "Usage: /tokens [days]\n       /tokens models [days]\n       /tokens providers [days]\n       /tokens sources [days]\n       /tokens cost";

    if ((!hasSubcommand && parts.length > 2) || (!isCostView && hasSubcommand && parts.length > 3) || (isCostView && parts.length > 2)) {
      pushSystemMessage(state, usage);
      clearPrompt(state);
      return { type: "handled" };
    }

    const rawDays = isCostView ? undefined : hasSubcommand ? parts[2] : parts[1];
    const days = rawDays ? parsePositiveInt(rawDays) : defaultTokenHeatmapDayCount();
    if (rawDays && days == null) {
      pushSystemMessage(state, `${usage}\n\ndays must be a positive integer.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    clearPrompt(state);
    return {
      type: "token_stats_requested",
      view: { subcommand: hasSubcommand ? subcommand as TokenStatsView["subcommand"] : undefined, days: days ?? defaultTokenHeatmapDayCount() },
    };
  },
};
