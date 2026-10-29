import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyAssistantTurnEnded } from "./conversation-lifecycle";
import { beginDaemonShutdown, resetDaemonShutdownModeForTest } from "./daemon-lifecycle";
import type { Command, Event } from "./protocol";

// Sessions, reconnect grace, route preferences and the graceful-restart
// handover of the app API (docs/app-api.md). Turns are simulated: the tests
// report their ends as the orchestrator does.
// A send to a conversation in `running` stays running until the test releases it.
const running = new Map<string, () => void>();
mock.module("./orchestrator", () => ({
  orchestrateSendMessage: mock(async (_server: unknown, _client: unknown, _reqId: unknown, convId: string) => {
    if (running.has(convId)) await new Promise<void>(resolve => running.set(convId, resolve));
    return { ok: true, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now() };
  }),
  orchestrateReplayConversation: mock(async () => ({ ok: true, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now() })),
  orchestrateCompactConversation: mock(async () => ({ ok: true, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now() })),
  orchestrateGoalCycle: mock(async () => {}),
}));

const { createHandler } = await import("./handler");
const convStore = await import("./conversations");
const registry = await import("./app-registry");
const appApi = await import("./app-api");
const workspaces = await import("./app-workspaces");
const accountPool = await import("./providers/anthropic/account-pool");

interface FakeClient {
  id: string;
  socket: { destroyed: boolean };
  subscriptions: Set<string>;
  capabilities: Set<string>;
  app?: { name: string };
  events: Event[];
}

let scratch: string;
let clientCounter = 0;
const created: string[] = [];
let closeListener: ((client: FakeClient) => void) | null = null;

function fakeClient(): FakeClient {
  return { id: `sc${++clientCounter}`, socket: { destroyed: false }, subscriptions: new Set(), capabilities: new Set(), events: [] };
}

const server = {
  sendTo: (client: FakeClient, event: Event) => { client.events.push(event); return 0; },
  broadcast: () => {},
  broadcastExcept: () => {},
  sendToSubscribers: () => {},
  sendToSubscribersExcept: () => {},
  subscribe: (client: FakeClient, convId: string) => { client.subscriptions.add(convId); },
  unsubscribe: (client: FakeClient, convId: string) => { client.subscriptions.delete(convId); },
  hasSubscribers: () => false,
  setHiddenConversationFilter: () => {},
  onClientClosed: (listener: (client: FakeClient) => void) => { closeListener = listener; return () => { closeListener = null; }; },
  broadcastSidebarStatePatched: () => {},
  broadcastSidebarItemsReordered: () => {},
};
let handle: ReturnType<typeof createHandler>;

async function run(client: FakeClient, command: Record<string, unknown>): Promise<Event[]> {
  const before = client.events.length;
  await handle(client as never, command as unknown as Command);
  return client.events.slice(before);
}

type Welcome = Extract<Event, { type: "app_welcome" }>;

async function asApp(app: Record<string, unknown> = {}, client = fakeClient()): Promise<{ client: FakeClient; welcome: Welcome }> {
  const [welcome] = await run(client, { type: "client_capabilities", reqId: "w", capabilities: [], app: { name: "demo", ...app } });
  expect(welcome).toMatchObject({ type: "app_welcome", reqId: "w" });
  return { client, welcome: welcome as Welcome };
}

async function createApp(client: FakeClient, fields: Record<string, unknown>): Promise<string> {
  const [answer] = await run(client, { type: "new_conversation", reqId: "c", provider: "openai", model: "gpt-5.4", ...fields });
  expect(answer?.type).toBe("conversation_created");
  const convId = (answer as { convId: string }).convId;
  created.push(convId);
  return convId;
}

function disconnect(client: FakeClient): void {
  client.socket.destroyed = true;
  closeListener!(client);
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}

function endTurn(convId: string, startedAt: number, extra: Record<string, unknown> = {}): void {
  notifyAssistantTurnEnded({ convId, promptStartedAt: startedAt, ok: true, blocks: [{ type: "text", text: "Done." }], tokens: 3, durationMs: 4, manualCompaction: false, ...extra });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "exocortex-app-sessions-test-"));
  registry.setAppRegistryPathForTests(join(scratch, "app-conversations.json"));
  workspaces.setAppWorkspaceRootsForTests({ ephemeral: join(scratch, "ephemeral"), claudeConfig: join(scratch, "claude") });
  accountPool.setAssignmentsFileForTests(join(scratch, "accounts.json"));
  handle = createHandler(server as never);
});

afterAll(async () => {
  await handle.stop();
  resetDaemonShutdownModeForTest();
  registry.setAppRegistryPathForTests(null);
  workspaces.setAppWorkspaceRootsForTests({ ephemeral: null, claudeConfig: null });
  accountPool.setAssignmentsFileForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(async () => {
  for (const convId of created.splice(0)) {
    if (registry.isAppConversation(convId)) await appApi.endAppConversation(convId, "deleted");
    else if (convStore.hasConversation(convId)) convStore.remove(convId);
  }
});

describe("sessions", () => {
  test("app_welcome hands out a session; a bad token or grace is refused", async () => {
    const { welcome } = await asApp();
    expect(welcome.session).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(welcome).toMatchObject({ resumed: false, conversations: [], reconnectGraceMs: 120_000 });
    const client = fakeClient();
    expect(await run(client, { type: "client_capabilities", reqId: "b", capabilities: [], app: { name: "demo", session: "short" } }))
      .toEqual([expect.objectContaining({ type: "error", reqId: "b", message: expect.stringMatching(/app.session/) })]);
    expect(await run(client, { type: "client_capabilities", reqId: "g", capabilities: [], app: { name: "demo", reconnectGraceMs: -1 } }))
      .toEqual([expect.objectContaining({ type: "error", reqId: "g", message: expect.stringMatching(/reconnectGraceMs/) })]);
    expect(await run(client, { type: "client_capabilities", reqId: "o", capabilities: [], app: { name: "other", session: welcome.session } }))
      .toEqual([expect.objectContaining({ type: "error", reqId: "o", message: expect.stringMatching(/belongs to app demo/) })]);
  });

  test("a session back within its grace takes its conversations back, with the turn results it missed", async () => {
    const { client, welcome } = await asApp({ reconnectGraceMs: 60_000 });
    const ephemeral = await createApp(client, { lifetime: "ephemeral" });
    const temporary = await createApp(client, { lifetime: "temporary" });
    disconnect(client);
    await Bun.sleep(10);
    expect(registry.isAppConversation(ephemeral)).toBe(true);
    expect(appApi.appConversationOwner(ephemeral)).toBeNull();
    endTurn(ephemeral, 1111);
    const back = fakeClient();
    const { welcome: again } = await asApp({ session: welcome.session, reconnectGraceMs: 60_000 }, back);
    expect(again).toMatchObject({ session: welcome.session, resumed: true });
    expect(again.conversations).toEqual(expect.arrayContaining([ephemeral, temporary]));
    // The missed result follows the welcome.
    expect(back.events.at(-1)).toMatchObject({ type: "turn_result", convId: ephemeral, turnId: "1111", text: "Done." });
    expect(appApi.appConversationOwner(ephemeral)).toBe(back as never);
    expect(back.subscriptions.has(ephemeral) && back.subscriptions.has(temporary)).toBe(true);
    // Attaching again is harmless.
    expect(await run(back, { type: "attach_app_conversation", reqId: "a", convId: ephemeral }))
      .toEqual([expect.objectContaining({ type: "app_conversation_attached", convId: ephemeral, conversation: expect.objectContaining({ ownerConnected: true }) })]);
  });

  test("a session that does not come back in time loses its ephemeral conversations, not the others", async () => {
    const { client, welcome } = await asApp({ reconnectGraceMs: 30 });
    const ephemeral = await createApp(client, { lifetime: "ephemeral" });
    const temporary = await createApp(client, { lifetime: "temporary" });
    const workspace = registry.getAppRecord(ephemeral)!.ephemeralWorkspace!;
    disconnect(client);
    expect(registry.isAppConversation(ephemeral)).toBe(true);
    await until(() => !registry.isAppConversation(ephemeral));
    expect(existsSync(workspace)).toBe(false);
    expect(registry.isAppConversation(temporary)).toBe(true);
    const { welcome: late } = await asApp({ session: welcome.session });
    expect(late).toMatchObject({ resumed: false, conversations: [] });
  });

  test("end_app_session ends its ephemeral conversations at once", async () => {
    const { client } = await asApp();
    const ephemeral = await createApp(client, { lifetime: "ephemeral" });
    const temporary = await createApp(client, { lifetime: "temporary" });
    const events = await run(client, { type: "end_app_session", reqId: "e" });
    expect(events).toContainEqual({ type: "app_session_ended", reqId: "e", ended: [ephemeral] });
    expect(registry.isAppConversation(ephemeral)).toBe(false);
    expect(registry.isAppConversation(temporary)).toBe(true);
    expect(appApi.appConversationOwner(temporary)).toBeNull();
  });

  test("a second connection on the same session takes it over", async () => {
    const { client, welcome } = await asApp();
    const ephemeral = await createApp(client, { lifetime: "ephemeral" });
    const { client: other } = await asApp({ session: welcome.session });
    expect(appApi.appConversationOwner(ephemeral)).toBe(other as never);
    // The first connection closing later does not disturb the new owner.
    disconnect(client);
    await Bun.sleep(10);
    expect(appApi.appConversationOwner(ephemeral)).toBe(other as never);
  });
});

describe("resending after a reconnect", () => {
  test("a prompt sent again (same startedAt) waits for its turn or gets its result, and never runs twice", async () => {
    const { setActiveJob, clearActiveJob } = await import("./streaming");
    const { client } = await asApp();
    const convId = await createApp(client, { lifetime: "temporary" });
    const prompt = (startedAt: number) => convStore.appendMessages(convId, [{ role: "user", content: "hi", metadata: { startedAt, endedAt: startedAt, model: "gpt-5.4", tokens: 0 } }]);
    prompt(5001);
    endTurn(convId, 5001);
    expect(await run(client, { type: "send_message", reqId: "again", convId, text: "hi", startedAt: 5001, awaitResult: true }))
      .toEqual([expect.objectContaining({ type: "turn_result", reqId: "again", turnId: "5001", text: "Done." })]);
    prompt(5002);
    setActiveJob(convId, new AbortController(), Date.now());
    expect(await run(client, { type: "send_message", reqId: "running", convId, text: "hi", startedAt: 5002, awaitResult: true })).toEqual([]);
    clearActiveJob(convId);
    endTurn(convId, 5002);
    expect(client.events.filter(event => event.type === "turn_result" && (event as { reqId?: string }).reqId === "running")).toHaveLength(1);
    prompt(5003);
    expect(await run(client, { type: "send_message", reqId: "lost", convId, text: "hi", startedAt: 5003, awaitResult: true }))
      .toEqual([expect.objectContaining({ type: "error", reqId: "lost", message: expect.stringMatching(/sent before/) })]);
  });

  test("an app_run sent again with its own convId carries on with that conversation", async () => {
    const { client } = await asApp();
    const convId = `${Date.now()}-rerun1`;
    created.push(convId);
    const { setActiveJob, clearActiveJob } = await import("./streaming");
    running.set(convId, () => {});
    void run(client, { type: "app_run", reqId: "r1", convId, prompt: "Hi.", startedAt: 7001, provider: "openai", model: "gpt-5.4" });
    await until(() => client.events.some(event => event.type === "conversation_created" && event.convId === convId));
    // As the orchestrator would: the prompt is stored and its turn runs.
    convStore.appendMessages(convId, [{ role: "user", content: "Hi.", metadata: { startedAt: 7001, endedAt: 7001, model: "gpt-5.4", tokens: 0 } }]);
    setActiveJob(convId, new AbortController(), Date.now());
    const again = await run(fakeClient(), { type: "app_run", reqId: "r2", convId, prompt: "Hi.", provider: "openai", model: "gpt-5.4", app: "demo" });
    // Another connection without the session cannot take an ephemeral run.
    expect(again).toEqual([expect.objectContaining({ type: "error", reqId: "r2", message: expect.stringMatching(/ephemeral/) })]);
    const mine = await run(client, { type: "app_run", reqId: "r3", convId, prompt: "Hi.", startedAt: 7001, provider: "openai", model: "gpt-5.4" });
    expect(mine.some(event => event.type === "conversation_created")).toBe(false);
    expect(mine[0]).toMatchObject({ type: "app_conversation_attached", reqId: "r3", convId });
    expect(registry.getAppRecord(convId)?.endAfterTurn).toBe(true);
    // The turn ends: the resent run gets its result, and the conversation goes.
    clearActiveJob(convId);
    endTurn(convId, 7001);
    expect(client.events).toContainEqual(expect.objectContaining({ type: "turn_result", reqId: "r3", turnId: "7001" }));
    running.get(convId)!();
    running.delete(convId);
    await until(() => !registry.isAppConversation(convId));
  });
});

describe("routes", () => {
  test("route preferences are validated, kept, reported and replaceable; ordinary conversations refuse them", async () => {
    const { client } = await asApp();
    const [createdEvent] = await run(client, { type: "new_conversation", reqId: "r", provider: "openai", model: "gpt-5.4", lifetime: "temporary", route: { credits: "never", whenLimited: "error" } });
    const convId = (createdEvent as { convId: string }).convId;
    created.push(convId);
    expect(createdEvent).toMatchObject({ app: { route: { credits: "never", whenLimited: "error" } } });
    expect(registry.conversationAllowsApiCredits(convId)).toBe(false);
    expect(registry.conversationWaitsForUsageLimits(convId)).toBe(false);
    expect(await run(client, { type: "new_conversation", reqId: "x", lifetime: "temporary", route: { credits: "sometimes" } }))
      .toEqual([expect.objectContaining({ type: "error", reqId: "x", message: expect.stringMatching(/route.credits/) })]);
    const tui = fakeClient();
    expect(await run(tui, { type: "new_conversation", reqId: "t", route: { credits: "never" } }))
      .toEqual([expect.objectContaining({ type: "error", reqId: "t", message: expect.stringMatching(/route is only for app conversations/) })]);
    const [attached] = await run(client, { type: "attach_app_conversation", reqId: "a", convId, route: { credits: "allow" } });
    expect((attached as Extract<Event, { type: "app_conversation_attached" }>).conversation.route).toBeUndefined();
    expect(registry.conversationAllowsApiCredits(convId)).toBe(true);
    // Defaults for everything else.
    expect(registry.conversationAllowsApiCredits(undefined)).toBe(true);
    expect(registry.conversationWaitsForUsageLimits("not-an-app")).toBe(true);
  });

  test("turn_result says when a turn ran on API credits or stopped at a usage limit", async () => {
    const { client } = await asApp();
    const convId = await createApp(client, { lifetime: "temporary" });
    endTurn(convId, 2222, { billing: "api-credits" });
    expect(client.events.at(-1)).toMatchObject({ type: "turn_result", turnId: "2222", billing: "api-credits", stopReason: "end_turn" });
    endTurn(convId, 3333, { ok: false, error: "✗ limited", limited: { resetAt: 1_800_000_000_000 } });
    expect(client.events.at(-1)).toMatchObject({ type: "turn_result", turnId: "3333", stopReason: "error", limited: { resetAt: 1_800_000_000_000 } });
  });
});

describe("graceful restarts", () => {
  test("the next daemon takes over sessions and ephemeral conversations; app commands wait for recovery", async () => {
    const { client, welcome } = await asApp({ reconnectGraceMs: 60_000 });
    const ephemeral = await createApp(client, { lifetime: "ephemeral", route: { credits: "never" } });
    const temporary = await createApp(client, { lifetime: "temporary" });
    convStore.appendMessages(ephemeral, [{ role: "user", content: "remember 42", metadata: { startedAt: 5, endedAt: 5, model: "gpt-5.4", tokens: 0 } }]);
    accountPool.touchConversationAccount(ephemeral, "max2", 1234);
    const workspace = registry.getAppRecord(ephemeral)!.ephemeralWorkspace!;

    // The old daemon: a graceful restart.
    beginDaemonShutdown("restart");
    await handle.stop();
    expect(registry.isAppConversation(ephemeral)).toBe(true);
    // A turn that ends while the restart's turns settle is kept for the session.
    endTurn(temporary, 8888);
    expect(appApi.handOffAppConversations()).toBe(1);
    const file = join(workspaces.ephemeralWorkspaceRoot(), "handoff.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // What only lived in the old daemon's memory goes with it.
    convStore.purge(ephemeral);
    registry.removeAppConversationRecord(ephemeral);
    accountPool.forgetConversationAccount(ephemeral);
    resetDaemonShutdownModeForTest();

    // The new daemon: clients can connect before recovery, their commands wait.
    handle = createHandler(server as never, { holdQueueDeliveryUntilReady: true });
    const back = fakeClient();
    await asApp({ session: welcome.session, reconnectGraceMs: 60_000 }, back);
    expect(await run(back, { type: "attach_app_conversation", reqId: "a", convId: ephemeral })).toEqual([]);
    await appApi.recoverAppConversations();
    expect(existsSync(file)).toBe(false);
    expect(registry.getAppRecord(ephemeral)).toMatchObject({ lifetime: "ephemeral", route: { credits: "never" } });
    expect(convStore.getCached(ephemeral)!.messages.some(message => message.content === "remember 42")).toBe(true);
    expect(existsSync(workspace)).toBe(true);
    expect(accountPool.getConversationAccount(ephemeral)).toEqual({ account: "max2", lastUsedAt: 1234 });
    expect(appApi.appConversationOwner(temporary)).toBe(back as never);
    expect(back.events).toContainEqual(expect.objectContaining({ type: "turn_result", convId: temporary, turnId: "8888" }));
    handle.startQueueDelivery();
    await until(() => back.events.some(event => event.type === "app_conversation_attached"));
    expect(back.events.at(-1)).toMatchObject({ type: "app_conversation_attached", reqId: "a", convId: ephemeral });
  });

  test("an app_run conversation handed over ends after its replayed turn", async () => {
    const { client } = await asApp();
    const convId = await createApp(client, { lifetime: "ephemeral" });
    registry.getAppRecord(convId)!.endAfterTurn = true;
    endTurn(convId, 4444);
    expect(client.events.at(-1)).toMatchObject({ type: "turn_result", turnId: "4444" });
    await until(() => !registry.isAppConversation(convId));
  });

  test("after a crash nothing is handed over: the session is unknown and ephemeral conversations are gone", async () => {
    const leftover = join(workspaces.ephemeralWorkspaceRoot(), "crashed-conv");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(leftover, { recursive: true });
    await appApi.recoverAppConversations();
    expect(existsSync(leftover)).toBe(false);
    const { welcome } = await asApp({ session: "crashed-session-token-123" });
    expect(welcome).toMatchObject({ session: "crashed-session-token-123", resumed: false, conversations: [] });
  });

  test("a stop ends ephemeral conversations instead of handing them over", async () => {
    const { client } = await asApp();
    const ephemeral = await createApp(client, { lifetime: "ephemeral" });
    beginDaemonShutdown("stop");
    await appApi.shutdownAppConversations();
    expect(registry.isAppConversation(ephemeral)).toBe(false);
    expect(appApi.handOffAppConversations()).toBe(0);
    resetDaemonShutdownModeForTest();
    handle = createHandler(server as never);
  });
});
