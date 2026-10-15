/**
 * Accounts screen: every Claude and OpenAI account on one full-screen card,
 * opened with /accounts or `g a` in normal mode. It shows the combined Claude
 * usage and where new work goes, then each Claude account's sign-in, state,
 * own 5-hour and weekly windows, and the conversations on it: running turns
 * one per row, warm-cache ones folded into a row that Enter expands. The
 * OpenAI pool follows. Data comes from the daemon's `accounts` command, which
 * keeps pushing snapshots while the screen is open. It only opens when several
 * accounts are set up; otherwise it explains how to add one. j/k select a
 * row, Enter opens a conversation (or expands the warm ones), Esc or q closes.
 */

import type { AccountConversationInfo, AccountsEvent, AccountsSnapshot, ClaudeAccountInfo } from "./protocol";
import type { UsageData, UsageWindow } from "./messages";
import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import type { ScreenRect } from "./historyimages";
import { moveTo } from "./frame";
import { maybeCensorEmail } from "./privacy";
import { pushSystemMessage } from "./state";
import { ACTIVITY_GLYPH } from "./sidebar/activityindicator";
import { BAR_WIDTH, barFill } from "./statusblocks/usage";
import { theme } from "./theme";
import { termWidth, truncateToWidth } from "./textwidth";

export interface AccountsScreenState {
  snapshot: AccountsSnapshot;
  /** Selected row: a conversation id or a warm-list toggle (`warm:<account>`); null when none is listed. */
  selected: string | null;
  /** Claude accounts whose warm conversations are listed one per row. */
  expanded: Set<string>;
  /** First content row shown (set by the renderer to keep the selection visible). */
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
      pushSystemMessage(state, ACCOUNTS_UNAVAILABLE_HINT, theme.muted);
      return;
    }
    state.accountsScreen = { snapshot: event.snapshot, selected: null, expanded: new Set(), scroll: 0 };
    const rows = selectableRows(state.accountsScreen, Date.now());
    const current = event.snapshot.claude.currentConversation?.convId;
    state.accountsScreen.selected = current && rows.includes(current) ? current : rows[0] ?? null;
    return;
  }
  const screen = state.accountsScreen;
  if (!screen) return;
  screen.snapshot = event.snapshot;
  const rows = selectableRows(screen, Date.now());
  if (screen.selected && !rows.includes(screen.selected)) {
    // A conversation whose turn ended folds into its account's warm row: keep the selection there.
    const account = event.snapshot.claude.accounts.find(account => account.conversations.some(conv => conv.convId === screen.selected));
    const toggle = account ? warmToggleKey(account.id) : null;
    screen.selected = toggle && rows.includes(toggle) ? toggle : rows[0] ?? null;
  } else if (!screen.selected) {
    screen.selected = rows[0] ?? null;
  }
}

// ── Keys ─────────────────────────────────────────────────────────────

export type AccountsScreenKeyResult = { type: "close" } | { type: "handled" } | { type: "open"; convId: string };

/** The screen owns the keyboard: j/k (or ↓/↑) select, Enter opens or expands, Esc or q closes. */
export function handleAccountsScreenKey(key: Readonly<KeyEvent>, screen: AccountsScreenState, now = Date.now()): AccountsScreenKeyResult {
  if (key.type === "escape") return { type: "close" };
  const char = key.type === "char" ? key.char : undefined;
  if (char === "q") return { type: "close" };
  if (key.type === "enter") {
    const toggled = screen.selected ? warmToggleAccount(screen.selected) : null;
    if (toggled !== null) {
      if (!screen.expanded.delete(toggled)) screen.expanded.add(toggled);
      return { type: "handled" };
    }
    return screen.selected ? { type: "open", convId: screen.selected } : { type: "handled" };
  }
  const step = char === "j" || key.type === "down" ? 1 : char === "k" || key.type === "up" ? -1 : 0;
  const rows = selectableRows(screen, now);
  if (step && rows.length > 0) {
    const index = screen.selected ? rows.indexOf(screen.selected) : -1;
    screen.selected = rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + step))];
  } else if (char === "g" || key.type === "home") {
    screen.selected = rows[0] ?? null;
    screen.scroll = 0;
  } else if (char === "G" || key.type === "end") {
    screen.selected = rows.at(-1) ?? null;
  }
  return { type: "handled" };
}

// ── Formatting ───────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${mins < 10 ? "0" : ""}${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** Local clock time: "14:30" within a day, "Sat 09:00" further out. */
export function formatClock(at: number, now: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (at - now < 20 * 60 * 60_000) return time;
  return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/**
 * A conversation title for one row: markdown emphasis and code marks dropped,
 * whitespace collapsed, and a title cut off mid-phrase (subagent titles are
 * the prompt's first words) ending in "…" rather than a dangling comma.
 */
export function displayTitle(raw: string): string {
  let title = raw
    .replace(/\s+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|~~|\*|`)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/\*\*|`/g, "")
    .replace(/^#+\s+/, "")
    .trim();
  if (/[,:;(–—-]$/.test(title)) title = title.replace(/[\s,:;(–—-]+$/, "") + "…";
  return title;
}

interface AccountStatus {
  /** Short state for the header's right edge. */
  label: string;
  color: string;
  /** A longer explanation on its own row, when the state needs one. */
  detail?: string;
}

function accountStatus(account: ClaudeAccountInfo, now: number): AccountStatus {
  switch (account.state) {
    case "ready": return { label: "ready", color: theme.success };
    case "limited":
      return account.limitedUntil
        ? { label: `limited until ${formatClock(account.limitedUntil, now)}`, color: theme.warning }
        : { label: "at a usage limit", color: theme.warning };
    case "blocked":
      return {
        label: "blocked",
        color: theme.error,
        detail: `${account.stateDetail ?? "authentication failed"}${account.blockedUntil ? ` · checked again in ${formatDuration(account.blockedUntil - now)}` : ""}`,
      };
    case "signed_out": return { label: "signed out", color: theme.error };
    case "not_subscription":
      return { label: "not a subscription", color: theme.warning, detail: `signed in with ${account.stateDetail ?? "an unknown method"}, not a Claude subscription` };
    case "unchecked": return { label: "not checked yet", color: theme.muted };
  }
}

/** A window past its reset time has started over. */
function windowPercent(window: UsageWindow | null | undefined, now: number): number | null {
  if (!window) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return 0;
  return Math.round(window.utilization);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Rows ─────────────────────────────────────────────────────────────

/** Up to this many warm conversations are listed outright; more fold into one row. */
const LIST_WARM_UP_TO = 2;
const WARM_TOGGLE_PREFIX = "warm:";

function warmToggleKey(accountId: string): string {
  return WARM_TOGGLE_PREFIX + accountId;
}

function warmToggleAccount(key: string): string | null {
  return key.startsWith(WARM_TOGGLE_PREFIX) ? key.slice(WARM_TOGGLE_PREFIX.length) : null;
}

type ListRow =
  | { kind: "conversation"; conv: AccountConversationInfo }
  | { kind: "warm"; accountId: string; count: number; expanded: boolean; afterOthers: boolean };

function rowKey(row: ListRow): string {
  return row.kind === "conversation" ? row.conv.convId : warmToggleKey(row.accountId);
}

/**
 * An account's conversation rows at `now`: running turns and this
 * conversation first, then the warm ones, folded behind a toggle when there
 * are more than LIST_WARM_UP_TO of them.
 */
function accountRows(screen: AccountsScreenState, account: ClaudeAccountInfo, now: number): ListRow[] {
  const { snapshot } = screen;
  const ttl = snapshot.claude.routing.cacheTtlMs;
  const current = snapshot.claude.currentConversation?.convId;
  const live = account.conversations.filter(conv => conv.running || conv.lastUsedAt + ttl > now);
  const shown = [
    ...live.filter(conv => conv.running),
    ...live.filter(conv => !conv.running && conv.convId === current),
  ];
  const warm = live.filter(conv => !shown.includes(conv));
  const rows: ListRow[] = shown.map(conv => ({ kind: "conversation", conv }));
  const warmRows: ListRow[] = warm.map(conv => ({ kind: "conversation", conv }));
  if (warm.length <= LIST_WARM_UP_TO) return [...rows, ...warmRows];
  const expanded = screen.expanded.has(account.id);
  rows.push({ kind: "warm", accountId: account.id, count: warm.length, expanded, afterOthers: shown.length > 0 });
  return expanded ? [...rows, ...warmRows] : rows;
}

/** Selectable row keys in display order. */
export function selectableRows(screen: AccountsScreenState, now: number): string[] {
  const { snapshot } = screen;
  if (snapshot.claude.proxied) return [];
  return snapshot.claude.accounts.flatMap(account => accountRows(screen, account, now).map(rowKey));
}

// ── Lines ────────────────────────────────────────────────────────────

type Segment = [color: string, text: string];

interface ScreenLine {
  segments: Segment[];
  /** Right-aligned segments (status, times). */
  right?: Segment[];
  /** Selectable row key. */
  key?: string;
}

/** Width of the "Claude" / "OpenAI" heading column. */
const HEADING_WIDTH = 9;
/** Indent of an account's detail rows under its name. */
const INDENT = "   ";

/** The status bar's usage bar: `[███░░░]` at the same width and colours. */
function bar(pct: number | null, capacity = 100): Segment[] {
  const filled = pct === null ? 0 : barFill(pct, capacity);
  return [[theme.text, "["], [theme.accent, "█".repeat(filled)], [theme.muted, "░".repeat(BAR_WIDTH - filled)], [theme.text, "]"]];
}

function windowLine(label: string, window: UsageWindow, now: number): ScreenLine {
  const pct = windowPercent(window, now);
  const reset: Segment[] = window.resetsAt !== null && window.resetsAt > now
    ? [[theme.muted, " resets in "], [theme.accent, formatDuration(window.resetsAt - now)], [theme.muted, ` (${formatClock(window.resetsAt, now)})`]]
    : [];
  return {
    segments: [
      [theme.muted, ` ${INDENT}${label} `],
      ...bar(pct),
      [theme.accent, ` ${pct === null ? "?" : pct}%`.padEnd(5)],
      ...reset,
    ],
  };
}

/** The 5-hour and weekly rows a usage report has (an unknown window is left out, not shown as "?"). */
function windowLines(usage: UsageData | null | undefined, now: number): ScreenLine[] {
  const lines: ScreenLine[] = [];
  if (usage?.fiveHour) lines.push(windowLine("5-Hour", usage.fiveHour, now));
  if (usage?.sevenDay) lines.push(windowLine("Weekly", usage.sevenDay, now));
  return lines;
}

function heading(text: string): Segment[] {
  return [[theme.text, " "], [theme.bold + theme.text, text.padEnd(HEADING_WIDTH)], [theme.boldOff, ""]];
}

function conversationTitle(state: RenderState, convId: string): string {
  const title = state.sidebar.conversations.find(conv => conv.id === convId)?.title;
  return (title && displayTitle(title)) || convId.slice(0, 8);
}

/** Combined bars as a share of every account's capacity, then where new work goes. */
function claudeSummaryLines(snapshot: AccountsSnapshot, now: number): ScreenLine[] {
  const { combined, routing, nextNewWork } = snapshot.claude;
  const capacity = combined?.capacity && combined.capacity > 0 ? combined.capacity : 100;
  const share = (window: UsageWindow | null | undefined): Segment[] => {
    const pct = windowPercent(window, now);
    const ofPool = pct === null ? null : Math.round((pct / capacity) * 100);
    return [...bar(ofPool), [theme.accent, ` ${ofPool === null ? "?" : ofPool}%`.padEnd(5)]];
  };
  const lines: ScreenLine[] = [{
    segments: [
      ...heading("Claude"),
      [theme.muted, "5-Hour "], ...share(combined?.fiveHour),
      [theme.muted, "  Weekly "], ...share(combined?.sevenDay),
      [theme.muted, "  combined"],
    ],
  }];
  const stay = `conversations stay while warm (${formatDuration(routing.cacheTtlMs)})`;
  lines.push({
    segments: nextNewWork
      ? [
        [theme.muted, " ".repeat(1 + HEADING_WIDTH) + "new work → "],
        [theme.text, nextNewWork.account],
        [theme.muted, ` · ${nextNewWork.detail} · ${stay}`],
      ]
      : [[theme.muted, " ".repeat(1 + HEADING_WIDTH)], [theme.warning, "no account can take new work"], [theme.muted, ` · ${stay}`]],
  });
  return lines;
}

function claudeAccountLines(state: RenderState, screen: AccountsScreenState, account: ClaudeAccountInfo, now: number): ScreenLine[] {
  const { snapshot } = screen;
  const holdsCurrent = snapshot.claude.currentConversation?.account === account.id;
  const email = maybeCensorEmail(account.email, state.hideSensitiveInfo);
  const who = [email, account.plan && capitalize(account.plan)].filter(Boolean).join(" · ");
  const status = accountStatus(account, now);
  const tags = [holdsCurrent ? "this conversation" : null, snapshot.claude.nextNewWork?.account === account.id ? "new work" : null]
    .filter(Boolean).join(" · ");
  const lines: ScreenLine[] = [{
    segments: [
      [theme.accent, holdsCurrent ? "▌" : " "],
      [theme.bold + (holdsCurrent ? theme.accent : theme.text), account.id],
      [theme.boldOff + theme.muted, who ? `  ${who}` : ""],
    ],
    right: [
      [theme.muted, tags ? `${tags}   ` : ""],
      [status.color, "● "],
      [status.label === "ready" ? theme.muted : status.color, status.label],
    ],
  }];
  if (status.detail) lines.push({ segments: [[status.color, ` ${INDENT}${status.detail}`]] });
  if (account.loginCommand) {
    lines.push({ segments: [[theme.muted, ` ${INDENT}sign in from a terminal: `], [theme.command, account.loginCommand]] });
  }
  const windows = windowLines(account.usage, now);
  if (windows.length === 0 && account.state === "ready") lines.push({ segments: [[theme.muted, ` ${INDENT}usage not reported yet`]] });
  lines.push(...windows);

  const rows = accountRows(screen, account, now);
  const ttl = snapshot.claude.routing.cacheTtlMs;
  for (const row of rows) {
    if (row.kind === "warm") {
      lines.push({
        key: rowKey(row),
        segments: [[theme.muted, ` ${INDENT}${row.expanded ? "▾" : "▸"} ${row.count} ${row.afterOthers ? "more" : "conversations"} with a warm cache`]],
      });
      continue;
    }
    const { conv } = row;
    const isCurrent = conv.convId === state.convId;
    lines.push({
      key: conv.convId,
      segments: [
        [theme.accent, ` ${INDENT}${conv.running ? ACTIVITY_GLYPH : " "} `],
        [isCurrent ? theme.accent : theme.text, conversationTitle(state, conv.convId)],
      ],
      right: [[theme.muted, conv.running ? "running" : `${formatDuration(conv.lastUsedAt + ttl - now)} left`]],
    });
  }
  const listedRunning = account.conversations.filter(conv => conv.running).length;
  const otherTurns = account.activeTurns - listedRunning;
  if (otherTurns > 0) {
    lines.push({ segments: [[theme.accent, ` ${INDENT}${ACTIVITY_GLYPH} `], [theme.muted, `${otherTurns} other turn${otherTurns === 1 ? "" : "s"} running`]] });
  }
  return lines;
}

function openAILines(state: RenderState, snapshot: AccountsSnapshot, usage: UsageData | null, now: number): ScreenLine[] {
  const { accounts, proxied } = snapshot.openai;
  if (accounts.length === 0) return [];
  const lines: ScreenLine[] = [
    { segments: [] },
    { segments: [...heading("OpenAI"), [theme.muted, proxied ? "through /proxy: the remote's login" : "/account <email> switches"]] },
  ];
  for (const account of accounts) {
    const email = maybeCensorEmail(account.email, state.hideSensitiveInfo);
    const label = email ?? account.displayName ?? `account ${account.index}`;
    const extra = [email ? account.displayName : null, account.plan && capitalize(account.plan)].filter(Boolean).join(" · ");
    lines.push({
      segments: [
        [theme.accent, account.current ? "▌" : " "],
        [theme.bold + (account.current ? theme.accent : theme.text), label],
        [theme.boldOff + theme.muted, extra ? `  ${extra}` : ""],
      ],
      right: account.current ? [[theme.muted, "current"]] : undefined,
    });
    if (account.current) lines.push(...windowLines(usage, now));
  }
  return lines;
}

/** Everything the screen shows, top to bottom (no chrome). */
export function accountsScreenLines(state: RenderState, screen: AccountsScreenState, now = Date.now()): ScreenLine[] {
  const { snapshot } = screen;
  const lines: ScreenLine[] = [];
  const claude = snapshot.claude;
  if (claude.proxied) {
    lines.push({ segments: [...heading("Claude"), [theme.muted, "through /proxy: the remote daemon's login runs every turn"]] });
  } else {
    lines.push(...claudeSummaryLines(snapshot, now));
    for (const account of claude.accounts) {
      lines.push({ segments: [] });
      lines.push(...claudeAccountLines(state, screen, account, now));
    }
  }
  lines.push(...openAILines(state, snapshot, state.usageByProvider.openai ?? null, now));
  return lines;
}

// ── Render ───────────────────────────────────────────────────────────

const MAX_WIDTH = 104;
const MARGIN_COLUMNS = 2;
/** Top border (with the title), a blank row above and below the content, bottom border (with the keys). */
const CHROME_ROWS = 4;

function cleanText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function segmentsWidth(segments: Segment[]): number {
  return segments.reduce((sum, [, text]) => sum + termWidth(cleanText(text)), 0);
}

function fitSegments(segments: Segment[], width: number): { text: string; used: number } {
  let text = "";
  let used = 0;
  for (const [color, raw] of segments) {
    if (used >= width) break;
    const part = truncateToWidth(cleanText(raw), width - used);
    text += color + part;
    used += termWidth(part);
  }
  return { text, used };
}

/** One content row: left segments truncated to leave room for the right-aligned ones. */
function fitLine(line: ScreenLine | undefined, width: number, bg: string): string {
  const right = line?.right && segmentsWidth(line.right) > 0 ? line.right : null;
  const rightWidth = right ? Math.min(segmentsWidth(right), Math.max(0, width - 12)) : 0;
  const left = fitSegments(line?.segments ?? [], right ? width - rightWidth - 2 : width);
  const out = left.text + theme.reset + bg + theme.boldOff;
  if (!right) return out + " ".repeat(Math.max(0, width - left.used));
  const fittedRight = fitSegments(right, rightWidth);
  return out + " ".repeat(Math.max(0, width - left.used - fittedRight.used)) + fittedRight.text + theme.reset + bg;
}

/** `╭─ title ───── note ─╮` and `╰─ … ─╯` borders with muted texts. */
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

function footerKeys(screen: AccountsScreenState): string {
  const toggled = screen.selected ? warmToggleAccount(screen.selected) : null;
  const enter = toggled === null ? "Enter open" : screen.expanded.has(toggled) ? "Enter collapse" : "Enter expand";
  return `j/k select · ${enter} · Esc close`;
}

export interface RenderedAccountsScreen {
  payload: string;
  rect: ScreenRect;
}

/**
 * The screen: a card centred over a blank backdrop that covers the whole
 * terminal, so no chat text shows around it. Updates `screen.scroll` to keep
 * the selection visible.
 */
export function renderAccountsScreen(state: RenderState, screen: AccountsScreenState, totalRows: number, totalCols: number, now = Date.now()): RenderedAccountsScreen {
  const lines = accountsScreenLines(state, screen, now);
  const width = Math.max(20, Math.min(MAX_WIDTH, totalCols - MARGIN_COLUMNS * 2));
  const inner = width - 4;
  const bodyRows = Math.max(1, Math.min(lines.length, totalRows - 2 - CHROME_ROWS));
  const height = bodyRows + CHROME_ROWS;
  const top = Math.max(1, Math.floor((totalRows - height) / 2) + 1);
  const left = Math.max(1, Math.floor((totalCols - width) / 2) + 1);

  const selectedLine = screen.selected ? lines.findIndex(line => line.key === screen.selected) : -1;
  const maxScroll = Math.max(0, lines.length - bodyRows);
  let scroll = Math.max(0, Math.min(maxScroll, screen.scroll));
  if (selectedLine >= 0) {
    if (selectedLine < scroll) scroll = selectedLine;
    else if (selectedLine >= scroll + bodyRows) scroll = selectedLine - bodyRows + 1;
  }
  screen.scroll = scroll;

  const bg = theme.sidebarBg;
  const blank = (row: number, col: number, cols: number) => cols > 0 ? moveTo(row, col) + theme.reset + " ".repeat(cols) : "";
  let payload = "";
  for (let row = 1; row <= totalRows; row++) {
    if (row < top || row >= top + height) payload += blank(row, 1, totalCols);
    else payload += blank(row, 1, left - 1) + blank(row, left + width, totalCols - left - width + 1);
  }

  const row = (index: number, content: string) => moveTo(top + index, left) + bg + theme.accent + "│ " + bg + content + bg + theme.accent + " │" + theme.reset;
  payload += moveTo(top, left) + bg + borderLine(["╭", "╮"], width, "Accounts", `updated ${formatClock(screen.snapshot.generatedAt, now)}`, theme.bold + theme.text) + theme.reset;
  payload += row(1, fitLine(undefined, inner, bg));
  for (let i = 0; i < bodyRows; i++) {
    const line = lines[scroll + i];
    const lineBg = line?.key !== undefined && line.key === screen.selected ? theme.sidebarSelBg : bg;
    payload += row(i + 2, lineBg + fitLine(line, inner, lineBg) + bg);
  }
  payload += row(bodyRows + 2, fitLine(undefined, inner, bg));
  const below = lines.length - scroll - bodyRows;
  const more = below > 0 ? `↓ ${below} more` : scroll > 0 ? "↑ more above" : "";
  payload += moveTo(top + height - 1, left) + bg + borderLine(["╰", "╯"], width, footerKeys(screen), more) + theme.reset;
  return { payload, rect: { top: 1, bottom: totalRows, left: 1, right: totalCols } };
}
