import { expect, test } from "bun:test";
import {
  ACCOUNTS_UNAVAILABLE_HINT,
  closeAccountsScreen,
  displayTitle,
  handleAccountsScreenKey,
  renderAccountsScreen,
  requestAccountsScreen,
} from "./accountsscreen";
import { tryCommand } from "./commands";
import { handleEvent } from "./events";
import { handleFocusedKey } from "./focus";
import { createInitialState } from "./state";
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
      routing: { cacheTtlMs: H, fiveHourFloor: 10, weeklyFloor: 10, weeklyResetTieMs: 6 * H, fiveHourResetTieMs: 30 * 60_000 },
      nextNewWork: { account: "main", detail: "soonest weekly reset" },
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

/** An account with one running conversation and `warm` warm ones (`<id>-warm-0` the most recent). */
function busyAccount(id: string, warm: number): ClaudeAccountInfo {
  return claude(id, {
    activeTurns: 1,
    conversations: [
      { convId: `${id}-run`, lastUsedAt: NOW - 60_000, running: true, warm: true },
      ...Array.from({ length: warm }, (_, i) => ({ convId: `${id}-warm-${i}`, lastUsedAt: NOW - (i + 1) * 5 * 60_000, running: false, warm: true })),
    ],
  });
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

test("the screen shows the combined usage, routing, each account and the conversations on it", () => {
  const { state } = openScreen();
  expect(state.accountsScreen?.selected).toBe("conv-warm");
  const rows = screenText(state);
  const text = rows.join("\n");
  expect(text).toContain("╭─ Accounts ─");
  // Combined usage as a share of both accounts' capacity (74/200 → 37%, 31/200 → 16%), not "74/200%".
  expect(text).toMatch(/Claude {3}5-Hour \[█+░+\] 37% {3}Weekly \[█+░+\] 16% {3}combined/);
  expect(text).not.toContain("/200");
  expect(text).toContain("new work → main · soonest weekly reset · conversations stay while warm (1h)");
  expect(text).toMatch(/▌main  main@example\.com · Max +this conversation · new work {3}● ready │/);
  // Usage bars match the status bar's: 20 cells.
  expect(text).toMatch(/5-Hour \[[█░]{20}\] 40% {2}resets in 2h \(/);
  expect(text).toMatch(/Weekly \[[█░]{20}\] 20% {2}resets in 3d/);
  expect(text).toMatch(/◉ Fix login bug +running │/);
  expect(text).toMatch(/ {2}PMV5 review +50m left │/);
  expect(text).toMatch(/max2 +● signed out │/);
  expect(text).toContain("sign in from a terminal: CLAUDE_CONFIG_DIR=~/.claude-max2 command claude auth login --claudeai");
  // No config-dir lines.
  expect(text).not.toMatch(/^\s*│\s+~\/\.claude/m);
  expect(text).toContain("╰─ j/k select · Enter open · Esc close ─");
});

test("the card covers the chat: everything around it is blank", () => {
  const { state } = openScreen();
  const behind = Array.from({ length: 40 }, (_, row) => `\x1b[${row + 1};1H${"chat text ".repeat(15)}`).join("");
  const rows = screenText(state, 40, 150, behind);
  expect(rows.join("\n")).not.toContain("chat");
  const top = rows.findIndex(row => row.includes("╭─ Accounts"));
  expect(top).toBeGreaterThan(0);
  expect(rows.slice(0, top).every(row => row.trim() === "")).toBe(true);
});

test("running turns get a row each; more than two warm conversations fold into a row Enter expands", () => {
  const snap = snapshot({}, [busyAccount("main", 5), claude("max2")]);
  snap.claude.currentConversation = { convId: "main-warm-3", account: "main", lastUsedAt: NOW - 20 * 60_000, warm: true };
  const { state } = openScreen(snap);
  state.convId = "main-warm-3";
  state.sidebar.conversations = [
    conversation("main-run", "Busy turn"),
    ...Array.from({ length: 5 }, (_, i) => conversation(`main-warm-${i}`, `Warm ${i}`)),
  ];
  const screen = state.accountsScreen!;
  expect(screen.selected).toBe("main-warm-3");
  let text = screenText(state).join("\n");
  expect(text).toMatch(/◉ Busy turn +running │/);
  // This conversation stays listed; the other four fold.
  expect(text).toMatch(/ {2}Warm 3 +40m left │/);
  expect(text).toContain("▸ 4 more with a warm cache");
  expect(text).not.toContain("Warm 0");

  handleAccountsScreenKey({ type: "char", char: "j" }, screen, NOW);
  expect(screen.selected).toBe("warm:main");
  expect(screenText(state).join("\n")).toContain("Enter expand");
  expect(handleAccountsScreenKey({ type: "enter" }, screen, NOW)).toEqual({ type: "handled" });
  text = screenText(state).join("\n");
  expect(text).toContain("▾ 4 more with a warm cache");
  expect(text).toContain("Enter collapse");
  expect(text).toMatch(/ {2}Warm 0 +55m left │/);
  handleAccountsScreenKey({ type: "char", char: "j" }, screen, NOW);
  expect(screen.selected).toBe("main-warm-0");
  expect(handleAccountsScreenKey({ type: "enter" }, screen, NOW)).toEqual({ type: "open", convId: "main-warm-0" });
  handleAccountsScreenKey({ type: "char", char: "k" }, screen, NOW);
  handleAccountsScreenKey({ type: "enter" }, screen, NOW);
  expect(screenText(state).join("\n")).toContain("▸ 4 more with a warm cache");

  // Two warm conversations are just listed.
  const few = openScreen(snapshot({}, [busyAccount("main", 2), claude("max2")]));
  text = screenText(few.state).join("\n");
  expect(text).not.toContain("with a warm cache");
  expect(text).toMatch(/main-war +55m left[^]*main-war +50m left/);
});

test("titles drop markdown and end a cut-off phrase with an ellipsis", () => {
  expect(displayTitle("You are the **web-api** agent on")).toBe("You are the web-api agent on");
  expect(displayTitle("You have permission to edit code,")).toBe("You have permission to edit code…");
  expect(displayTitle("Fix an Exocortex TUI/daemon sync bug:")).toBe("Fix an Exocortex TUI/daemon sync bug…");
  expect(displayTitle("Use `snake_case` in  [the docs](https://x.dev)")).toBe("Use snake_case in the docs");
  expect(displayTitle("## Plan *this* week")).toBe("Plan this week");
  expect(displayTitle("my_var and other_var")).toBe("my_var and other_var");
});

test("limited and blocked accounts say so; OpenAI leaves out an unknown window", () => {
  const snap = snapshot({}, [
    claude("main", { state: "limited", limitedUntil: NOW + 3 * H }),
    claude("max2", { state: "blocked", stateDetail: "token refresh failed", blockedUntil: NOW + 10 * 60_000, usage: null }),
  ]);
  snap.openai.accounts = [
    { index: 1, email: "one@example.com", displayName: "One", plan: "plus", current: true },
    { index: 2, email: "two@example.com", displayName: null, plan: null, current: false },
  ];
  const { state } = openScreen(snap);
  state.usageByProvider.openai = { fiveHour: null, sevenDay: { utilization: 12, resetsAt: NOW + 48 * H } };
  const text = screenText(state).join("\n");
  expect(text).toMatch(/● limited until \d\d:\d\d │/);
  expect(text).toMatch(/max2 .*● blocked │/);
  expect(text).toContain("token refresh failed · checked again in 10m");
  expect(text).toContain("OpenAI   /account <email> switches");
  expect(text).toMatch(/▌one@example\.com  One · Plus +current │/);
  expect(text).toMatch(/Weekly \[[█░]{20}\] 12%/);
  expect(text).not.toContain("?%");
  expect(text).toContain(" two@example.com");
});

test("hidden sensitive info censors account emails", () => {
  const { state } = openScreen();
  state.hideSensitiveInfo = true;
  const text = screenText(state).join("\n");
  expect(text).not.toContain("main@example.com");
  expect(text).toContain("m***@example.com");
});

test("j/k select conversations, Enter opens one, Esc and q close", () => {
  const { state, daemon } = openScreen();
  const screen = state.accountsScreen!;
  expect(handleAccountsScreenKey({ type: "char", char: "k" }, screen, NOW)).toEqual({ type: "handled" });
  expect(screen.selected).toBe("conv-run");
  expect(handleAccountsScreenKey({ type: "char", char: "k" }, screen, NOW)).toEqual({ type: "handled" });
  expect(screen.selected).toBe("conv-run");
  handleAccountsScreenKey({ type: "down" }, screen, NOW);
  expect(screen.selected).toBe("conv-warm");
  expect(handleAccountsScreenKey({ type: "enter" }, screen, NOW)).toEqual({ type: "open", convId: "conv-warm" });
  expect(handleAccountsScreenKey({ type: "escape" }, screen, NOW)).toEqual({ type: "close" });
  expect(handleAccountsScreenKey({ type: "char", char: "q" }, screen, NOW)).toEqual({ type: "close" });

  closeAccountsScreen(state, daemon);
  expect(state.accountsScreen).toBeNull();
  expect(daemon.calls.at(-1)).toEqual({ watch: false });
});

test("pushed snapshots update the open screen live", () => {
  const { state } = openScreen();
  const next = snapshot();
  next.claude.accounts[0] = claude("main", { activeTurns: 0, conversations: [] });
  next.claude.accounts[1] = claude("max2", {
    email: "max2@example.com",
    state: "limited",
    limitedUntil: NOW + 3 * H,
    activeTurns: 1,
    conversations: [{ convId: "conv-warm", lastUsedAt: NOW, running: true, warm: true }],
  });
  next.claude.currentConversation = { convId: "conv-warm", account: "max2", lastUsedAt: NOW, warm: true };
  handleEvent({ type: "accounts", snapshot: next }, state, noDaemon);
  expect(state.accountsScreen?.snapshot).toBe(next);
  expect(state.accountsScreen?.selected).toBe("conv-warm");
  const text = screenText(state).join("\n");
  expect(text).toMatch(/ main  main@example\.com · Max +new work {3}● ready │/);
  expect(text).toMatch(/▌max2  max2@example\.com · Max +this conversation {3}● limited until/);
  expect(text).toMatch(/◉ PMV5 review +running │/);
  // Only the opening request opens the screen; unrelated answers do not reopen a closed one.
  state.accountsScreen = null;
  handleEvent({ type: "accounts", snapshot: next }, state, noDaemon);
  expect(state.accountsScreen).toBeNull();
});

test("a small terminal scrolls the content to keep the selection visible", () => {
  const { state } = openScreen();
  state.accountsScreen!.selected = "conv-warm";
  const rows = screenText(state, 10, 100);
  expect(rows.join("\n")).toContain("PMV5 review");
  expect(rows.join("\n")).toMatch(/more/);
});

test("a selected turn that ends and folds away leaves the selection on its account's warm row", () => {
  const { state } = openScreen(snapshot({}, [busyAccount("main", 3), claude("max2")]));
  const screen = state.accountsScreen!;
  screen.selected = "main-run";
  const next = snapshot({}, [busyAccount("main", 3), claude("max2")]);
  next.claude.accounts[0]!.conversations[0] = { convId: "main-run", lastUsedAt: NOW - 60_000, running: false, warm: true };
  next.claude.accounts[0]!.activeTurns = 0;
  handleEvent({ type: "accounts", snapshot: next }, state, noDaemon);
  expect(screen.selected).toBe("warm:main");
  expect(screenText(state).join("\n")).toContain("▸ 4 conversations with a warm cache");
});
