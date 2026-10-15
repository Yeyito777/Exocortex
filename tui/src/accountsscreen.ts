/**
 * Accounts screen: every Claude and OpenAI account on one large overlay, opened
 * with /accounts or `g a` in normal mode. It shows each Claude account's
 * sign-in, plan, own 5-hour and weekly windows, running turns and the
 * conversations on it (running or with a warm cache), the combined bars and
 * the routing rule, and the OpenAI pool. Data comes from the daemon's
 * `accounts` command, which keeps pushing snapshots while the screen is open.
 * It only opens when several accounts are set up; otherwise it explains how
 * to add one. j/k select a conversation, Enter opens it, Esc or q closes.
 */

import type { AccountsEvent, AccountsSnapshot, ClaudeAccountInfo } from "./protocol";
import type { UsageData, UsageWindow } from "./messages";
import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import type { ScreenRect } from "./historyimages";
import { moveTo } from "./frame";
import { maybeCensorEmail } from "./privacy";
import { pushSystemMessage } from "./state";
import { theme } from "./theme";
import { termWidth, truncateToWidth } from "./textwidth";

export interface AccountsScreenState {
  snapshot: AccountsSnapshot;
  /** Selected conversation row; null when none is listed. */
  selectedConvId: string | null;
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
    state.accountsScreen = { snapshot: event.snapshot, selectedConvId: null, scroll: 0 };
    const rows = selectableConvIds(state.accountsScreen, Date.now());
    const current = event.snapshot.claude.currentConversation?.convId;
    state.accountsScreen.selectedConvId = current && rows.includes(current) ? current : rows[0] ?? null;
    return;
  }
  const screen = state.accountsScreen;
  if (!screen) return;
  screen.snapshot = event.snapshot;
  const rows = selectableConvIds(screen, Date.now());
  if (!screen.selectedConvId || !rows.includes(screen.selectedConvId)) screen.selectedConvId = rows[0] ?? null;
}

// ── Keys ─────────────────────────────────────────────────────────────

export type AccountsScreenKeyResult = { type: "close" } | { type: "handled" } | { type: "open"; convId: string };

/** The screen owns the keyboard: j/k (or ↓/↑) select, Enter opens, Esc or q closes. */
export function handleAccountsScreenKey(key: Readonly<KeyEvent>, screen: AccountsScreenState, now = Date.now()): AccountsScreenKeyResult {
  if (key.type === "escape") return { type: "close" };
  const char = key.type === "char" ? key.char : undefined;
  if (char === "q") return { type: "close" };
  if (key.type === "enter") {
    return screen.selectedConvId ? { type: "open", convId: screen.selectedConvId } : { type: "handled" };
  }
  const step = char === "j" || key.type === "down" ? 1 : char === "k" || key.type === "up" ? -1 : 0;
  const rows = selectableConvIds(screen, now);
  if (step && rows.length > 0) {
    const index = screen.selectedConvId ? rows.indexOf(screen.selectedConvId) : -1;
    screen.selectedConvId = rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + step))];
  } else if (char === "g" || key.type === "home") {
    screen.selectedConvId = rows[0] ?? null;
    screen.scroll = 0;
  } else if (char === "G" || key.type === "end") {
    screen.selectedConvId = rows.at(-1) ?? null;
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

function accountStateLabel(account: ClaudeAccountInfo, now: number): { text: string; color: string } {
  switch (account.state) {
    case "ready": return { text: "ready", color: theme.success };
    case "limited":
      return {
        text: account.limitedUntil ? `limited until ${formatClock(account.limitedUntil, now)} (${formatDuration(account.limitedUntil - now)})` : "at a usage limit",
        color: theme.warning,
      };
    case "blocked":
      return {
        text: `blocked: ${account.stateDetail ?? "authentication failed"}${account.blockedUntil ? ` (checked again in ${formatDuration(account.blockedUntil - now)})` : ""}`,
        color: theme.error,
      };
    case "signed_out": return { text: "signed out", color: theme.error };
    case "not_subscription": return { text: `signed in with ${account.stateDetail ?? "an unknown method"}, not a Claude subscription`, color: theme.warning };
    case "unchecked": return { text: "not checked yet", color: theme.muted };
  }
}

/** A window past its reset time has started over. */
function windowPercent(window: UsageWindow | null | undefined, now: number): number | null {
  if (!window) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return 0;
  return Math.round(window.utilization);
}

// ── Lines ────────────────────────────────────────────────────────────

type Segment = [color: string, text: string];

interface ScreenLine {
  segments: Segment[];
  /** Selectable conversation row. */
  convId?: string;
}

function bar(pct: number | null, capacity: number, width: number): Segment[] {
  if (pct === null) return [[theme.text, "["], [theme.muted, "░".repeat(width)], [theme.text, "]"]];
  const filled = Math.round((Math.max(0, Math.min(capacity, pct)) / capacity) * width);
  return [[theme.text, "["], [theme.accent, "█".repeat(filled)], [theme.muted, "░".repeat(width - filled)], [theme.text, "]"]];
}

function windowLine(label: string, window: UsageWindow | null | undefined, now: number): Segment[] {
  const pct = windowPercent(window, now);
  const reset = window?.resetsAt != null && window.resetsAt > now
    ? [[theme.muted, "  resets in "], [theme.accent, formatDuration(window.resetsAt - now)], [theme.muted, ` (${formatClock(window.resetsAt, now)})`]] as Segment[]
    : [];
  return [
    [theme.muted, `    ${label} `],
    ...bar(pct, 100, 20),
    [theme.accent, ` ${pct === null ? "?" : pct}%`.padEnd(5)],
    ...reset,
  ];
}

function combinedPart(label: string, window: UsageWindow | null | undefined, capacity: number, now: number): Segment[] {
  const pct = windowPercent(window, now);
  return [[theme.muted, `${label} `], ...bar(pct, capacity, 8), [theme.accent, ` ${pct === null ? "?" : pct}/${capacity}%`]];
}

function routingRule(snapshot: AccountsSnapshot): string {
  const routing = snapshot.claude.routing;
  const next = snapshot.claude.nextNewWork ? ` (${snapshot.claude.nextNewWork.account})` : "";
  return `routing: stays while cache warm (${formatDuration(routing.cacheTtlMs)}) · new work → soonest weekly reset${next}`;
}

function conversationTitle(state: RenderState, convId: string): string {
  const title = state.sidebar.conversations.find(conv => conv.id === convId)?.title?.trim();
  return title || convId.slice(0, 8);
}

/** Conversation rows still on their account at `now`, in display order. */
function liveConversations(account: ClaudeAccountInfo, snapshot: AccountsSnapshot, now: number) {
  const ttl = snapshot.claude.routing.cacheTtlMs;
  return account.conversations.filter(conv => conv.running || conv.lastUsedAt + ttl > now);
}

export function selectableConvIds(screen: AccountsScreenState, now: number): string[] {
  const { snapshot } = screen;
  if (snapshot.claude.proxied) return [];
  return snapshot.claude.accounts.flatMap(account => liveConversations(account, snapshot, now).map(conv => conv.convId));
}

function claudeAccountLines(state: RenderState, screen: AccountsScreenState, account: ClaudeAccountInfo, now: number): ScreenLine[] {
  const { snapshot } = screen;
  const current = snapshot.claude.currentConversation;
  const isCurrent = current?.account === account.id && current.convId === state.convId;
  const email = maybeCensorEmail(account.email, state.hideSensitiveInfo);
  const who = [email, account.plan].filter(Boolean).join(" · ");
  const status = accountStateLabel(account, now);
  const lines: ScreenLine[] = [{
    segments: [
      [isCurrent ? theme.accent : theme.muted, isCurrent ? "▌" : " "],
      [theme.bold + (isCurrent ? theme.accent : theme.text), account.id],
      [theme.boldOff + theme.muted, who ? `  ${who}` : ""],
      [theme.muted, "  ·  "],
      [status.color, status.text],
      ...(isCurrent ? [[theme.accent, "  · this conversation"] as Segment] : []),
    ],
  }];
  if (account.state === "ready" || account.state === "limited" || account.usage) {
    lines.push({ segments: windowLine("5-hour", account.usage?.fiveHour, now) });
    lines.push({ segments: windowLine("weekly", account.usage?.sevenDay, now) });
  }
  const conversations = liveConversations(account, snapshot, now);
  const warm = conversations.filter(conv => conv.lastUsedAt + snapshot.claude.routing.cacheTtlMs > now).length;
  const activity = [
    account.activeTurns > 0 ? `${account.activeTurns} turn${account.activeTurns === 1 ? "" : "s"} running` : null,
    warm > 0 ? `${warm} conversation${warm === 1 ? "" : "s"} with a warm cache` : null,
  ].filter(Boolean).join(" · ");
  lines.push({ segments: [[theme.muted, `    ${activity || "idle"}`]] });
  for (const conv of conversations) {
    const left = conv.lastUsedAt + snapshot.claude.routing.cacheTtlMs - now;
    const isCurrentConv = conv.convId === state.convId;
    lines.push({
      convId: conv.convId,
      segments: [
        [isCurrentConv ? theme.accent : theme.muted, isCurrentConv ? "    ▸ " : "      "],
        [isCurrentConv ? theme.accent : theme.text, conversationTitle(state, conv.convId)],
        [theme.muted, "  ·  "],
        conv.running
          ? [theme.accent, "running"]
          : [theme.muted, `warm, ${formatDuration(left)} left`],
      ],
    });
  }
  if (account.loginCommand) {
    lines.push({ segments: [[theme.muted, "    sign in from a terminal: "], [theme.command, account.loginCommand]] });
  }
  lines.push({ segments: [[theme.muted, `    ${account.configDir}`]] });
  return lines;
}

function openAILines(state: RenderState, snapshot: AccountsSnapshot, usage: UsageData | null, now: number): ScreenLine[] {
  const { accounts, proxied } = snapshot.openai;
  if (accounts.length === 0) return [];
  const lines: ScreenLine[] = [{ segments: [] }, { segments: [[theme.bold + theme.text, "OpenAI"], [theme.boldOff + theme.muted, proxied ? "  ·  through /proxy (the remote's login)" : "  ·  /account <email> switches"]] }];
  for (const account of accounts) {
    const label = maybeCensorEmail(account.email, state.hideSensitiveInfo) ?? account.displayName ?? `account ${account.index}`;
    lines.push({
      segments: [
        [account.current ? theme.accent : theme.muted, account.current ? "▌" : " "],
        [theme.bold + (account.current ? theme.accent : theme.text), `${account.index}. ${label}`],
        [theme.boldOff + theme.muted, account.plan ? `  ${account.plan}` : ""],
        ...(account.current ? [[theme.accent, "  · current"] as Segment] : []),
      ],
    });
    if (account.current && usage && (usage.fiveHour || usage.sevenDay)) {
      lines.push({ segments: windowLine("5-hour", usage.fiveHour, now) });
      lines.push({ segments: windowLine("weekly", usage.sevenDay, now) });
    }
  }
  return lines;
}

/** Everything the screen shows, top to bottom (no chrome). */
export function accountsScreenLines(state: RenderState, screen: AccountsScreenState, now = Date.now()): ScreenLine[] {
  const { snapshot } = screen;
  const lines: ScreenLine[] = [];
  const claude = snapshot.claude;
  if (claude.proxied) {
    lines.push({ segments: [[theme.bold + theme.text, "Claude"], [theme.boldOff + theme.muted, "  ·  through /proxy: the remote daemon's login runs every turn"]] });
  } else {
    const combined = claude.combined;
    const capacity = combined?.capacity && combined.capacity > 0 ? combined.capacity : 100;
    lines.push({
      segments: [
        [theme.bold + theme.text, "Claude "],
        [theme.boldOff, ""],
        ...combinedPart("5h", combined?.fiveHour, capacity, now),
        [theme.muted, " · "],
        ...combinedPart("wk", combined?.sevenDay, capacity, now),
        [theme.muted, " · "],
        [theme.muted, routingRule(snapshot)],
      ],
    });
    for (const account of claude.accounts) {
      lines.push({ segments: [] });
      lines.push(...claudeAccountLines(state, screen, account, now));
    }
  }
  lines.push(...openAILines(state, snapshot, state.usageByProvider.openai ?? null, now));
  return lines;
}

// ── Render ───────────────────────────────────────────────────────────

const MAX_WIDTH = 140;
const MARGIN_COLUMNS = 2;
/** Top border (with the title), spacer, footer, bottom border. */
const CHROME_ROWS = 4;
const FOOTER = "j/k select · Enter open conversation · Esc close";

function fitSegments(segments: Segment[], width: number, bg: string): string {
  let out = "";
  let used = 0;
  for (const [color, text] of segments) {
    if (used >= width) break;
    const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    const part = truncateToWidth(clean, width - used);
    out += color + part;
    used += termWidth(part);
  }
  return out + theme.reset + bg + " ".repeat(Math.max(0, width - used));
}

export interface RenderedAccountsScreen {
  payload: string;
  rect: ScreenRect;
}

/** The overlay, centered over the whole terminal. Updates `screen.scroll` to keep the selection visible. */
export function renderAccountsScreen(state: RenderState, screen: AccountsScreenState, totalRows: number, totalCols: number, now = Date.now()): RenderedAccountsScreen {
  const lines = accountsScreenLines(state, screen, now);
  const width = Math.max(10, Math.min(MAX_WIDTH, totalCols - MARGIN_COLUMNS * 2));
  const inner = width - 4;
  const bodyRows = Math.max(1, Math.min(lines.length, totalRows - 2 - CHROME_ROWS));
  const height = bodyRows + CHROME_ROWS;
  const top = Math.max(1, Math.floor((totalRows - height) / 2) + 1);
  const left = Math.max(1, Math.floor((totalCols - width) / 2) + 1);

  const selectedLine = screen.selectedConvId ? lines.findIndex(line => line.convId === screen.selectedConvId) : -1;
  const maxScroll = Math.max(0, lines.length - bodyRows);
  let scroll = Math.max(0, Math.min(maxScroll, screen.scroll));
  if (selectedLine >= 0) {
    if (selectedLine < scroll) scroll = selectedLine;
    else if (selectedLine >= scroll + bodyRows) scroll = selectedLine - bodyRows + 1;
  }
  screen.scroll = scroll;

  const bg = theme.sidebarBg;
  const border = theme.accent;
  const row = (index: number, content: string) => moveTo(top + index, left) + bg + border + "│ " + bg + content + bg + border + " │" + theme.reset;
  const title = " Accounts ";
  const live = ` updated ${formatClock(screen.snapshot.generatedAt, now)} `;
  let payload = moveTo(top, left) + bg + border + "┌─" + theme.bold + title + theme.boldOff
    + "─".repeat(Math.max(0, width - 4 - title.length - live.length)) + theme.muted + live + border + "─┐" + theme.reset;
  for (let i = 0; i < bodyRows + 1; i++) {
    const line = i < bodyRows ? lines[scroll + i] : undefined;
    const selected = line?.convId !== undefined && line.convId === screen.selectedConvId;
    const lineBg = selected ? theme.sidebarSelBg : bg;
    payload += row(i + 1, lineBg + fitSegments(line?.segments ?? [], inner, lineBg) + bg);
  }
  const more = scroll + bodyRows < lines.length ? `  ↓ ${lines.length - scroll - bodyRows} more` : scroll > 0 ? "  ↑ more above" : "";
  payload += row(bodyRows + 2, fitSegments([[theme.muted, FOOTER + more]], inner, bg));
  payload += moveTo(top + height - 1, left) + bg + border + "└" + "─".repeat(width - 2) + "┘" + theme.reset;
  return { payload, rect: { top, bottom: top + height - 1, left, right: left + width - 1 } };
}
