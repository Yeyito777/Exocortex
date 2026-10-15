/**
 * Accounts screen: every Claude and OpenAI account as one row of a small
 * table on a card over a blank backdrop, opened with /accounts or `g a` in
 * normal mode. A row is a state dot, the account, and its 5-hour and weekly
 * usage with the time to each reset; a short word replaces the bars when the
 * account cannot be used. The account this conversation runs on (OpenAI: the
 * current login) is highlighted and the one new work goes to is tagged. A dim
 * note under the table says why new work skips an account near its limit and
 * how to sign one in, only when there is something to say. Data comes from
 * the daemon's `accounts` command, which keeps pushing snapshots while the
 * screen is open. It only opens when several accounts are set up; otherwise it
 * explains how to add one. Esc or q closes; j/k scroll a card cut short by a
 * small terminal. While Claude goes through /proxy, the Claude rows are the
 * remote's accounts (its pool routes this machine's turns too) and the note
 * says so, or that the link is down.
 */

import type { AccountsEvent, AccountsSnapshot, ClaudeAccountInfo, ClaudeAccountsInfo } from "./protocol";
import type { UsageData, UsageWindow } from "./messages";
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
  snapshot: AccountsSnapshot;
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

/** /accounts and `g a`: ask for a snapshot and watch it; the answer opens the screen or explains. */
export function requestAccountsScreen(state: RenderState, daemon: AccountsRequester): void {
  if (state.accountsScreen) return;
  state.accountsOpenRequest = { reqId: daemon.accounts({ watch: true, convId: state.convId }) };
}

export function closeAccountsScreen(state: RenderState, daemon: AccountsRequester | null): void {
  if (!state.accountsScreen && !state.accountsOpenRequest) return;
  state.accountsScreen = null;
  state.accountsOpenRequest = null;
  daemon?.accounts({ watch: false });
}

/** Apply an `accounts` event: open (or explain) for the pending request, refresh an open screen. */
export function handleAccountsEvent(state: RenderState, event: AccountsEvent): void {
  const request = state.accountsOpenRequest;
  if (request && event.reqId === request.reqId) {
    state.accountsOpenRequest = null;
    if (!event.snapshot.enabled) {
      pushSystemMessage(state, event.snapshot.claude.proxied ? ACCOUNTS_PROXIED_HINT : ACCOUNTS_UNAVAILABLE_HINT, theme.muted);
      return;
    }
    state.accountsScreen = { snapshot: event.snapshot, scroll: 0 };
    return;
  }
  if (state.accountsScreen) state.accountsScreen.snapshot = event.snapshot;
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

interface TableRow {
  dot: string;
  name: Segment;
  /** Short words after the name: "new work", "limited 2h". */
  tag?: Segment;
  /** 5-hour and weekly cells; an unknown window is left blank. */
  windows?: [UsageCell | null, UsageCell | null];
  /** A state that takes the usage columns' place: "blocked", "signed out". */
  note?: Segment[];
}

type ScreenLine =
  | { kind: "heading"; label: string; columns: boolean }
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

/** The window an account is too close to for new work, by the routing floors. */
function nearLimit(account: ClaudeAccountInfo, claude: ClaudeAccountsInfo, now: number): "weekly" | "5-hour" | null {
  const weekly = windowPercent(account.usage?.sevenDay, now);
  if (weekly !== null && 100 - weekly < claude.routing.weeklyFloor) return "weekly";
  const fiveHour = windowPercent(account.usage?.fiveHour, now);
  if (fiveHour !== null && 100 - fiveHour < claude.routing.fiveHourFloor) return "5-hour";
  return null;
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
  };
}

/** Why new work skips a usable account, or that none can take it; null when the "new work" tag says it all. */
function routingNote(claude: ClaudeAccountsInfo, now: number): Segment[] | null {
  const next = claude.nextNewWork;
  if (!next) return claude.accounts.length > 0 ? [[theme.warning, "no account can take new work"]] : null;
  const chosen = claude.accounts.find(account => account.id === next.account);
  if (chosen && nearLimit(chosen, claude, now)) {
    return [[theme.muted, `every account is near a limit → new work goes to ${next.account}`]];
  }
  const skipped = claude.accounts.filter(account => account.id !== next.account && account.state === "ready" && nearLimit(account, claude, now));
  if (skipped.length === 0) return null;
  const why = skipped.length === 1
    ? `${skipped[0]!.id} is near its ${nearLimit(skipped[0]!, claude, now)} limit`
    : `${skipped.map(account => account.id).join(", ")} are near their limits`;
  return [[theme.muted, `${why} → new work goes to ${next.account}`]];
}

/** Longest /proxy problem reason in the note. */
const MAX_PROXY_REASON = 48;

/**
 * While the accounts are the /proxy remote's: a link or login problem first,
 * else the routing note marked with the remote's name, else whose accounts
 * these are.
 */
function proxyNote(remote: NonNullable<ClaudeAccountsInfo["remote"]>, routing: Segment[] | null): Segment[] {
  const problem = remote.state === "connecting" ? "connecting…"
    : remote.state === "disconnected" ? "down"
    : remote.message ? "cannot serve Claude"
    : null;
  if (problem) {
    // Clipped so the card keeps its table's width; /proxy has the whole reason.
    const reason = remote.message && remote.message.length > MAX_PROXY_REASON ? `${remote.message.slice(0, MAX_PROXY_REASON - 1)}…` : remote.message;
    return [[remote.state === "connecting" ? theme.muted : theme.error, `/proxy ${remote.alias} ${problem}`], [theme.muted, reason ? `: ${reason}` : ""]];
  }
  if (routing) return [[theme.muted, `on ${remote.alias}: `], ...routing];
  return [[theme.muted, `accounts on ${remote.alias} (/proxy)`]];
}

/** Everything the screen shows, top to bottom (no chrome). */
export function accountsScreenLines(state: RenderState, screen: AccountsScreenState, now = Date.now()): ScreenLine[] {
  const { claude, openai } = screen.snapshot;
  const claudeTable = !claude.proxied && claude.accounts.length > 0;
  const lines: ScreenLine[] = [];
  const notes: Segment[][] = [];

  if (claude.proxied) {
    lines.push({ kind: "heading", label: "Claude", columns: false });
    lines.push({ kind: "text", segments: [[theme.muted, "  the remote daemon's login (/proxy)"]] });
  } else if (claudeTable) {
    lines.push({ kind: "heading", label: "Claude", columns: true });
    for (const account of claude.accounts) {
      lines.push({ kind: "row", row: claudeRow(account, claude, now) });
      if (account.loginCommand) notes.push([[theme.muted, `sign in ${account.id}${claude.remote ? ` on ${claude.remote.alias}` : ""}: `], [theme.command, account.loginCommand]]);
    }
    const routing = claude.remote ? proxyNote(claude.remote, routingNote(claude, now)) : routingNote(claude, now);
    if (routing) notes.unshift(routing);
  }

  if (openai.accounts.length > 0) {
    if (lines.length > 0) lines.push({ kind: "blank" });
    lines.push({ kind: "heading", label: "OpenAI", columns: !claudeTable });
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
        },
      });
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
}

function cellWidth(columns: Columns): number {
  return columns.bar + 1 + PCT_WIDTH + (columns.reset > 0 ? 2 + columns.reset : 0);
}

function tableWidth(columns: Columns): number {
  return DOT_WIDTH + columns.name + 2 * (COLUMN_GAP + cellWidth(columns));
}

/** Column widths for these lines, with bars as wide as `maxWidth` allows (up to MAX_BAR_WIDTH). */
function layoutColumns(lines: ScreenLine[], maxWidth: number): Columns {
  let name = 0;
  let reset = 0;
  for (const line of lines) {
    if (line.kind === "heading") name = Math.max(name, termWidth(line.label) - DOT_WIDTH);
    if (line.kind !== "row") continue;
    const { row } = line;
    name = Math.max(name, termWidth(row.name[1]) + (row.tag ? 2 + termWidth(row.tag[1]) : 0));
    for (const cell of row.windows ?? []) if (cell) reset = Math.max(reset, cell.reset.length);
  }
  const fixed = tableWidth({ name, bar: 0, reset });
  const bar = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, Math.floor((maxWidth - fixed) / 2)));
  return { name, bar, reset };
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

function lineSegments(line: ScreenLine, columns: Columns): Segment[] {
  const gap: Segment = [theme.text, " ".repeat(COLUMN_GAP)];
  switch (line.kind) {
    case "blank": return [];
    case "text": return line.segments;
    case "heading": {
      const label: Segment = [theme.bold + theme.text, line.label.padEnd(DOT_WIDTH + columns.name)];
      if (!line.columns) return [label, [theme.boldOff, ""]];
      return [
        label, [theme.boldOff, ""], gap,
        [theme.muted, COLUMN_LABELS[0].padEnd(cellWidth(columns))], gap,
        [theme.muted, COLUMN_LABELS[1]],
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
      if (!row.windows) return segments;
      return [...segments, ...cellSegments(row.windows[0], columns), gap, ...cellSegments(row.windows[1], columns)];
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
const KEYS = "Esc close";

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

/** `╭─ title ─────╮` and `╰─ keys ───── note ─╯` borders. */
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
 * The screen: a card sized to its table, centred over a blank backdrop that
 * covers the whole terminal so no chat text shows around it. Clamps
 * `screen.scroll` to the content.
 */
export function renderAccountsScreen(state: RenderState, screen: AccountsScreenState, totalRows: number, totalCols: number, now = Date.now()): RenderedAccountsScreen {
  const lines = accountsScreenLines(state, screen, now);
  const maxInner = Math.max(16, totalCols - MARGIN_COLUMNS * 2 - SIDE_COLUMNS);
  const columns = layoutColumns(lines, maxInner);
  const content = lines.map(line => lineSegments(line, columns));
  const chromeWidth = termWidth(TITLE) + termWidth(KEYS) + 8;
  const inner = Math.min(maxInner, Math.max(chromeWidth, ...content.map(segmentsWidth)));
  const width = inner + SIDE_COLUMNS;
  const bodyRows = Math.max(1, Math.min(content.length, totalRows - 2 - CHROME_ROWS));
  const height = bodyRows + CHROME_ROWS;
  const top = Math.max(1, Math.floor((totalRows - height) / 2) + 1);
  const left = Math.max(1, Math.floor((totalCols - width) / 2) + 1);
  const scroll = Math.max(0, Math.min(content.length - bodyRows, screen.scroll));
  screen.scroll = scroll;

  const bg = theme.sidebarBg;
  const blank = (row: number, col: number, cols: number) => cols > 0 ? moveTo(row, col) + theme.reset + " ".repeat(cols) : "";
  let payload = "";
  for (let row = 1; row <= totalRows; row++) {
    if (row < top || row >= top + height) payload += blank(row, 1, totalCols);
    else payload += blank(row, 1, left - 1) + blank(row, left + width, totalCols - left - width + 1);
  }

  const row = (index: number, segments: Segment[]) => moveTo(top + index, left) + bg + theme.accent + "│  " + bg + fitSegments(segments, inner, bg) + theme.accent + "  │" + theme.reset;
  payload += moveTo(top, left) + bg + borderLine(["╭", "╮"], width, TITLE, "", theme.bold + theme.text) + theme.reset;
  payload += row(1, []);
  for (let i = 0; i < bodyRows; i++) payload += row(i + 2, content[scroll + i] ?? []);
  payload += row(bodyRows + 2, []);
  const below = content.length - scroll - bodyRows;
  const more = below > 0 ? `↓ ${below} more` : scroll > 0 ? "↑ more above" : "";
  payload += moveTo(top + height - 1, left) + bg + borderLine(["╰", "╯"], width, KEYS, more) + theme.reset;
  return { payload, rect: { top: 1, bottom: totalRows, left: 1, right: totalCols } };
}
