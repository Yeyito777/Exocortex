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
import type { ApiKeyCredit, ApiKeySpend, ApiKeyUsage, UsageWindow } from "../messages";
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

/** "≈$0.042 · 12.3K tok · 3 requests not priced (…)" — the /tokens detail; the status bar leaves the count out. */
function formatApiKeySpend(spend: ApiKeySpend): string {
  const tokens = `${formatTokenCount(spend.inputTokens + spend.outputTokens)} tok`;
  const unpriced = spend.unpricedRequests > 0
    ? ` · ${spend.unpricedRequests} request${spend.unpricedRequests === 1 ? "" : "s"} not priced (no per-token rate, e.g. audio, images)`
    : "";
  return `≈${formatUsd(spend.estimatedCostUsd)} · ${tokens}${unpriced}`;
}

function apiKeySummary(apiKey: ApiKeyUsage): string {
  const credit = apiKey.credit;
  if (!credit) return `API key ${apiKey.label}: today ${formatApiKeySpend(apiKey.today)} · this month ${formatApiKeySpend(apiKey.month)}`;
  const view = creditView(credit);
  const left = view.expired ? `expired ${formatDay(credit.expires!)}` : `${view.approximate ? "≈" : ""}${formatUsd(view.leftUsd)} left`;
  const runway = view.runway ? ` · ${view.runway}` : "";
  return `API key ${apiKey.label}: ${formatUsd(credit.amountUsd)} credit, ≈${formatUsd(credit.usedUsd)} used${view.sinceNote} · ${left}${runway}`
    + ` · today ${formatApiKeySpend(apiKey.today)}`;
}

/** "5-Hour" is the widest window label; API-key rows pad theirs to it so switching providers keeps the column. */
const LABEL_WIDTH = "5-Hour".length;

/** "  Today:  " — the label cell before a bar or value, padded to `width`. */
function labelCell(label: string, width = LABEL_WIDTH): string {
  return `  ${label}:${" ".repeat(Math.max(0, width - label.length))} `;
}

/**
 * What today may spend to stay on the monthly budget: what was left of it this
 * morning spread over the days left in the month, today included. Zero once
 * the month is over budget.
 */
export function dailyAllowance(apiKey: ApiKeyUsage, monthlyBudgetUsd: number, now = Date.now()): number {
  const date = new Date(now);
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - date.getDate() + 1;
  const spentBeforeToday = apiKey.month.estimatedCostUsd - apiKey.today.estimatedCostUsd;
  return Math.max(0, monthlyBudgetUsd - spentBeforeToday) / daysLeft;
}

/** "  Today:  [bar] $0.412 / $0.79"; the spend turns red once it passes the limit. */
function budgetLine(label: string, spentUsd: number, limitUsd: number): { line: string; width: number } {
  const spent = formatUsd(spentUsd);
  const limit = formatUsd(limitUsd);
  const over = spentUsd > limitUsd;
  const bar = renderBar(spentUsd, limitUsd);
  const head = labelCell(label);
  const line = `${theme.muted}${head}${theme.text}[${bar}${theme.text}] ${over ? theme.error : theme.accent}${spent}${theme.muted} / ${theme.accent}${limit}${theme.reset}`;
  return { line, width: head.length + 1 + BAR_WIDTH + 1 + 1 + spent.length + 3 + limit.length };
}

/** "  Month:  $14.87", optionally red and followed by muted text. */
function spendLine(label: string, spentUsd: number, options: { labelWidth?: number; color?: string; tail?: string; tailColor?: string } = {}): { line: string; width: number } {
  const head = labelCell(label, options.labelWidth);
  const spent = formatUsd(spentUsd);
  const tail = options.tail ?? "";
  return {
    line: `${theme.muted}${head}${options.color ?? theme.accent}${spent}${options.tailColor ?? theme.muted}${tail}${theme.reset}`,
    width: head.length + spent.length + tail.length,
  };
}

/** Share of the credit left below which the balance shows red. */
export const LOW_CREDIT_FRACTION = 0.1;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-22" → "Oct 22". */
function formatDay(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${MONTHS[month - 1] ?? "?"} ${date}`;
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, date) / 86_400_000);
}

export interface CreditView {
  leftUsd: number;
  /** Under LOW_CREDIT_FRACTION of the grant left (or none). */
  low: boolean;
  expired: boolean;
  /** The ledger starts after `since`: earlier spend is missing, so "left" is an upper bound. */
  approximate: boolean;
  /** " since Oct 22" when the ledger starts after `since`, else "". */
  sinceNote: string;
  /** Whole days the balance lasts at the recent pace; null without recent spend. */
  runwayDays: number | null;
  /** "~23 days left at this week's pace"; null without recent spend. */
  runway: string | null;
  /** The balance runs out before the grant expires. */
  runsOutBeforeExpiry: boolean;
}

function paceLabel(days: number): string {
  if (days >= 7) return "this week's pace";
  if (days === 1) return "today's pace";
  return `the last ${days} days' pace`;
}

/** What the credit rows say, from the daemon's figures. */
export function creditView(credit: ApiKeyCredit): CreditView {
  const leftUsd = Math.max(0, credit.amountUsd - credit.usedUsd);
  const expired = credit.expires !== null && credit.asOf >= credit.expires;
  const approximate = credit.firstTrackedDay !== null && credit.firstTrackedDay > credit.since;
  const perDay = credit.paceDays > 0 ? credit.paceUsd / credit.paceDays : 0;
  const runwayDays = perDay > 0 && !expired ? Math.floor(leftUsd / perDay) : null;
  const runway = runwayDays === null ? null
    : `${runwayDays < 1 ? "<1 day" : `~${runwayDays} day${runwayDays === 1 ? "" : "s"}`} left at ${paceLabel(credit.paceDays)}`;
  const daysToExpiry = credit.expires === null ? null : dayNumber(credit.expires) - dayNumber(credit.asOf);
  return {
    leftUsd,
    low: leftUsd < credit.amountUsd * LOW_CREDIT_FRACTION,
    expired,
    approximate,
    sinceNote: approximate ? ` since ${formatDay(credit.firstTrackedDay!)}` : "",
    runwayDays,
    runway,
    runsOutBeforeExpiry: runwayDays !== null && daysToExpiry !== null && runwayDays < daysToExpiry,
  };
}

const CREDIT_LABEL_WIDTH = "Credits".length;

/**
 * "  Credits: [bar] $64.04 used · $935.96 left" over
 * "  Today:   $39.30 · ~23 days left at this week's pace".
 * The bar is the share used; the balance turns red under 10%, the runway
 * yellow when it ends before the grant expires.
 */
function creditLines(apiKey: ApiKeyUsage, credit: ApiKeyCredit): Array<{ line: string; width: number }> {
  const view = creditView(credit);
  const head = labelCell("Credits", CREDIT_LABEL_WIDTH);
  const used = `${formatUsd(credit.usedUsd)} used${view.sinceNote}`;
  const left = view.expired ? `expired ${formatDay(credit.expires!)}` : `${view.approximate ? "≈" : ""}${formatUsd(view.leftUsd)} left`;
  const leftColor = view.expired || view.low ? theme.error : theme.accent;
  const credits = {
    line: `${theme.muted}${head}${theme.text}[${renderBar(credit.usedUsd, credit.amountUsd)}${theme.text}] ${theme.accent}${used}${theme.muted} · ${leftColor}${left}${theme.reset}`,
    width: head.length + 1 + BAR_WIDTH + 1 + 1 + used.length + 3 + left.length,
  };
  const today = spendLine("Today", apiKey.today.estimatedCostUsd, {
    labelWidth: CREDIT_LABEL_WIDTH,
    ...(view.runway ? { tail: ` · ${view.runway}`, tailColor: view.runsOutBeforeExpiry ? theme.warning : theme.muted } : {}),
  });
  return [credits, today];
}

/**
 * OpenAI on an API key has no plan windows: the slot shows what the key spent
 * through this daemon, estimated from published per-token rates. With a
 * credit grant: the spend since it against it, and today's spend with how
 * long the rest lasts. With only a monthly budget: today and the month as
 * bars against it (today as a plain amount once the month is over budget).
 * Requests the estimate could not price (audio, images) are left to /tokens.
 */
export function apiKeyRows(apiKey: ApiKeyUsage, now = Date.now()): StatusBlock {
  const budget = apiKey.monthlyBudgetUsd && apiKey.monthlyBudgetUsd > 0 ? apiKey.monthlyBudgetUsd : null;
  const allowance = budget === null ? 0 : dailyAllowance(apiKey, budget, now);
  const lines = apiKey.credit ? creditLines(apiKey, apiKey.credit)
    : budget === null
      ? [spendLine("Today", apiKey.today.estimatedCostUsd), spendLine("Month", apiKey.month.estimatedCostUsd)]
      : [
          allowance > 0 ? budgetLine("Today", apiKey.today.estimatedCostUsd, allowance) : spendLine("Today", apiKey.today.estimatedCostUsd),
          budgetLine("Month", apiKey.month.estimatedCostUsd, budget),
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
