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
 *
 * While Claude turns run on API credits (every subscription account at a
 * limit), the bars give way to the credits: a Credit row (everything left
 * over everything granted, every key's organization once) and an Expiry row
 * (each grant's balance and the time to its expiry, soonest first). OpenAI
 * on an API-key credit grant shows the same rows. An older daemon that sends
 * no pool keeps the bars, with two short rows beside them.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import type { ApiCreditGrantLeft, ApiCreditPool, ApiCreditsUsage, ApiKeyCredit, ApiKeySpend, ApiKeyUsage, UsageWindow } from "../messages";
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

/** "$936": the credit's balance and grant, where cents don't matter. */
function formatDollars(usd: number): string {
  return `$${Math.round(usd)}`;
}

/** "$39.70": today's spend and the pace, to the cent. */
function formatCents(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * The /tokens line: the status bar's figures plus what it leaves out (the
 * estimate caveat, the first counted day, the runway, tokens and unpriced
 * requests).
 */
function apiKeySummary(apiKey: ApiKeyUsage): string {
  const credit = apiKey.credit;
  const today = `today ${formatApiKeySpend(apiKey.today)}`;
  if (!credit) return `API key ${apiKey.label}: ${today} · this month ${formatApiKeySpend(apiKey.month)}`;
  const view = creditView(credit, apiKey.today.estimatedCostUsd);
  if (view.expired) return `API key ${apiKey.label}: ${formatDollars(credit.amountUsd)} credit expired ${formatDay(credit.expires!, true)} · ${today}`;
  const counted = view.approximate ? ` (counted from ${formatDay(credit.firstTrackedDay!)}; earlier days not seen)` : "";
  const pace = view.paceUsd !== null ? ` · ${formatCents(view.paceUsd)}/day to last until ${formatDay(credit.expires!, true)}` : "";
  const runway = view.runway ? ` · ${view.runway}` : "";
  return `API key ${apiKey.label}: ≈${formatDollars(view.leftUsd)} / ${formatDollars(credit.amountUsd)} credit left${counted}${pace}${runway} · ${today}`;
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

/** "  Label:  [bar] figure / limit": a bar filled to `filled` of `capacity`, the figure in its own colour. */
function barLine(
  label: string,
  filled: number,
  capacity: number,
  figure: string,
  figureColor: string,
  limit: string,
  labelWidth = LABEL_WIDTH,
): { line: string; width: number } {
  const head = labelCell(label, labelWidth);
  const line = `${theme.muted}${head}${theme.text}[${renderBar(filled, capacity)}${theme.text}] ${figureColor}${figure}${theme.muted} / ${theme.accent}${limit}${theme.reset}`;
  return { line, width: head.length + 1 + BAR_WIDTH + 1 + 1 + figure.length + 3 + limit.length };
}

/** "  Today:  [bar] $0.412 / $0.79"; the spend turns red once it passes the limit. */
function budgetLine(label: string, spentUsd: number, limitUsd: number, options: { labelWidth?: number; format?: (usd: number) => string } = {}): { line: string; width: number } {
  const format = options.format ?? formatUsd;
  const color = spentUsd > limitUsd ? theme.error : theme.accent;
  return barLine(label, spentUsd, limitUsd, format(spentUsd), color, format(limitUsd), options.labelWidth);
}

/** "  Month:  $14.87". */
function spendLine(label: string, spentUsd: number, options: { labelWidth?: number; format?: (usd: number) => string } = {}): { line: string; width: number } {
  const head = labelCell(label, options.labelWidth);
  const spent = (options.format ?? formatUsd)(spentUsd);
  return {
    line: `${theme.muted}${head}${theme.accent}${spent}${theme.reset}`,
    width: head.length + spent.length,
  };
}

/** Share of the credit left below which the balance shows red. */
export const LOW_CREDIT_FRACTION = 0.1;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-22" → "Oct 22" ("Oct 22 2026" with the year). */
function formatDay(day: string, withYear = false): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${MONTHS[month - 1] ?? "?"} ${date}${withYear ? ` ${year}` : ""}`;
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
  /**
   * What today may spend for the credit to last until it expires: the balance
   * this morning over the days left, today included. Null without an expiry,
   * once expired, or with nothing left.
   */
  paceUsd: number | null;
  /** "~23 days left at this week's pace" (for /tokens); null without recent spend. */
  runway: string | null;
}

function paceLabel(days: number): string {
  if (days >= 7) return "this week's pace";
  if (days === 1) return "today's pace";
  return `the last ${days} days' pace`;
}

/** What the credit rows say, from the daemon's figures and today's spend. */
export function creditView(credit: ApiKeyCredit, todayUsd: number): CreditView {
  const leftUsd = Math.max(0, credit.amountUsd - credit.usedUsd);
  const expired = credit.expires !== null && credit.asOf >= credit.expires;
  const approximate = credit.firstTrackedDay !== null && credit.firstTrackedDay > credit.since;
  const leftThisMorning = Math.max(0, credit.amountUsd - Math.max(0, credit.usedUsd - todayUsd));
  const daysLeft = credit.expires === null ? 0 : dayNumber(credit.expires) - dayNumber(credit.asOf);
  const paceUsd = !expired && daysLeft > 0 && leftThisMorning > 0 ? leftThisMorning / daysLeft : null;
  const perDay = credit.paceDays > 0 ? credit.paceUsd / credit.paceDays : 0;
  const runwayDays = perDay > 0 && !expired ? Math.floor(leftUsd / perDay) : null;
  return {
    leftUsd,
    low: leftUsd < credit.amountUsd * LOW_CREDIT_FRACTION,
    expired,
    approximate,
    paceUsd,
    runway: runwayDays === null ? null
      : `${runwayDays < 1 ? "<1 day" : `~${runwayDays} day${runwayDays === 1 ? "" : "s"}`} left at ${paceLabel(credit.paceDays)}`,
  };
}

/** Time until a credit grant expires, coarse: "171d", "5h", "<1h" (the Accounts screen's too). */
export function formatCreditCountdown(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `${hours}h`;
  return "<1h";
}

/** A run of text in one colour; a row is a list of them. */
type Piece = [color: string, text: string];

function piecesWidth(pieces: readonly Piece[]): number {
  return pieces.reduce((sum, [, text]) => sum + text.length, 0);
}

function paint(pieces: readonly Piece[], width = piecesWidth(pieces)): string {
  return pieces.map(([color, text]) => color + text).join("") + theme.reset + " ".repeat(Math.max(0, width - piecesWidth(pieces)));
}

/** The credit rows, and the narrower forms the Expiry row has. */
interface CreditRows {
  credit: Piece[];
  /** The Expiry row showing its first `shown` grants (all of them: the full row). */
  expiry: (shown: number) => Piece[];
  /** How many grants the Expiry row lists in full. */
  grants: number;
}

/**
 * The credit rows as a block, and narrower ones for the status line to fall
 * back to, with fewer grants listed ("+2" for the rest).
 */
function creditBlock(rows: CreditRows): StatusBlock {
  const variant = (shown: number): StatusBlock => {
    const expiry = rows.expiry(shown);
    const width = Math.max(piecesWidth(rows.credit), piecesWidth(expiry));
    return { id: "usage", priority: 3, width, height: 2, rows: [paint(rows.credit, width), paint(expiry, width)] };
  };
  const full = variant(rows.grants);
  const narrower: StatusBlock[] = [];
  for (const form of Array.from({ length: Math.max(0, rows.grants - 1) }, (_, i) => variant(rows.grants - 1 - i))) {
    // The Credit row sets the least width: a form no narrower than the last one is no help.
    if (form.width < (narrower.at(-1) ?? full).width) narrower.push(form);
  }
  return narrower.length > 0 ? { ...full, narrower } : full;
}

/** "  Credit: [bar] ≈$862 / $900": the bar is the share left in the accent colour like the usage bars, the amount green (both red under a tenth). */
function creditRow(leftUsd: number, grantedUsd: number, approximate: boolean, note: Piece[] = []): Piece[] {
  const low = leftUsd < grantedUsd * LOW_CREDIT_FRACTION;
  const filled = grantedUsd > 0 ? barFill(leftUsd, grantedUsd) : 0;
  return [
    [theme.muted, labelCell("Credit")],
    [theme.text, "["], [low ? theme.error : theme.accent, "\u2588".repeat(filled)], [theme.muted, "\u2591".repeat(BAR_WIDTH - filled)], [theme.text, "] "],
    [low ? theme.error : theme.success, `${approximate ? "≈" : ""}${formatDollars(Math.max(0, leftUsd))}`],
    [theme.muted, ` / ${formatDollars(grantedUsd)}`],
    ...note,
  ];
}

/** Grants worth listing: anything that rounds to a dollar or more. */
function listedGrants(grants: readonly ApiCreditGrantLeft[], now: number): ApiCreditGrantLeft[] {
  return grants
    .filter(grant => (grant.expiresAt === null || grant.expiresAt > now) && Math.round(grant.leftUsd) >= 1)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}

/** "  Expiry: $162 12d · $200 19d · $500 170d", the first `shown` grants, then "+N" for the rest. */
function expiryRow(grants: readonly ApiCreditGrantLeft[], shown: number, now: number): Piece[] {
  const pieces: Piece[] = [[theme.muted, labelCell("Expiry")]];
  if (grants.length === 0) return [...pieces, [theme.muted, "none left"]];
  const separator: Piece = [theme.muted + theme.dim, " · "];
  grants.slice(0, shown).forEach((grant, index) => {
    if (index > 0) pieces.push(separator);
    pieces.push(
      [theme.reset + theme.success, formatDollars(grant.leftUsd)],
      [theme.muted, grant.expiresAt === null ? " no expiry" : ` ${formatCreditCountdown(grant.expiresAt - now)}`],
    );
  });
  if (shown < grants.length) pieces.push(separator, [theme.reset + theme.muted, `+${grants.length - shown}`]);
  return pieces;
}

/** The rows for Claude turns on API credits, from a daemon that sends the pool. */
function claudeCreditBlock(pool: ApiCreditPool, now: number): StatusBlock {
  const grants = listedGrants(pool.grants, now);
  return creditBlock({
    credit: creditRow(pool.balanceUsd, pool.grantedUsd, pool.approximate, pool.signInNeeded ? [[theme.muted, " sign-in needed"]] : []),
    expiry: shown => expiryRow(grants, shown, now),
    grants: grants.length,
  });
}

/** Midnight (local) after a local day: when a grant that expires that day ends. */
function endOfLocalDay(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + 1).getTime();
}

/**
 * OpenAI's credit grant as the same rows: "  Credit: [bar] ≈$935 / $1000"
 * (always ≈: it is the grant less what this daemon counted) over its expiry.
 * An expired grant says so in red.
 */
function openAICreditBlock(apiKey: ApiKeyUsage, credit: ApiKeyCredit, now: number): StatusBlock {
  const view = creditView(credit, apiKey.today.estimatedCostUsd);
  const grant: ApiCreditGrantLeft = { leftUsd: view.leftUsd, grantedUsd: credit.amountUsd, expiresAt: credit.expires === null ? null : endOfLocalDay(credit.expires) };
  const grants = view.expired ? [] : listedGrants([grant], now);
  return creditBlock({
    credit: creditRow(view.expired ? 0 : view.leftUsd, credit.amountUsd, true),
    expiry: shown => view.expired
      ? [[theme.muted, labelCell("Expiry")], [theme.error, `expired ${formatDay(credit.expires!)}`]]
      : expiryRow(grants, shown, now),
    grants: grants.length,
  });
}

/**
 * OpenAI on an API key has no plan windows: the slot shows what the key spent
 * through this daemon, estimated from published per-token rates. With a
 * credit grant: its balance, and today's spend against the pace that makes it
 * last until it expires. With only a monthly budget: today and the month as
 * bars against it (today as a plain amount once the month is over budget).
 * Requests the estimate could not price (audio, images) are left to /tokens.
 */
export function apiKeyRows(apiKey: ApiKeyUsage, now = Date.now()): StatusBlock {
  if (apiKey.credit) return openAICreditBlock(apiKey, apiKey.credit, now);
  const budget = apiKey.monthlyBudgetUsd && apiKey.monthlyBudgetUsd > 0 ? apiKey.monthlyBudgetUsd : null;
  const allowance = budget === null ? 0 : dailyAllowance(apiKey, budget, now);
  const lines = budget === null
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
  const credits = usage.apiCredits?.active ? ` · ${apiCreditSummary(usage.apiCredits, now)}` : "";
  return `${summarizeWindow("5-hour", usage.fiveHour, now, capacity)} · ${summarizeWindow("weekly", usage.sevenDay, now, capacity)}${credits}`;
}

/** "on API credits, $862 / $900 left, subscriptions back in 1d4h, ≈$1.23 this cycle" (older daemons: the key in use and its balance). */
function apiCreditSummary(credits: ApiCreditsUsage, now: number): string {
  const spent = `≈${formatCents(credits.spentUsd)} this cycle`;
  const pool = credits.pool;
  if (!pool) {
    const left = creditBalance(credits);
    return `on API credits${credits.label ? ` (${credits.label})` : ""}${left ? `, ${left.text} left` : ""}, ${spent}`;
  }
  const back = typeof credits.subscriptionsBackAt === "number" && credits.subscriptionsBackAt > now
    ? `, subscriptions back in ${formatShortTimeUntil(credits.subscriptionsBackAt, now)}` : "";
  return `on API credits, ${pool.approximate ? "≈" : ""}${formatDollars(Math.max(0, pool.balanceUsd))} / ${formatDollars(pool.grantedUsd)} left${back}, ${spent}`;
}

/** "$199" (≈ while only an estimate) for the key in use, red under 10% of its grants; null from a daemon that does not send it. */
function creditBalance(credits: ApiCreditsUsage): { text: string; color: string } | null {
  if (typeof credits.balanceUsd !== "number") return null;
  const low = typeof credits.grantedUsd === "number" && credits.balanceUsd < credits.grantedUsd * LOW_CREDIT_FRACTION;
  return { text: `${credits.approximate ? "≈" : ""}${formatDollars(Math.max(0, credits.balanceUsd))}`, color: low ? theme.error : theme.accent };
}

/** "API credits max2" over "$199 left" (older daemons: "≈$1.23 this cycle"), while Claude turns run on them; null otherwise. */
export function apiCreditRows(credits: ApiCreditsUsage | null | undefined): { rows: string[]; width: number } | null {
  if (!credits?.active) return null;
  const head = `API credits${credits.label ? ` ${credits.label}` : ""}`;
  const balance = creditBalance(credits);
  const second = balance ? `${balance.text} left` : `≈${formatCents(credits.spentUsd)} this cycle`;
  const width = Math.max(head.length, second.length);
  return {
    width,
    rows: [
      `${theme.warning}API credits${theme.muted}${credits.label ? ` ${credits.label}` : ""}${theme.reset}${" ".repeat(width - head.length)}`,
      `${balance?.color ?? theme.accent}${second}${theme.reset}${" ".repeat(width - second.length)}`,
    ],
  };
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

/** Claude's credit rows replace the bars: while turns run on API credits, from a daemon that sends the pool. */
function creditPool(credits: ApiCreditsUsage | null | undefined): ApiCreditPool | null {
  return credits?.active && credits.pool ? credits.pool : null;
}

/** `side` beside `block` (and beside each of its narrower forms). */
function withSide(block: StatusBlock, side: { rows: string[]; width: number }): StatusBlock {
  const gap = "  ";
  return {
    ...block,
    width: block.width + gap.length + side.width,
    rows: block.rows.map((row, index) => `${row}${gap}${side.rows[index] ?? " ".repeat(side.width)}`),
    ...(block.narrower ? { narrower: block.narrower.map(form => withSide(form, side)) } : {}),
  };
}

export function usageBlock(state: RenderState): StatusBlock | null {
  if (!state.authByProvider[state.provider]) return null;

  const credits = state.usageByProvider[state.provider]?.apiCredits;
  const sides = [creditPool(credits) ? null : apiCreditRows(credits), proxyProblemRows(state)]
    .filter((side): side is { rows: string[]; width: number } => side !== null);
  const bars = usageBars(state);
  if (!bars) {
    const problem = sides.at(-1);
    return problem ? { id: "usage", priority: 3, width: problem.width, height: problem.rows.length, rows: problem.rows } : null;
  }
  return sides.reduce<StatusBlock>(withSide, bars);
}

function usageBars(state: RenderState): StatusBlock | null {
  const usage = state.usageByProvider[state.provider];
  const now = Date.now();
  if (usage?.apiKey) return apiKeyRows(usage.apiKey, now);
  const pool = creditPool(usage?.apiCredits);
  if (pool) return claudeCreditBlock(pool, now);
  if (!usage?.fiveHour && !usage?.sevenDay) return null;

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
