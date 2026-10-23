import { expect, test } from "bun:test";
import {
  ACCOUNTS_UNAVAILABLE_HINT,
  accountsScreenLines,
  closeAccountsScreen,
  handleAccountsScreenKey,
  prefetchAccounts,
  renderAccountsScreen,
  requestAccountsScreen,
} from "./accountsscreen";
import { tryCommand } from "./commands";
import { handleEvent } from "./events";
import { handleFocusedKey } from "./focus";
import { createInitialState } from "./state";
import { theme } from "./theme";
import { TerminalScreen } from "./testhelpers/terminalscreen";
import type { AccountsSnapshot, ClaudeAccountInfo } from "./protocol";
import type { ConversationSummary } from "./messages";

const NOW = Date.now();
const H = 3_600_000;

function claude(id: string, extra: Partial<ClaudeAccountInfo> = {}): ClaudeAccountInfo {
  return {
    id,
    email: `${id}@example.com`,
    plan: "max",
    configDir: id === "main" ? "~/.claude" : `~/.claude-${id}`,
    state: "ready",
    stateDetail: null,
    limitedUntil: null,
    blockedUntil: null,
    usage: { fiveHour: { utilization: 40, resetsAt: NOW + 2 * H }, sevenDay: { utilization: 20, resetsAt: NOW + 72 * H } },
    usageUpdatedAt: NOW,
    activeTurns: 0,
    conversations: [],
    loginCommand: null,
    ...extra,
  };
}

function snapshot(overrides: Partial<AccountsSnapshot> = {}, accounts?: ClaudeAccountInfo[]): AccountsSnapshot {
  return {
    generatedAt: NOW,
    enabled: true,
    claude: {
      proxied: false,
      accounts: accounts ?? [
        claude("main", {
          activeTurns: 1,
          conversations: [
            { convId: "conv-run", lastUsedAt: NOW - 2 * H, running: true, warm: false },
            { convId: "conv-warm", lastUsedAt: NOW - 10 * 60_000, running: false, warm: true },
          ],
        }),
        claude("max2", {
          email: null,
          plan: null,
          state: "signed_out",
          usage: null,
          loginCommand: "CLAUDE_CONFIG_DIR=~/.claude-max2 command claude auth login --claudeai",
        }),
      ],
      combined: { fiveHour: { utilization: 74, resetsAt: NOW + 2 * H }, sevenDay: { utilization: 31, resetsAt: NOW + 72 * H }, capacity: 200 },
      routing: { cacheTtlMs: H, fiveHourFloor: 10, weeklyFloor: 10, fiveHourComfort: 40, scoreTie: 0.1, coldMoveRatio: 1.25 },
      nextNewWork: { account: "main", detail: "it is furthest behind its weekly pace (90% left over 5 days vs 60% over 6 days)" },
      currentConversation: { convId: "conv-warm", account: "main", lastUsedAt: NOW - 10 * 60_000, warm: true },
    },
    openai: { proxied: false, accounts: [] },
    ...overrides,
  };
}

function conversation(id: string, title: string): ConversationSummary {
  return {
    id, provider: "anthropic", model: "claude-opus-5-5", effort: "high", fastMode: false, createdAt: 0, updatedAt: 0,
    messageCount: 1, title, marked: false, pinned: false, streaming: false, unread: false, sortOrder: 0,
  } as ConversationSummary;
}

function fakeDaemon() {
  const calls: Array<{ watch?: boolean; convId?: string | null }> = [];
  return {
    calls,
    accounts(options: { watch?: boolean; convId?: string | null }) {
      calls.push(options);
      return `accounts_${calls.length}`;
    },
  };
}

const noDaemon = { subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} };

function openScreen(snap = snapshot()) {
  const state = createInitialState();
  state.convId = "conv-warm";
  state.sidebar.conversations = [conversation("conv-run", "Fix login bug"), conversation("conv-warm", "PMV5 review")];
  state.usageByProvider.openai = { fiveHour: null, sevenDay: { utilization: 12, resetsAt: NOW + 48 * H } };
  const daemon = fakeDaemon();
  requestAccountsScreen(state, daemon);
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snap }, state, noDaemon);
  return { state, daemon };
}

function screenText(state: ReturnType<typeof createInitialState>, rows = 40, cols = 150, behind = ""): string[] {
  const screen = new TerminalScreen(rows, cols);
  if (behind) screen.feed(behind);
  screen.feed(renderAccountsScreen(state, state.accountsScreen!, rows, cols, NOW).payload);
  return screen.plainRows();
}

test("/accounts asks for the screen; g a does too from prompt, history and sidebar normal mode", () => {
  const state = createInitialState();
  state.inputBuffer = "/accounts";
  expect(tryCommand("/accounts", state)).toMatchObject({ type: "open_accounts" });

  const prompt = createInitialState();
  expect(handleFocusedKey({ type: "escape" }, prompt)).toEqual({ type: "handled" });
  expect(handleFocusedKey({ type: "char", char: "g" }, prompt)).toEqual({ type: "handled" });
  expect(handleFocusedKey({ type: "char", char: "a" }, prompt)).toEqual({ type: "open_accounts" });
  // gg still goes to the top.
  expect(handleFocusedKey({ type: "char", char: "g" }, prompt)).toEqual({ type: "handled" });
  expect(handleFocusedKey({ type: "char", char: "g" }, prompt)).toEqual({ type: "handled" });
  expect(prompt.vim.pendingKeys).toBe("");

  const sidebar = createInitialState();
  sidebar.sidebar.open = true;
  sidebar.panelFocus = "sidebar";
  sidebar.vim.mode = "normal";
  sidebar.sidebar.conversations = [conversation("conv-a", "A")];
  sidebar.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
  expect(handleFocusedKey({ type: "char", char: "g" }, sidebar)).toEqual({ type: "handled" });
  expect(handleFocusedKey({ type: "char", char: "a" }, sidebar)).toEqual({ type: "open_accounts" });

  // Insert mode types the letters.
  const typing = createInitialState();
  handleFocusedKey({ type: "char", char: "g" }, typing);
  expect(handleFocusedKey({ type: "char", char: "a" }, typing)).toEqual({ type: "handled" });
  expect(typing.inputBuffer).toBe("ga");
});

test("the screen opens at once with a loading line, and fills in when the answer arrives", () => {
  const state = createInitialState();
  state.usageByProvider.anthropic = { fiveHour: { utilization: 40, resetsAt: NOW + H }, sevenDay: null, capacity: 200 } as never;
  const daemon = fakeDaemon();
  requestAccountsScreen(state, daemon);
  expect(state.accountsScreen).not.toBeNull();
  expect(screenText(state).join("\n")).toContain("Loading accounts…");
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snapshot() }, state, noDaemon);
  expect(state.accountsOpenRequest).toBeNull();
  const text = screenText(state).join("\n");
  expect(text).not.toContain("Loading accounts…");
  expect(text).toContain("max2");
});

test("reopening shows the last snapshot right away while a fresh one is fetched", () => {
  const { state } = openScreen();
  closeAccountsScreen(state, null);
  const daemon = fakeDaemon();
  requestAccountsScreen(state, daemon);
  expect(daemon.calls).toEqual([{ watch: true, convId: "conv-warm" }]);
  expect(state.accountsOpenRequest).not.toBeNull();
  const text = screenText(state).join("\n");
  expect(text).not.toContain("Loading accounts…");
  expect(text).toContain("max2");
});

test("a snapshot fetched at connect makes the first open instant, with no loading line", () => {
  const state = createInitialState();
  state.convId = "conv-warm";
  const daemon = fakeDaemon();
  prefetchAccounts(state, daemon, { force: true });
  expect(daemon.calls).toEqual([{ convId: "conv-warm" }]);
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snapshot() }, state, noDaemon);
  expect(state.accountsPrefetchReqId).toBeNull();
  expect(state.accountsScreen).toBeNull();

  requestAccountsScreen(state, daemon);
  expect(daemon.calls[1]).toEqual({ watch: true, convId: "conv-warm" });
  const text = screenText(state).join("\n");
  expect(text).not.toContain("Loading accounts…");
  expect(text).toContain("max2");
  expect(highlighted(state)).toEqual(["main"]);
  // The watch's answer refreshes it in place.
  const later = snapshot({}, [claude("main"), claude("max2", { state: "limited", limitedUntil: NOW + H })]);
  handleEvent({ type: "accounts", reqId: "accounts_2", snapshot: later }, state, noDaemon);
  expect(state.accountsScreen?.snapshot?.claude.accounts[1]?.state).toBe("limited");
});

function prefetchingDaemon() {
  const daemon = fakeDaemon();
  return Object.assign(daemon, noDaemon, { accounts: daemon.accounts });
}

test("sign-in, usage, account and /proxy events refresh the cached snapshot, one ask at a time", () => {
  const state = createInitialState();
  state.convId = "conv-warm";
  const daemon = prefetchingDaemon();
  handleEvent({ type: "usage_update", provider: "anthropic", usage: null }, state, daemon);
  expect(daemon.calls).toEqual([{ convId: "conv-warm" }]);
  // Already in the unanswered ask's snapshot.
  handleEvent({ type: "auth_status", message: "Switched" }, state, daemon);
  handleEvent({ type: "provider_proxies", proxies: [] }, state, daemon);
  expect(daemon.calls).toHaveLength(1);
  // Unrelated events never ask.
  handleEvent({ type: "pong" } as never, state, daemon);
  expect(daemon.calls).toHaveLength(1);

  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snapshot() }, state, daemon);
  handleEvent({ type: "auth_status", message: "Logged out from openai" }, state, daemon);
  expect(daemon.calls).toHaveLength(2);
  const loggedOut = snapshot({}, [claude("main"), claude("max2", { state: "signed_out" })]);
  handleEvent({ type: "accounts", reqId: "accounts_2", snapshot: loggedOut }, state, daemon);
  expect(state.accountsSnapshotCache).toBe(loggedOut);

  // While the screen is open its watch pushes changes; no extra asks.
  requestAccountsScreen(state, daemon);
  handleEvent({ type: "usage_update", provider: "anthropic", usage: null }, state, daemon);
  expect(daemon.calls.slice(2)).toEqual([{ watch: true, convId: "conv-warm" }]);
});

test("a reconnect asks again even if the last ask was lost", () => {
  const state = createInitialState();
  const daemon = fakeDaemon();
  prefetchAccounts(state, daemon, { force: true });
  prefetchAccounts(state, daemon);
  expect(daemon.calls).toHaveLength(1);
  // The connection dropped before the answer; the next one starts over.
  prefetchAccounts(state, daemon, { force: true });
  expect(daemon.calls).toHaveLength(2);
  expect(state.accountsPrefetchReqId).toBe("accounts_2");
  handleEvent({ type: "accounts", reqId: "accounts_2", snapshot: snapshot() }, state, noDaemon);
  expect(state.accountsSnapshotCache?.claude.accounts).toHaveLength(2);
});

test("a daemon without the accounts command rejects the ask silently, and is not asked again", () => {
  const state = createInitialState();
  const daemon = prefetchingDaemon();
  prefetchAccounts(state, daemon, { force: true });
  handleEvent({ type: "error", reqId: "accounts_1", message: "Unknown command: accounts" }, state, daemon);
  expect(state.messages).toHaveLength(0);
  handleEvent({ type: "usage_update", provider: "anthropic", usage: null }, state, daemon);
  expect(daemon.calls).toHaveLength(1);
});

/** Claude rows drawn as this conversation's account (bold accent name). */
function highlighted(state: ReturnType<typeof createInitialState>): string[] {
  return accountsScreenLines(state, state.accountsScreen!, NOW).flatMap(line =>
    line.kind === "row" && line.row.name[0] === theme.bold + theme.accent ? [line.row.name[1]] : []);
}

function withoutCurrent(snap: AccountsSnapshot): AccountsSnapshot {
  const { currentConversation: _current, ...claude } = snap.claude;
  return { ...snap, claude };
}

test("reopening highlights this conversation's account at once, though closing's answer named no conversation", () => {
  const { state } = openScreen();
  expect(highlighted(state)).toEqual(["main"]);
  const closing = fakeDaemon();
  closeAccountsScreen(state, closing);
  expect(closing.calls).toEqual([{ watch: false }]);
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: withoutCurrent(snapshot()) }, state, noDaemon);

  requestAccountsScreen(state, fakeDaemon());
  expect(highlighted(state)).toEqual(["main"]);
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snapshot() }, state, noDaemon);
  expect(highlighted(state)).toEqual(["main"]);
});

test("a late answer to closing keeps the reopened screen's highlight", () => {
  const { state } = openScreen();
  closeAccountsScreen(state, fakeDaemon());
  requestAccountsScreen(state, fakeDaemon());
  // The close's answer (another reqId, no conversation) lands after the reopen.
  handleEvent({ type: "accounts", reqId: "accounts_close", snapshot: withoutCurrent(snapshot()) }, state, noDaemon);
  expect(state.accountsOpenRequest).not.toBeNull();
  expect(highlighted(state)).toEqual(["main"]);
});

test("in another conversation the highlight follows what earlier snapshots said about it, or waits", () => {
  const { state } = openScreen();
  closeAccountsScreen(state, null);

  // Running on main, by main's list in the cached snapshot.
  state.convId = "conv-run";
  requestAccountsScreen(state, fakeDaemon());
  expect(highlighted(state)).toEqual(["main"]);
  closeAccountsScreen(state, null);

  // An earlier snapshot asked for conv-cold said max2.
  const cold = snapshot();
  cold.claude.currentConversation = { convId: "conv-cold", account: "max2", lastUsedAt: NOW - 50 * H, warm: false };
  handleEvent({ type: "accounts", snapshot: cold } as never, state, noDaemon);
  handleEvent({ type: "accounts", snapshot: withoutCurrent(snapshot()) } as never, state, noDaemon);
  state.convId = "conv-cold";
  requestAccountsScreen(state, fakeDaemon());
  expect(highlighted(state)).toEqual(["max2"]);
  closeAccountsScreen(state, null);

  // Nothing known: no highlight rather than another conversation's.
  state.convId = "conv-new";
  requestAccountsScreen(state, fakeDaemon());
  expect(highlighted(state)).toEqual([]);
  handleEvent({
    type: "accounts", reqId: "accounts_1",
    snapshot: { ...snapshot(), claude: { ...snapshot().claude, currentConversation: { convId: "conv-new", account: "max2", lastUsedAt: NOW, warm: true } } },
  }, state, noDaemon);
  expect(highlighted(state)).toEqual(["max2"]);
});

test("without known multiple accounts it waits for the answer, then opens", () => {
  const state = createInitialState();
  requestAccountsScreen(state, fakeDaemon());
  expect(state.accountsScreen).toBeNull();
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snapshot() }, state, noDaemon);
  expect(screenText(state).join("\n")).toContain("max2");
});

test("with one account the answer explains how to add one and no screen opens", () => {
  const state = createInitialState();
  const daemon = fakeDaemon();
  requestAccountsScreen(state, daemon);
  expect(daemon.calls).toEqual([{ watch: true, convId: null }]);
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snapshot({ enabled: false }, [claude("main")]) }, state, noDaemon);
  expect(state.accountsScreen).toBeNull();
  expect(state.accountsOpenRequest).toBeNull();
  expect(JSON.stringify(state.messages.at(-1))).toContain("/account claude add <name>");
  expect(ACCOUNTS_UNAVAILABLE_HINT).toContain("/login openai add");
});

test("the screen is one table: a row per account with its bars and times to reset", () => {
  const snap = snapshot({}, [claude("main"), claude("max2", { usage: { fiveHour: { utilization: 7, resetsAt: NOW + 4 * H }, sevenDay: { utilization: 3, resetsAt: NOW + 30 * H } } })]);
  snap.claude.nextNewWork = { account: "max2", detail: "it is furthest behind its weekly pace (74% left over 6.2 days vs 100% over 6.4 days)" };
  snap.openai.accounts = [
    { index: 1, email: "one@example.com", displayName: "One", plan: "plus", current: true },
    { index: 2, email: "two@example.com", displayName: null, plan: null, current: false },
  ];
  const { state } = openScreen(snap);
  const rows = screenText(state);
  const text = rows.join("\n");
  expect(text).toContain("╭─ Accounts ─");
  expect(text).not.toContain("Esc close");
  expect(text).toMatch(/╰─+╯/);
  expect(text).toMatch(/│ {2}Claude +5-Hour +Weekly +│/);
  expect(text).toMatch(/│ {2}● main +━{14} {2}40% {2}2h {3,}━{14} {2}20% {2}3d +│/);
  expect(text).toMatch(/│ {2}● max2 {2}new work +━{14} {3}7% {2}4h +━{14} {3}3% {2}1d6h {2}│/);
  // OpenAI: the current login's known window only; others are just listed.
  expect(text).toMatch(/│ {2}● one@example\.com {20,}━{14} {2}12% {2}2d +│/);
  expect(text).toMatch(/│ {2}● two@example\.com +│/);
  // One set of columns for every row.
  const barStarts = rows.filter(row => row.includes("━")).map(row => row.indexOf("━"));
  const weeklyLabel = rows.find(row => row.includes("Weekly"))!.indexOf("Weekly");
  expect(rows.find(row => row.includes("5-Hour"))!.indexOf("5-Hour")).toBe(barStarts[0]);
  expect(new Set(barStarts.slice(0, 2)).size).toBe(1);
  expect(rows.find(row => row.includes("one@example"))!.indexOf("━")).toBe(weeklyLabel);
  // Nothing else: no emails or plans for Claude, no conversations, no combined bars, no routing prose.
  for (const gone of ["main@example.com", "Max", "PMV5 review", "Fix login bug", "combined", "total", "?%", "resets in", "j/k", "Enter", "updated"]) {
    expect(text).not.toContain(gone);
  }
  // The card fits its table and is centred.
  const top = rows.findIndex(row => row.includes("╭─ Accounts"));
  const left = rows[top]!.indexOf("╭");
  const right = rows[top]!.indexOf("╮");
  expect(right - left + 1).toBeLessThan(100);
  expect(Math.abs(left - (150 - right - 1))).toBeLessThanOrEqual(1);
  const bottom = rows.findIndex(row => row.includes("╰─"));
  expect(Math.abs(top - (40 - bottom - 1))).toBeLessThanOrEqual(1);
});

test("the card is an overlay: the chat stays visible around it", () => {
  const { state } = openScreen();
  const behind = Array.from({ length: 40 }, (_, row) => `\x1b[${row + 1};1H${"chat text ".repeat(15)}`).join("");
  const rows = screenText(state, 40, 150, behind);
  const top = rows.findIndex(row => row.includes("╭─ Accounts"));
  expect(top).toBeGreaterThan(0);
  expect(rows.slice(0, top).every(row => row.startsWith("chat text"))).toBe(true);
  const left = rows[top]!.indexOf("╭");
  expect(rows[top]!.slice(0, left)).toContain("chat");
  const bottom = rows.findIndex(row => row.includes("╰─"));
  expect(rows.slice(bottom + 1).every(row => row.startsWith("chat text"))).toBe(true);
});

test("the overlay rect is the card, so images outside it stay placed", () => {
  const { state } = openScreen();
  const { rect } = renderAccountsScreen(state, state.accountsScreen!, 40, 150, NOW);
  const rows = screenText(state, 40, 150);
  const top = rows.findIndex(row => row.includes("╭─ Accounts"));
  const bottom = rows.findIndex(row => row.includes("╰─"));
  expect(rect.top).toBe(top + 1);
  expect(rect.bottom).toBe(bottom + 1);
  expect(rect.left).toBe(rows[top]!.indexOf("╭") + 1);
  expect(rect.right).toBe(rows[top]!.indexOf("╮") + 1);
});

test("a short note says why new work skips an account near its limit, and only then", () => {
  const near = claude("main", { usage: { fiveHour: { utilization: 40, resetsAt: NOW + 2 * H }, sevenDay: { utilization: 95, resetsAt: NOW + 72 * H } } });
  const snap = snapshot({}, [near, claude("max2")]);
  snap.claude.nextNewWork = { account: "max2", detail: "\"main\" is below the weekly floor" };
  expect(screenText(openScreen(snap).state).join("\n")).toContain("main is near its weekly limit → new work goes to max2");

  const fiveHour = snapshot({}, [claude("main", { usage: { fiveHour: { utilization: 93, resetsAt: NOW + H }, sevenDay: null } }), claude("max2")]);
  fiveHour.claude.nextNewWork = { account: "max2", detail: "x" };
  expect(screenText(openScreen(fiveHour).state).join("\n")).toContain("main is near its 5-hour limit → new work goes to max2");

  const both = snapshot({}, [near, claude("max2", { usage: near.usage })]);
  both.claude.nextNewWork = { account: "max2", detail: "x" };
  expect(screenText(openScreen(both).state).join("\n")).toContain("every account is near a limit → new work goes to max2");

  const none = snapshot({}, [claude("main"), claude("max2")]);
  none.claude.nextNewWork = null;
  expect(screenText(openScreen(none).state).join("\n")).toContain("no account can take new work");

  // Plenty of headroom everywhere: the "new work" tag says it all.
  const quiet = screenText(openScreen(snapshot({}, [claude("main"), claude("max2")])).state).join("\n");
  expect(quiet).not.toContain("→");
  expect(quiet).toMatch(/● main {2}new work /);
});

test("limited, blocked, signed-out and other states replace the bars with a short word", () => {
  const snap = snapshot({}, [
    claude("main", { state: "limited", limitedUntil: NOW + 3 * H }),
    claude("max2", { state: "blocked", stateDetail: "token refresh failed", blockedUntil: NOW + 10 * 60_000, usage: null }),
    claude("max3", { state: "signed_out", usage: null, loginCommand: "CLAUDE_CONFIG_DIR=~/.claude-max3 command claude auth login --claudeai" }),
    claude("max4", { state: "not_subscription", stateDetail: "apiKey" }),
    claude("max5", { state: "unchecked", usage: null }),
  ]);
  snap.claude.nextNewWork = null;
  const text = screenText(openScreen(snap).state, 40, 160).join("\n");
  expect(text).toMatch(/● main {2}limited 3h {3}━{14} {2}40%/);
  expect(text).toMatch(/● max2 {15}blocked: token refresh failed · retry in 10m +│/);
  expect(text).toMatch(/● max3 {15}signed out +│/);
  expect(text).toMatch(/● max4 {15}not a subscription \(apiKey\) +│/);
  expect(text).toMatch(/● max5 {15}checking… +│/);
  expect(text).toContain("sign in max3: CLAUDE_CONFIG_DIR=~/.claude-max3 command claude auth login --claudeai");
});

test("an account without usage yet shows no bars, not ?%", () => {
  const snap = snapshot({}, [claude("main"), claude("max2", { usage: null })]);
  const { state } = openScreen(snap);
  state.usageByProvider.openai = null;
  const text = screenText(state).join("\n");
  expect(text).toMatch(/│ {2}● max2 +│/);
  expect(text).not.toContain("?");
});

test("/proxy shows the remote's login instead of the Claude accounts", () => {
  const snap = snapshot();
  snap.claude.proxied = true;
  snap.openai.accounts = [{ index: 1, email: "one@example.com", displayName: null, plan: null, current: true }];
  const text = screenText(openScreen(snap).state).join("\n");
  expect(text).toContain("the remote daemon's login (/proxy)");
  expect(text).not.toContain("● main");
  // The column labels move to the OpenAI table.
  expect(text).toMatch(/OpenAI +5-Hour +Weekly/);
});

test("hidden sensitive info censors OpenAI emails", () => {
  const snap = snapshot();
  snap.openai.accounts = [{ index: 1, email: "one@example.com", displayName: null, plan: null, current: true }];
  const { state } = openScreen(snap);
  state.hideSensitiveInfo = true;
  const text = screenText(state).join("\n");
  expect(text).not.toContain("one@example.com");
  expect(text).toContain("o**@example.com");
});

test("Esc and q close; other keys are swallowed", () => {
  const { state, daemon } = openScreen();
  const screen = state.accountsScreen!;
  expect(handleAccountsScreenKey({ type: "enter" }, screen)).toEqual({ type: "handled" });
  expect(handleAccountsScreenKey({ type: "char", char: "x" }, screen)).toEqual({ type: "handled" });
  expect(handleAccountsScreenKey({ type: "escape" }, screen)).toEqual({ type: "close" });
  expect(handleAccountsScreenKey({ type: "char", char: "q" }, screen)).toEqual({ type: "close" });

  closeAccountsScreen(state, daemon);
  expect(state.accountsScreen).toBeNull();
  expect(daemon.calls.at(-1)).toEqual({ watch: false });
});

test("pushed snapshots update the open screen live", () => {
  const { state } = openScreen();
  const next = snapshot();
  next.claude.accounts[1] = claude("max2", { state: "limited", limitedUntil: NOW + 3 * H });
  handleEvent({ type: "accounts", snapshot: next }, state, noDaemon);
  expect(state.accountsScreen?.snapshot).toBe(next);
  expect(screenText(state).join("\n")).toMatch(/● max2 {2}limited 3h/);
  // Only the opening request opens the screen; unrelated answers do not reopen a closed one.
  state.accountsScreen = null;
  handleEvent({ type: "accounts", snapshot: next }, state, noDaemon);
  expect(state.accountsScreen).toBeNull();
});

test("a narrow terminal shortens the bars; a short one scrolls with j/k", () => {
  const { state } = openScreen(snapshot({}, [claude("main"), claude("max2")]));
  const narrow = screenText(state, 40, 64).join("\n");
  expect(narrow).toMatch(/● main {2}new work +━{6,13} {2}40%/);
  expect(narrow).not.toMatch(/━{14}/);

  const screen = state.accountsScreen!;
  let rows = screenText(state, 8, 100).join("\n");
  expect(rows).toContain("Claude");
  expect(rows).toContain("↓ 1 more");
  handleAccountsScreenKey({ type: "char", char: "j" }, screen);
  handleAccountsScreenKey({ type: "char", char: "j" }, screen);
  rows = screenText(state, 8, 100).join("\n");
  expect(screen.scroll).toBe(1);
  expect(rows).not.toContain("Claude");
  expect(rows).toContain("● max2");
  expect(rows).toContain("↑ more above");
  handleAccountsScreenKey({ type: "char", char: "k" }, screen);
  expect(screenText(state, 8, 100).join("\n")).toContain("Claude");
});

test("under /proxy the remote's accounts fill the table; the note says whose, or that the link is down", () => {
  const snap = snapshot({}, [claude("main"), claude("max2")]);
  snap.claude.nextNewWork = { account: "max2", detail: "it is furthest behind its weekly pace (90% left over 5 days vs 60% over 6 days)" };
  snap.claude.currentConversation = { convId: "conv-warm", account: "max2", lastUsedAt: NOW, warm: true };
  snap.claude.remote = { alias: "whale", host: "yeyito@whale", state: "connected" };
  const { state } = openScreen(snap);
  let text = screenText(state).join("\n");
  expect(text).toMatch(/max2  new work/);
  expect(text).toContain("accounts on whale (/proxy)");

  // The pool's routing note, marked with where the accounts are.
  snap.claude.accounts[0] = claude("main", { usage: { fiveHour: { utilization: 40, resetsAt: NOW + 2 * H }, sevenDay: { utilization: 97, resetsAt: NOW + 30 * H } } });
  state.accountsScreen!.snapshot = snap;
  text = screenText(state).join("\n");
  expect(text).toContain("on whale: main is near its weekly limit → new work goes to max2");
  expect(text).not.toContain("the remote daemon's login");

  state.accountsScreen!.snapshot = { ...snap, claude: { ...snap.claude, remote: { alias: "whale", host: null, state: "disconnected", message: "The SSH connection to whale was lost." } } };
  text = screenText(state).join("\n");
  expect(text).toContain("/proxy whale down: The SSH connection to whale was lost.");

  // A long reason is clipped rather than widening the card.
  const long = "Could not reach the Exocortex daemon on whale over SSH (exit 1): exocortexd proxy: cannot connect to its socket";
  state.accountsScreen!.snapshot = { ...snap, claude: { ...snap.claude, remote: { alias: "whale", host: null, state: "disconnected", message: long } } };
  text = screenText(state).join("\n");
  expect(text).toContain(`/proxy whale down: ${long.slice(0, 47)}…`);
  expect(text).not.toContain("cannot connect");
  expect(text).not.toContain("accounts on whale");
});

test("under /proxy without the remote's accounts the answer says why", () => {
  const state = createInitialState();
  requestAccountsScreen(state, fakeDaemon());
  const snap = snapshot({ enabled: false }, []);
  snap.claude.proxied = true;
  handleEvent({ type: "accounts", reqId: "accounts_1", snapshot: snap }, state, noDaemon);
  expect(state.accountsScreen).toBeNull();
  expect(JSON.stringify(state.messages.at(-1))).toContain("the remote's Claude accounts are not available");
});
