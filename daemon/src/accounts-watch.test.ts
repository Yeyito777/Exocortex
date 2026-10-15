import { expect, test } from "bun:test";
import { createAccountsWatch } from "./accounts-watch";
import { emitClaudeAccountsChanged } from "./providers/anthropic/account-events";
import { DEFAULT_ROUTING_POLICY } from "./providers/anthropic/routing";
import type { AccountsEvent, ClaudeAccountInfo, ClaudeAccountsInfo, Event, OpenAIAccountInfo } from "./protocol";
import type { ConnectedClient } from "./server";

function account(id: string, extra: Partial<ClaudeAccountInfo> = {}): ClaudeAccountInfo {
  return {
    id, email: `${id}@example.com`, plan: "max", configDir: `~/.claude-${id}`, state: "ready", stateDetail: null,
    limitedUntil: null, blockedUntil: null, usage: null, usageUpdatedAt: null, activeTurns: 0, conversations: [],
    loginCommand: null, ...extra,
  };
}

function fakeClient(): ConnectedClient {
  return { id: "c1", socket: { destroyed: false }, subscriptions: new Set(), buffer: "", capabilities: new Set() } as unknown as ConnectedClient;
}

function setup(claudeIds: string[], openai: OpenAIAccountInfo[] = []) {
  const sent: Array<{ client: ConnectedClient; event: Event }> = [];
  let accounts = claudeIds.map(id => account(id));
  let refreshes = 0;
  const convIds: Array<string | null> = [];
  const watch = createAccountsWatch({
    send: (client, event) => { sent.push({ client, event }); },
    claudeInfo: (convId): ClaudeAccountsInfo => {
      convIds.push(convId ?? null);
      return { proxied: false, accounts, combined: null, routing: { ...DEFAULT_ROUTING_POLICY }, nextNewWork: null };
    },
    openaiAccounts: () => openai,
    refreshClaude: async () => { refreshes += 1; return null; },
    isProxied: () => false,
  });
  return {
    watch, sent, convIds,
    refreshes: () => refreshes,
    setAccounts: (next: ClaudeAccountInfo[]) => { accounts = next; },
    snapshots: () => sent.map(entry => entry.event).filter((event): event is AccountsEvent => event.type === "accounts"),
  };
}

test("accounts answers with a structured snapshot, enabled only with several accounts", () => {
  const single = setup(["main"]);
  single.watch.handle(fakeClient(), { type: "accounts", reqId: "r1" });
  expect(single.snapshots()).toHaveLength(1);
  expect(single.snapshots()[0]).toMatchObject({ reqId: "r1", snapshot: { enabled: false, claude: { accounts: [{ id: "main" }] } } });

  const pair = setup(["main", "max2"]);
  pair.watch.handle(fakeClient(), { type: "accounts", reqId: "r2", convId: "conv-1" });
  expect(pair.snapshots()[0].snapshot.enabled).toBe(true);
  expect(pair.convIds).toEqual(["conv-1"]);

  const openai = setup(["main"], [
    { index: 1, email: "a@example.com", displayName: null, plan: "pro", current: true },
    { index: 2, email: "b@example.com", displayName: null, plan: "plus", current: false },
  ]);
  openai.watch.handle(fakeClient(), { type: "accounts", reqId: "r3", watch: true });
  expect(openai.snapshots()[0].snapshot).toMatchObject({ enabled: true, openai: { proxied: false, accounts: [{ index: 1 }, { index: 2 }] } });
  // An OpenAI pool alone is watched without checking the one Claude account.
  expect(openai.watch.watcherCount()).toBe(1);
  expect(openai.refreshes()).toBe(0);
});

test("watchers get a push per burst of changes until they stop watching", async () => {
  const t = setup(["main", "max2"]);
  const client = fakeClient();
  t.watch.handle(client, { type: "accounts", reqId: "open", watch: true, convId: "conv-1" });
  expect(t.watch.watcherCount()).toBe(1);
  expect(t.refreshes()).toBe(1);
  await t.watch.settled();

  t.setAccounts([account("main", { activeTurns: 1 }), account("max2")]);
  emitClaudeAccountsChanged();
  emitClaudeAccountsChanged();
  await Bun.sleep(400);
  const pushed = t.snapshots().filter(event => event.reqId === undefined);
  expect(pushed.length).toBe(1);
  expect(pushed[0].snapshot.claude.accounts[0].activeTurns).toBe(1);
  expect(t.convIds.at(-1)).toBe("conv-1");

  t.watch.handle(client, { type: "accounts", reqId: "close", watch: false });
  expect(t.watch.watcherCount()).toBe(0);
  const count = t.sent.length;
  emitClaudeAccountsChanged();
  await Bun.sleep(400);
  expect(t.sent.length).toBe(count);
});

test("a single-account daemon never registers a watcher; a closed socket is dropped", async () => {
  const single = setup(["main"]);
  single.watch.handle(fakeClient(), { type: "accounts", watch: true });
  expect(single.watch.watcherCount()).toBe(0);
  expect(single.refreshes()).toBe(0);

  const pair = setup(["main", "max2"]);
  const client = fakeClient();
  pair.watch.handle(client, { type: "accounts", watch: true });
  (client.socket as { destroyed: boolean }).destroyed = true;
  pair.watch.changed();
  await Bun.sleep(400);
  expect(pair.watch.watcherCount()).toBe(0);
});
