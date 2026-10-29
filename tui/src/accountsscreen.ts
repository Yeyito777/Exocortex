/**
 * Accounts screen: every Claude and OpenAI account as one row of a small
 * table on a card drawn over the chat, opened with /accounts or `g a` in
 * normal mode. A row is a state dot, the account, and its 5-hour and weekly
 * usage with the time to each reset; a short word replaces the bars when the
 * account cannot be used. A Credits column follows for accounts with prepaid
 * API credits (a Claude plan's, through the API-credit fallback; OpenAI's
 * `providers.openai.credit`): the balance, then the time until each grant
 * expires, the balance in bold blue with a ◀ while turns spend it, red under
 * a tenth of what was granted, with a leading ≈ while it is only an estimate
 * (never synced from the console, or synced hours ago), and a muted
 * "sign-in needed" when the console session it is read through is signed
 * out. The account this conversation runs on (OpenAI:
 * the current login) is highlighted and the one new work goes to is tagged. A
 * dim note under the table says how to sign an account in, only when there
 * is something to say. Data comes from
 * the daemon's `accounts` command, which keeps pushing snapshots while the
 * screen is open. It only opens when several accounts are set up; otherwise it
 * explains how to add one. The TUI asks for a snapshot as soon as it
 * connects (and reconnects), and again after anything the rows show may have
 * changed, so the screen opens at once with it, the first time too and over
 * /ssh, and refreshes in place when the daemon answers; a loading line shows
 * only if it opens before that first answer. The highlight for this conversation's
 * account comes from what earlier snapshots said about it, so it shows at
 * once too, also over /ssh. Esc or q closes; j/k scroll a card cut short by a
 * small terminal. While Claude goes through /proxy, the Claude rows are the
 * remote's accounts (its pool routes this machine's turns too) and the note
 * says so, or that the link is down.
 */

import type { AccountCredits, AccountsEvent, AccountsSnapshot, Event, ClaudeAccountInfo, ClaudeAccountsInfo } from "./protocol";
import type { ApiKeyCredit, UsageData, UsageWindow } from "./messages";
import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import type { ScreenRect } from "./historyimages";
import { moveTo } from "./frame";
import { maybeCensorEmail } from "./privacy";
import { pushSystemMessage } from "./state";
import { barFill } from "./statusblocks/usage";
import { theme } from "./theme";
import { termWidth, truncateToWidth } from "./textwidth";

export interface AccountsScreenState {
  /** Null while the first answer is on its way: the card shows a loading line. */
  snapshot: AccountsSnapshot | null;
  /** First content row shown when the card does not fit the terminal. */
  scroll: number;
}

/** An `accounts` request that opens the screen once its answer says it is enabled. */
export interface AccountsOpenRequest {
  reqId: string;
}

export const ACCOUNTS_UNAVAILABLE_HINT = [
  "The Accounts screen needs more than one account.",
  "Add a Claude account with /account claude add <name> and sign it in with the command it prints,",
  "or another OpenAI account with /login openai add.",
].join("\n");

export const ACCOUNTS_PROXIED_HINT = [
  "Claude goes through /proxy, and the remote's Claude accounts are not available:",
  "its link is not up yet, or its Exocortex is older and only lends its main account (update it there).",
].join("\n");

export interface AccountsRequester {
  accounts(options: { watch?: boolean; convId?: string | null }): string;
}

/**
 * Whether the screen would open, as far as the TUI knows without asking: the
 * Claude bars combine several accounts (here, or the /proxy remote's pool), or
 * several OpenAI accounts are signed in here. The status bar's usage block is
 * clickable only then.
 */
export function accountsScreenAvailable(state: Pick<RenderState, "usageByProvider" | "authInfoByProvider" | "providerProxies">): boolean {
  if ((state.usageByProvider.anthropic?.capacity ?? 0) > 100) return true;
  const openaiProxied = state.providerProxies?.some(proxy => proxy.provider === "openai") ?? false;
  return !openaiProxied && (state.authInfoByProvider.openai.accounts?.length ?? 0) > 1;
}

/**
 * /accounts and `g a`: open the screen right away, showing the last snapshot
 * this TUI saw (or a loading line), and ask for a fresh one to watch. The
 * answer fills it in, or closes it and explains when there's nothing to show.
 */
export function requestAccountsScreen(state: RenderState, daemon: AccountsRequester): void {
  if (state.accountsScreen) return;
  const cached = state.accountsSnapshotCache?.enabled ? forCurrentConversation(state, state.accountsSnapshotCache) : null;
  // With a single account the answer only explains; don't flash a loading card first.
  if (cached || accountsScreenAvailable(state)) state.accountsScreen = { snapshot: cached, scroll: 0 };
  state.accountsOpenRequest = { reqId: daemon.accounts({ watch: true, convId: state.convId }) };
}

/** Events after which the rows may differ: sign-ins, usage, account commands' answers, /proxy links. */
const ACCOUNTS_CHANGE_EVENTS: ReadonlySet<Event["type"]> = new Set(["tools_available", "usage_update", "auth_status", "provider_proxies"]);

export function accountsMayHaveChanged(event: Event): boolean {
  return ACCOUNTS_CHANGE_EVENTS.has(event.type);
}

/**
 * Ask for a snapshot ahead of opening, so the screen never waits a round trip.
 * Not while it is open (its watch pushes changes), and not while an earlier ask
 * is unanswered: the daemon builds the snapshot when it reaches the ask, so it
 * already reflects every event that arrives before the answer. `force` starts
 * over on a new connection, where an earlier ask may have been lost.
 */
export function prefetchAccounts(state: RenderState, daemon: AccountsRequester, options: { force?: boolean } = {}): void {
  if (state.accountsScreen || state.accountsOpenRequest) return;
  if (state.accountsPrefetchReqId && !options.force) return;
  state.accountsPrefetchReqId = daemon.accounts({ convId: state.convId });
}

/**
 * A daemon without the `accounts` command rejects the ask: say nothing. The
 * ask stays pending, so no more go out until the next connection.
 */
export function isAccountsPrefetchError(state: Pick<RenderState, "accountsPrefetchReqId">, event: Event): boolean {
  return event.type === "error" && event.reqId !== undefined && event.reqId === state.accountsPrefetchReqId;
}

export function closeAccountsScreen(state: RenderState, daemon: AccountsRequester | null): void {
  if (!state.accountsScreen && !state.accountsOpenRequest) return;
  state.accountsScreen = null;
  state.accountsOpenRequest = null;
  daemon?.accounts({ watch: false });
}

/** Remember which Claude account each conversation in the snapshot runs on. */
function rememberConversationAccounts(state: RenderState, snapshot: AccountsSnapshot): void {
  const known = state.claudeConversationAccounts;
  for (const account of snapshot.claude.accounts) {
    for (const conv of account.conversations) if (!conv.remote) known.set(conv.convId, account.id);
  }
  const current = snapshot.claude.currentConversation;
  if (current) known.set(current.convId, current.account);
}

/**
 * The snapshot as this conversation sees it: a snapshot asked for another
 * conversation (or none, like the answer to closing the screen) gets this
 * one's account from what earlier snapshots said, and no highlight when
 * none said.
 */
function forCurrentConversation(state: RenderState, snapshot: AccountsSnapshot): AccountsSnapshot {
  const convId = state.convId;
  const current = snapshot.claude.currentConversation;
  if (current?.convId === convId) return snapshot;
  const { currentConversation: _other, ...claude } = snapshot.claude;
  if (!convId || !state.claudeConversationAccounts.has(convId)) return { ...snapshot, claude };
  const account = state.claudeConversationAccounts.get(convId) ?? null;
  const entry = claude.accounts.find(info => info.id === account)?.conversations.find(conv => conv.convId === convId);
  return {
    ...snapshot,
    claude: { ...claude, currentConversation: { convId, account, lastUsedAt: entry?.lastUsedAt ?? null, warm: entry?.warm ?? false } },
  };
}

/** Apply an `accounts` event: fill in (or close and explain) for the pending request, refresh an open screen. */
export function handleAccountsEvent(state: RenderState, event: AccountsEvent): void {
  state.accountsSnapshotCache = event.snapshot;
  if (event.reqId && event.reqId === state.accountsPrefetchReqId) state.accountsPrefetchReqId = null;
  rememberConversationAccounts(state, event.snapshot);
  const request = state.accountsOpenRequest;
  if (request && event.reqId === request.reqId) {
    state.accountsOpenRequest = null;
    if (!event.snapshot.enabled) {
      state.accountsScreen = null;
      pushSystemMessage(state, event.snapshot.claude.proxied ? ACCOUNTS_PROXIED_HINT : ACCOUNTS_UNAVAILABLE_HINT, theme.muted);
      return;
    }
    state.accountsScreen ??= { snapshot: event.snapshot, scroll: 0 };
  }
  // A late answer to closing the screen names no conversation: keep this one's highlight.
  if (state.accountsScreen) state.accountsScreen.snapshot = forCurrentConversation(state, event.snapshot);
}

// ── Keys ─────────────────────────────────────────────────────────────

export type AccountsScreenKeyResult = { type: "close" } | { type: "handled" };

/** The screen owns the keyboard: Esc or q closes, j/k (or ↓/↑) scroll when the card is cut short. */
export function handleAccountsScreenKey(key: Readonly<KeyEvent>, screen: AccountsScreenState): AccountsScreenKeyResult {
  if (key.type === "escape") return { type: "close" };
  const char = key.type === "char" ? key.char : undefined;
  if (char === "q") return { type: "close" };
  const step = char === "j" || key.type === "down" ? 1 : char === "k" || key.type === "up" ? -1 : 0;
  // The renderer clamps the scroll to the content.
  if (step) screen.scroll = Math.max(0, screen.scroll + step);
  return { type: "handled" };
}

// ── Formatting ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${mins < 10 ? "0" : ""}${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** Time until a credit grant expires, coarse: "171d", "5h", "<1h". */
export function formatCreditCountdown(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `${hours}h`;
  return "<1h";
}

/** A window past its reset time has started over. */
function windowPercent(window: UsageWindow | null | undefined, now: number): number | null {
  if (!window) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return 0;
  return Math.round(window.utilization);
}

// ── Table ────────────────────────────────────────────────────────────

type Segment = [color: string, text: string];

/** One usage column of a row: a bar, its percent and the time to its reset. */
interface UsageCell {
  pct: number;
  reset: string;
}

/** The Credits column of a row: the balance, the countdowns to each grant's expiry, and whether turns spend it now. */
export interface CreditCell {
  amount: Segment;
  expiries: string;
  active: boolean;
  /** The console session the balance is read through is signed out. */
  signInNeeded?: boolean;
}

/** Share of the granted credits under which the balance shows red. */
const LOW_CREDIT_SHARE = 0.1;

/** The Credits cell for these credits; null when none is left unexpired. */
export function creditCell(credits: AccountCredits | null | undefined, now: number): CreditCell | null {
  if (!credits) return null;
  const expiries = credits.expiresAt.filter(at => at > now).sort((a, b) => a - b);
  // Nothing that expires later, and no grant that never does.
  if (expiries.length === 0 && !(credits.grantedUsd > 0 && credits.expiresAt.length === 0)) return null;
  const color = credits.active ? theme.bold + theme.accent
    : credits.balanceUsd < credits.grantedUsd * LOW_CREDIT_SHARE ? theme.error
    : theme.success;
  return {
    amount: [color, `${credits.approximate ? "≈" : ""}$${Math.max(0, Math.round(credits.balanceUsd))}`],
    expiries: expiries.map(at => formatCreditCountdown(at - now)).join(" · "),
    active: credits.active,
    ...(credits.signInNeeded ? { signInNeeded: true } : {}),
  };
}

/** OpenAI's API-key credit grant (`providers.openai.credit`) as account credits: it expires at the end of its last day; an estimate. */
export function openAICredits(credit: ApiKeyCredit | null | undefined): AccountCredits | null {
  if (!credit?.expires) return null;
  const [year, month, day] = credit.expires.split("-").map(Number);
  return {
    balanceUsd: Math.max(0, credit.amountUsd - credit.usedUsd),
    grantedUsd: credit.amountUsd,
    expiresAt: [new Date(year, month - 1, day + 1).getTime()],
    active: false,
    approximate: true,
  };
}

interface TableRow {
  dot: string;
  name: Segment;
  /** Short words after the name: "new work", "limited 2h". */
  tag?: Segment;
  /** 5-hour and weekly cells; an unknown window is left blank. */
  windows?: [UsageCell | null, UsageCell | null];
  /** A state that takes the usage columns' place: "blocked", "signed out". */
  note?: Segment[];
  credits?: CreditCell | null;
}

type ScreenLine =
  /** `columns`: the usage columns' labels; `credits`: the Credits label (some row of the section has credits). */
  | { kind: "heading"; label: string; columns: boolean; credits?: boolean }
  | { kind: "row"; row: TableRow }
  | { kind: "text"; segments: Segment[] }
  | { kind: "blank" };

function usageCell(window: UsageWindow | null | undefined, now: number): UsageCell | null {
  const pct = windowPercent(window, now);
  if (pct === null || !window) return null;
  return { pct, reset: window.resetsAt !== null && window.resetsAt > now ? formatDuration(window.resetsAt - now) : "" };
}

function usageCells(usage: UsageData | null | undefined, now: number): [UsageCell | null, UsageCell | null] | undefined {
  const cells: [UsageCell | null, UsageCell | null] = [usageCell(usage?.fiveHour, now), usageCell(usage?.sevenDay, now)];
  return cells[0] || cells[1] ? cells : undefined;
}

function claudeRow(account: ClaudeAccountInfo, claude: ClaudeAccountsInfo, now: number): TableRow {
  const holdsCurrent = claude.currentConversation?.account === account.id;
  const tags: string[] = [];
  let tagColor = theme.muted;
  let dot = theme.success;
  let note: Segment[] | undefined;
  switch (account.state) {
    case "ready": break;
    case "limited":
      dot = tagColor = theme.warning;
      tags.push(account.limitedUntil && account.limitedUntil > now ? `limited ${formatDuration(account.limitedUntil - now)}` : "limited");
      break;
    case "blocked": {
      dot = theme.error;
      const retry = account.blockedUntil && account.blockedUntil > now ? ` · retry in ${formatDuration(account.blockedUntil - now)}` : "";
      note = [[theme.error, "blocked"], [theme.muted, `${account.stateDetail ? `: ${account.stateDetail}` : ""}${retry}`]];
      break;
    }
    case "signed_out":
      dot = theme.error;
      note = [[theme.error, "signed out"]];
      break;
    case "not_subscription":
      dot = theme.warning;
      note = [[theme.warning, "not a subscription"], [theme.muted, account.stateDetail ? ` (${account.stateDetail})` : ""]];
      break;
    case "unchecked":
      dot = theme.muted;
      note = [[theme.muted, "checking…"]];
      break;
  }
  if (claude.nextNewWork?.account === account.id) tags.push("new work");
  return {
    dot,
    name: [holdsCurrent ? theme.bold + theme.accent : theme.text, account.id],
    tag: tags.length > 0 ? [tagColor, tags.join(" · ")] : undefined,
    windows: note ? undefined : usageCells(account.usage, now),
    note,
    credits: note ? null : creditCell(account.credits, now),
  };
}

/** Longest /proxy problem reason in the note. */
const MAX_PROXY_REASON = 48;

/** While the accounts are the /proxy remote's: a link or login problem, else whose accounts these are. */
function proxyNote(remote: NonNullable<ClaudeAccountsInfo["remote"]>): Segment[] {
  const problem = remote.state === "connecting" ? "connecting…"
    : remote.state === "disconnected" ? "down"
    : remote.message ? "cannot serve Claude"
    : null;
  if (problem) {
    // Clipped so the card keeps its table's width; /proxy has the whole reason.
    const reason = remote.message && remote.message.length > MAX_PROXY_REASON ? `${remote.message.slice(0, MAX_PROXY_REASON - 1)}…` : remote.message;
    return [[remote.state === "connecting" ? theme.muted : theme.error, `/proxy ${remote.alias} ${problem}`], [theme.muted, reason ? `: ${reason}` : ""]];
  }
  return [[theme.muted, `accounts on ${remote.alias} (/proxy)`]];
}

/** Everything the screen shows, top to bottom (no chrome). */
export function accountsScreenLines(state: RenderState, screen: AccountsScreenState, now = Date.now()): ScreenLine[] {
  if (!screen.snapshot) return [{ kind: "text", segments: [[theme.muted, "Loading accounts…"]] }];
  const { claude, openai } = screen.snapshot;
  const claudeTable = !claude.proxied && claude.accounts.length > 0;
  const lines: ScreenLine[] = [];
  const notes: Segment[][] = [];

  if (claude.proxied) {
    lines.push({ kind: "heading", label: "Claude", columns: false });
    lines.push({ kind: "text", segments: [[theme.muted, "  the remote daemon's login (/proxy)"]] });
  } else if (claudeTable) {
    const heading = { kind: "heading" as const, label: "Claude", columns: true, credits: false };
    lines.push(heading);
    for (const account of claude.accounts) {
      const row = claudeRow(account, claude, now);
      if (row.credits) heading.credits = true;
      lines.push({ kind: "row", row });
      if (account.loginCommand) notes.push([[theme.muted, `sign in ${account.id}${claude.remote ? ` on ${claude.remote.alias}` : ""}: `], [theme.command, account.loginCommand]]);
    }
    if (claude.remote) notes.unshift(proxyNote(claude.remote));
  }

  if (openai.accounts.length > 0) {
    if (lines.length > 0) lines.push({ kind: "blank" });
    const heading = { kind: "heading" as const, label: "OpenAI", columns: !claudeTable, credits: false };
    lines.push(heading);
    if (openai.proxied) lines.push({ kind: "text", segments: [[theme.muted, "  the remote daemon's login (/proxy)"]] });
    const usage = state.usageByProvider.openai ?? null;
    for (const account of openai.accounts) {
      const name = maybeCensorEmail(account.email, state.hideSensitiveInfo) ?? account.displayName ?? `account ${account.index}`;
      lines.push({
        kind: "row",
        row: {
          dot: account.current ? theme.success : theme.muted,
          name: [account.current ? theme.bold + theme.accent : theme.text, name],
          windows: account.current ? usageCells(usage, now) : undefined,
          credits: account.current ? creditCell(openAICredits(usage?.apiKey?.credit), now) : null,
        },
      });
      if (account.current && creditCell(openAICredits(usage?.apiKey?.credit), now)) heading.credits = true;
    }
  }

  if (notes.length > 0) {
    lines.push({ kind: "blank" });
    for (const note of notes) lines.push({ kind: "text", segments: note });
  }
  return lines;
}

// ── Layout ───────────────────────────────────────────────────────────

/** Space between the table's columns. */
const COLUMN_GAP = 3;
const DOT_WIDTH = 2;
const PCT_WIDTH = 4;
const MIN_BAR_WIDTH = 6;
/** Bars stop growing here: shorter than the status bar's, so the card stays small. */
const MAX_BAR_WIDTH = 14;
const COLUMN_LABELS = ["5-Hour", "Weekly"] as const;
/** A thin bar: stacked rows of full blocks would merge into one slab. */
const BAR_GLYPH = "━";

interface Columns {
  /** The name column (names and their tags), after the dot. */
  name: number;
  bar: number;
  /** Widest time to reset. */
  reset: number;
  /** Widest Credits cell; 0 when no row has credits (no column). */
  credits: number;
}

function cellWidth(columns: Columns): number {
  return columns.bar + 1 + PCT_WIDTH + (columns.reset > 0 ? 2 + columns.reset : 0);
}

function tableWidth(columns: Columns): number {
  return DOT_WIDTH + columns.name + 2 * (COLUMN_GAP + cellWidth(columns)) + (columns.credits > 0 ? COLUMN_GAP + columns.credits : 0);
}

const CREDITS_LABEL = "Credits";
const ACTIVE_MARK = " ◀";
const SIGN_IN_NOTE = " sign-in needed";

function creditWidth(cell: CreditCell): number {
  return termWidth(cell.amount[1]) + (cell.expiries ? 1 + termWidth(cell.expiries) : 0) + (cell.active ? termWidth(ACTIVE_MARK) : 0)
    + (cell.signInNeeded ? termWidth(SIGN_IN_NOTE) : 0);
}

/** Column widths for these lines, with bars as wide as `maxWidth` allows (up to MAX_BAR_WIDTH). */
function layoutColumns(lines: ScreenLine[], maxWidth: number): Columns {
  let name = 0;
  let reset = 0;
  let credits = 0;
  for (const line of lines) {
    if (line.kind === "heading") name = Math.max(name, termWidth(line.label) - DOT_WIDTH);
    if (line.kind !== "row") continue;
    const { row } = line;
    name = Math.max(name, termWidth(row.name[1]) + (row.tag ? 2 + termWidth(row.tag[1]) : 0));
    for (const cell of row.windows ?? []) if (cell) reset = Math.max(reset, cell.reset.length);
    if (row.credits) credits = Math.max(credits, termWidth(CREDITS_LABEL), creditWidth(row.credits));
  }
  const fixed = tableWidth({ name, bar: 0, reset, credits });
  const bar = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, Math.floor((maxWidth - fixed) / 2)));
  return { name, bar, reset, credits };
}

function cellSegments(cell: UsageCell | null, columns: Columns): Segment[] {
  if (!cell) return [[theme.text, " ".repeat(cellWidth(columns))]];
  const filled = barFill(cell.pct, 100, columns.bar);
  const segments: Segment[] = [
    [theme.accent, BAR_GLYPH.repeat(filled)],
    [theme.borderUnfocused, BAR_GLYPH.repeat(columns.bar - filled)],
    [theme.accent, ` ${`${cell.pct}%`.padStart(PCT_WIDTH)}`],
  ];
  if (columns.reset > 0) segments.push([theme.muted, `  ${cell.reset.padEnd(columns.reset)}`]);
  return segments;
}

function creditSegments(cell: CreditCell): Segment[] {
  return [
    cell.amount, [theme.boldOff, ""],
    ...(cell.expiries ? [[theme.muted, ` ${cell.expiries}`]] as Segment[] : []),
    ...(cell.active ? [[theme.accent, ACTIVE_MARK]] as Segment[] : []),
    ...(cell.signInNeeded ? [[theme.muted, SIGN_IN_NOTE]] as Segment[] : []),
  ];
}

function lineSegments(line: ScreenLine, columns: Columns): Segment[] {
  const gap: Segment = [theme.text, " ".repeat(COLUMN_GAP)];
  const blankCells: Segment = [theme.text, " ".repeat(2 * cellWidth(columns) + COLUMN_GAP)];
  switch (line.kind) {
    case "blank": return [];
    case "text": return line.segments;
    case "heading": {
      const label: Segment = [theme.bold + theme.text, line.label.padEnd(DOT_WIDTH + columns.name)];
      const credits: Segment[] = columns.credits > 0 && line.credits ? [gap, [theme.muted, CREDITS_LABEL]] : [];
      if (!line.columns) return credits.length > 0 ? [label, [theme.boldOff, ""], gap, blankCells, ...credits] : [label, [theme.boldOff, ""]];
      return [
        label, [theme.boldOff, ""], gap,
        [theme.muted, COLUMN_LABELS[0].padEnd(cellWidth(columns))], gap,
        [theme.muted, credits.length > 0 ? COLUMN_LABELS[1].padEnd(cellWidth(columns)) : COLUMN_LABELS[1]],
        ...credits,
      ];
    }
    case "row": {
      const { row } = line;
      const nameWidth = termWidth(row.name[1]) + (row.tag ? 2 + termWidth(row.tag[1]) : 0);
      const segments: Segment[] = [
        [row.dot, "● "],
        row.name, [theme.boldOff, ""],
        ...(row.tag ? [[theme.text, "  "], row.tag] as Segment[] : []),
        [theme.text, " ".repeat(Math.max(0, columns.name - nameWidth))],
        gap,
      ];
      if (row.note) return [...segments, ...row.note];
      const credits: Segment[] = row.credits && columns.credits > 0 ? [gap, ...creditSegments(row.credits)] : [];
      if (!row.windows) return credits.length > 0 ? [...segments, blankCells, ...credits] : segments;
      return [...segments, ...cellSegments(row.windows[0], columns), gap, ...cellSegments(row.windows[1], columns), ...credits];
    }
  }
}

// ── Render ───────────────────────────────────────────────────────────

const MARGIN_COLUMNS = 2;
/** Border plus two columns of padding on each side. */
const SIDE_COLUMNS = 6;
/** Top border, a blank row above and below the content, bottom border. */
const CHROME_ROWS = 4;
const TITLE = "Accounts";

function cleanText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function segmentsWidth(segments: Segment[]): number {
  return segments.reduce((sum, [, text]) => sum + termWidth(cleanText(text)), 0);
}

/** One content row: segments cut to `width`, then padded to it. */
function fitSegments(segments: Segment[], width: number, bg: string): string {
  let text = "";
  let used = 0;
  for (const [color, raw] of segments) {
    if (used >= width) break;
    const part = truncateToWidth(cleanText(raw), width - used);
    text += color + part;
    used += termWidth(part);
  }
  return text + theme.reset + bg + theme.boldOff + " ".repeat(Math.max(0, width - used));
}

/** `╭─ title ─────╮` and `╰──────── note ─╯` borders. */
function borderLine(corners: [string, string], width: number, leftText: string, rightText: string, leftColor = theme.muted): string {
  const inner = width - 2;
  const framed = (text: string) => text ? termWidth(text) + 3 : 0;
  const right = framed(leftText) + framed(rightText) <= inner ? rightText : "";
  const left = truncateToWidth(leftText, Math.max(0, inner - framed(right) - 3));
  const fill = "─".repeat(Math.max(0, inner - framed(left) - framed(right)));
  const border = theme.accent;
  return border + corners[0]
    + (left ? `─ ${leftColor}${left}${theme.reset}${theme.sidebarBg}${theme.boldOff}${border} ` : "")
    + fill
    + (right ? ` ${theme.muted}${right}${border} ─` : "")
    + corners[1];
}

export interface RenderedAccountsScreen {
  payload: string;
  rect: ScreenRect;
}

/**
 * The screen: a card sized to its table, centred over the chat, which stays
 * visible around it. Clamps `screen.scroll` to the content.
 */
export function renderAccountsScreen(state: RenderState, screen: AccountsScreenState, totalRows: number, totalCols: number, now = Date.now()): RenderedAccountsScreen {
  const lines = accountsScreenLines(state, screen, now);
  const maxInner = Math.max(16, totalCols - MARGIN_COLUMNS * 2 - SIDE_COLUMNS);
  const columns = layoutColumns(lines, maxInner);
  const content = lines.map(line => lineSegments(line, columns));
  const chromeWidth = termWidth(TITLE) + 8;
  const inner = Math.min(maxInner, Math.max(chromeWidth, ...content.map(segmentsWidth)));
  const width = inner + SIDE_COLUMNS;
  const bodyRows = Math.max(1, Math.min(content.length, totalRows - 2 - CHROME_ROWS));
  const height = bodyRows + CHROME_ROWS;
  const top = Math.max(1, Math.floor((totalRows - height) / 2) + 1);
  const left = Math.max(1, Math.floor((totalCols - width) / 2) + 1);
  const scroll = Math.max(0, Math.min(content.length - bodyRows, screen.scroll));
  screen.scroll = scroll;

  const bg = theme.sidebarBg;
  let payload = "";
  const row = (index: number, segments: Segment[]) => moveTo(top + index, left) + bg + theme.accent + "│  " + bg + fitSegments(segments, inner, bg) + theme.accent + "  │" + theme.reset;
  payload += moveTo(top, left) + bg + borderLine(["╭", "╮"], width, TITLE, "", theme.bold + theme.text) + theme.reset;
  payload += row(1, []);
  for (let i = 0; i < bodyRows; i++) payload += row(i + 2, content[scroll + i] ?? []);
  payload += row(bodyRows + 2, []);
  const below = content.length - scroll - bodyRows;
  const more = below > 0 ? `↓ ${below} more` : scroll > 0 ? "↑ more above" : "";
  payload += moveTo(top + height - 1, left) + bg + borderLine(["╰", "╯"], width, "", more) + theme.reset;
  return { payload, rect: { top, bottom: top + height - 1, left, right: left + width - 1 } };
}
