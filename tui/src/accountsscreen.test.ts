import { expect, test } from "bun:test";
import {
  ACCOUNTS_UNAVAILABLE_HINT,
  closeAccountsScreen,
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

function screenText(state: ReturnType<typeof createInitialState>, rows = 40, cols = 150): string[] {
  const screen = new TerminalScreen(rows, cols);
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

test("the screen shows each account, the combined bars, routing and the conversations on it", () => {
  const { state } = openScreen();
  expect(state.accountsScreen?.selectedConvId).toBe("conv-warm");
  const text = screenText(state).join("\n");
  expect(text).toContain("Accounts");
  expect(text).toContain("74/200%");
  expect(text).toContain("31/200%");
  // One header line: the combined bars and the routing rule.
  expect(text).toMatch(/Claude 5h \[█+░+\] 74\/200% · wk \[█+░+\] 31\/200% · routing: stays while cache warm \(1h\) · new work → soonest weekly reset \(main\)/);
  expect(text).toContain("main  main@example.com · max  ·  ready  · this conversation");
  expect(text).toMatch(/5-hour \[█+░+\] 40%\s+resets in 2h \(/);
  expect(text).toMatch(/weekly \[█+░+\] 20%\s+resets in 3d/);
  expect(text).toContain("1 turn running · 1 conversation with a warm cache");
  expect(text).toContain("Fix login bug  ·  running");
  expect(text).toContain("▸ PMV5 review  ·  warm, 50m left");
  expect(text).toContain("max2  ·  signed out");
  expect(text).toContain("sign in from a terminal: CLAUDE_CONFIG_DIR=~/.claude-max2 command claude auth login --claudeai");
  expect(text).toContain("j/k select · Enter open conversation · Esc close");
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
  expect(screen.selectedConvId).toBe("conv-run");
  expect(handleAccountsScreenKey({ type: "char", char: "k" }, screen, NOW)).toEqual({ type: "handled" });
  expect(screen.selectedConvId).toBe("conv-run");
  handleAccountsScreenKey({ type: "down" }, screen, NOW);
  expect(screen.selectedConvId).toBe("conv-warm");
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
  expect(state.accountsScreen?.selectedConvId).toBe("conv-warm");
  const text = screenText(state).join("\n");
  expect(text).toContain("main  main@example.com · max  ·  ready\n".slice(0, -1));
  expect(text).not.toContain("main  main@example.com · max  ·  ready  · this conversation");
  expect(text).toContain("max2  max2@example.com · max  ·  limited until");
  expect(text).toContain("· this conversation");
  expect(text).toContain("▸ PMV5 review  ·  running");
  // Only the opening request opens the screen; unrelated answers do not reopen a closed one.
  state.accountsScreen = null;
  handleEvent({ type: "accounts", snapshot: next }, state, noDaemon);
  expect(state.accountsScreen).toBeNull();
});

test("a small terminal scrolls the content to keep the selection visible", () => {
  const { state } = openScreen();
  state.accountsScreen!.selectedConvId = "conv-warm";
  const rows = screenText(state, 10, 100);
  expect(rows.join("\n")).toContain("PMV5 review");
  expect(rows.join("\n")).toMatch(/more/);
});
