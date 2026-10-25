/**
 * Usage status block — 5-hour and weekly rate-limit bars.
 *
 * Usage combined over several accounts (Claude) fills a bar scaled to
 * `capacity` (two accounts: 0–200%) and lists the accounts' two soonest
 * reset times.
 *
 * While the provider goes through /proxy, the bars are the remote's; a link
 * that is down or connecting, or a remote that is not logged in, shows beside
 * them so it never fails silently.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import type { ApiKeySpend, ApiKeyUsage, UsageWindow } from "../messages";
import { theme } from "../theme";
import { activeProviderProxy } from "../provider-proxies";

/** Every usage bar's width (the status bar and the Accounts screen). */
export const BAR_WIDTH = 20;

/** How many accounts' reset times a combined bar lists. */
const MAX_RESETS_SHOWN = 2;

/** Filled cells of a `width`-cell bar showing `pct` of `capacity`. */
export function barFill(pct: number, capacity = 100, width = BAR_WIDTH): number {
  const clamped = Math.max(0, Math.min(capacity, pct));
  return Math.round((clamped / capacity) * width);
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

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.001) return "<$0.001";
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** "≈$0.042 · 12.3K tok" plus how many requests had no published rate (images, audio). */
function formatApiKeySpend(spend: ApiKeySpend): string {
  const tokens = `${formatTokenCount(spend.inputTokens + spend.outputTokens)} tok`;
  const unpriced = spend.unpricedRequests > 0 ? ` +${spend.unpricedRequests} unpriced` : "";
  return `≈${formatUsd(spend.estimatedCostUsd)} · ${tokens}${unpriced}`;
}

function apiKeySummary(apiKey: ApiKeyUsage): string {
  return `API key ${apiKey.label}: today ${formatApiKeySpend(apiKey.today)} · this month ${formatApiKeySpend(apiKey.month)}`;
}

/** "5-Hour" is the widest window label; API-key rows pad theirs to it so switching providers keeps the column. */
const LABEL_WIDTH = "5-Hour".length;

/** "  Today:  " — the label cell before a bar or value. */
function labelCell(label: string): string {
  return `  ${label}:${" ".repeat(Math.max(0, LABEL_WIDTH - label.length))} `;
}

/**
 * What today may spend to stay on the monthly budget: what was left of it this
 * morning spread over the days left in the month, today included.
 */
export function dailyAllowance(apiKey: ApiKeyUsage, monthlyBudgetUsd: number, now = Date.now()): number {
  const date = new Date(now);
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - date.getDate() + 1;
  const spentBeforeToday = apiKey.month.estimatedCostUsd - apiKey.today.estimatedCostUsd;
  return Math.max(0, monthlyBudgetUsd - spentBeforeToday) / daysLeft;
}

/** " +3 unpriced": requests counted but not in the estimate (images, audio); empty when none. */
function unpricedSuffix(spend: ApiKeySpend): string {
  return spend.unpricedRequests > 0 ? ` +${spend.unpricedRequests} unpriced` : "";
}

/** "  Today:  [bar] $0.412 / $0.79"; the spend turns red once it passes the limit. */
function budgetLine(label: string, spentUsd: number, limitUsd: number, suffix = ""): { line: string; width: number } {
  const spent = formatUsd(spentUsd);
  const limit = formatUsd(limitUsd);
  const over = spentUsd > limitUsd;
  const bar = limitUsd > 0 ? renderBar(spentUsd, limitUsd) : renderBar(spentUsd > 0 ? 100 : 0);
  const head = labelCell(label);
  const line = `${theme.muted}${head}${theme.text}[${bar}${theme.text}] ${over ? theme.error : theme.accent}${spent}${theme.muted} / ${theme.accent}${limit}${theme.muted}${suffix}${theme.reset}`;
  return { line, width: head.length + 1 + BAR_WIDTH + 1 + 1 + spent.length + 3 + limit.length + suffix.length };
}

/** "  Month:  $14.87 +3 unpriced". */
function spendLine(label: string, spentUsd: number, suffix = ""): { line: string; width: number } {
  const head = labelCell(label);
  const spent = formatUsd(spentUsd);
  return { line: `${theme.muted}${head}${theme.accent}${spent}${theme.muted}${suffix}${theme.reset}`, width: head.length + spent.length + suffix.length };
}

/**
 * OpenAI on an API key has no plan windows: the slot shows what the key spent
 * through this daemon today and this month, estimated from published per-token
 * rates. With a monthly budget, each line gets a bar: the month against the
 * budget, today against its share of what is left. Requests the estimate
 * could not price are noted on the month line.
 */
export function apiKeyRows(apiKey: ApiKeyUsage, now = Date.now()): StatusBlock {
  const budget = apiKey.monthlyBudgetUsd && apiKey.monthlyBudgetUsd > 0 ? apiKey.monthlyBudgetUsd : null;
  const unpriced = unpricedSuffix(apiKey.month);
  const lines = budget === null
    ? [spendLine("Today", apiKey.today.estimatedCostUsd), spendLine("Month", apiKey.month.estimatedCostUsd, unpriced)]
    : [
        budgetLine("Today", apiKey.today.estimatedCostUsd, dailyAllowance(apiKey, budget, now)),
        budgetLine("Month", apiKey.month.estimatedCostUsd, budget, unpriced),
      ];
  const width = Math.max(...lines.map(line => line.width));
  return {
    id: "usage",
    priority: 3,
    width,
    height: 2,
    rows: lines.map(({ line, width: used }) => line + " ".repeat(width - used)),
  };
}

/** The status bar's usage windows for the current provider as one plain line; null when it shows none. */
export function usageSummary(state: RenderState, now = Date.now()): string | null {
  if (!state.authByProvider[state.provider]) return null;
  const usage = state.usageByProvider[state.provider];
  if (usage?.apiKey) return apiKeySummary(usage.apiKey);
  if (!usage?.fiveHour && !usage?.sevenDay) return null;
  const capacity = usage.capacity && usage.capacity > 0 ? usage.capacity : 100;
  return `${summarizeWindow("5-hour", usage.fiveHour, now, capacity)} · ${summarizeWindow("weekly", usage.sevenDay, now, capacity)}`;
}

/** Longest /proxy problem detail shown beside the bars. */
const MAX_PROXY_DETAIL = 40;

/** Why the current provider's /proxy cannot serve it now, as two short rows; null while it can. */
function proxyProblemRows(state: RenderState): { rows: string[]; width: number } | null {
  const proxy = activeProviderProxy(state);
  if (!proxy || (proxy.state === "connected" && proxy.remoteLoggedIn !== false)) return null;
  const [text, color] = proxy.state === "connecting" ? ["connecting…", theme.muted]
    : proxy.state === "connected" ? ["not logged in", theme.error]
    : ["down", theme.error];
  const head = `/proxy ${proxy.alias} ${text}`;
  const message = proxy.message?.trim() ?? "";
  const detail = message.length <= MAX_PROXY_DETAIL ? message : `${message.slice(0, MAX_PROXY_DETAIL - 1)}…`;
  const width = Math.max(head.length, detail.length);
  return {
    width,
    rows: [
      `${theme.muted}/proxy ${theme.accent}${proxy.alias} ${color}${text}${theme.reset}${" ".repeat(width - head.length)}`,
      ...(detail ? [`${theme.muted}${detail}${theme.reset}${" ".repeat(width - detail.length)}`] : []),
    ],
  };
}

export function usageBlock(state: RenderState): StatusBlock | null {
  if (!state.authByProvider[state.provider]) return null;

  const problem = proxyProblemRows(state);
  const bars = usageBars(state);
  if (!bars || !problem) return bars ?? (problem && {
    id: "usage",
    priority: 3,
    width: problem.width,
    height: problem.rows.length,
    rows: problem.rows,
  });
  const gap = "  ";
  return {
    ...bars,
    width: bars.width + gap.length + problem.width,
    rows: bars.rows.map((row, index) => `${row}${gap}${problem.rows[index] ?? " ".repeat(problem.width)}`),
  };
}

function usageBars(state: RenderState): StatusBlock | null {
  const usage = state.usageByProvider[state.provider];
  if (usage?.apiKey) return apiKeyRows(usage.apiKey);
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
