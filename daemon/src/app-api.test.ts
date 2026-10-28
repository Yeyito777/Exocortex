import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationsDir, conversationWorkspaceDir, dataDir } from "@exocortex/shared/paths";
import { notifyAssistantTurnEnded } from "./conversation-lifecycle";
import type { Command, Event } from "./protocol";

// Turns are simulated: the orchestrator only reports their end, as the real one does.
const turnBlocks = { value: [{ type: "text", text: "Done." }] as { type: string; text?: string }[] };
const orchestrateSendMessage = mock(async (_server: unknown, _client: unknown, _reqId: unknown, convId: string, _text: string, startedAt: number) => {
  notifyAssistantTurnEnded({ convId, promptStartedAt: startedAt, ok: true, blocks: turnBlocks.value, tokens: 7, durationMs: 5, manualCompaction: false });
  return { ok: true, blocks: [], tokens: 7, durationMs: 5, endedAt: Date.now() };
});
const orchestrateReplayConversation = mock(async () => ({ ok: true, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now() }));
mock.module("./orchestrator", () => ({
  orchestrateSendMessage,
  orchestrateReplayConversation,
  orchestrateCompactConversation: mock(async () => ({ ok: true, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now() })),
  orchestrateGoalCycle: mock(async () => {}),
}));

const { createHandler } = await import("./handler");
const convStore = await import("./conversations");
const registry = await import("./app-registry");
const appApi = await import("./app-api");
const workspaces = await import("./app-workspaces");
const { DaemonServer } = await import("./server");
const { setActiveJob, clearActiveJob } = await import("./streaming");
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
const broadcasts: Event[] = [];

function fakeClient(): FakeClient {
  return { id: `fc${++clientCounter}`, socket: { destroyed: false }, subscriptions: new Set(), capabilities: new Set(), events: [] };
}

const server = {
  sendTo: (client: FakeClient, event: Event) => { client.events.push(event); return 0; },
  broadcast: (event: Event) => { broadcasts.push(event); },
  broadcastExcept: (event: Event) => { broadcasts.push(event); },
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

async function asApp(name = "demo"): Promise<FakeClient> {
  const client = fakeClient();
  const [welcome] = await run(client, { type: "client_capabilities", reqId: "w", capabilities: [], app: { name, version: "1" } });
  expect(welcome).toMatchObject({ type: "app_welcome", reqId: "w", appApiVersion: 1, app: name });
  return client;
}

async function createApp(client: FakeClient, fields: Record<string, unknown>): Promise<string> {
  const [answer] = await run(client, { type: "new_conversation", reqId: "c", provider: "openai", model: "gpt-5.4", ...fields });
  expect(answer?.type).toBe("conversation_created");
  const convId = (answer as { convId: string }).convId;
  created.push(convId);
  return convId;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "exocortex-app-api-test-"));
  registry.setAppRegistryPathForTests(join(scratch, "app-conversations.json"));
  workspaces.setAppWorkspaceRootsForTests({ ephemeral: join(scratch, "ephemeral"), claudeConfig: join(scratch, "claude") });
  accountPool.setAssignmentsFileForTests(join(scratch, "accounts.json"));
  handle = createHandler(server as never);
});

afterAll(async () => {
  await handle.stop();
  registry.setAppRegistryPathForTests(null);
  workspaces.setAppWorkspaceRootsForTests({ ephemeral: null, claudeConfig: null });
  accountPool.setAssignmentsFileForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  turnBlocks.value = [{ type: "text", text: "Done." }];
  broadcasts.length = 0;
});

afterEach(async () => {
  for (const convId of created.splice(0)) {
    clearActiveJob(convId);
    if (registry.isAppConversation(convId)) await appApi.endAppConversation(convId, "deleted");
    else convStore.remove(convId);
  }
});

describe("app clients", () => {
  test("declare themselves and are told the API version; ping answers only pong", async () => {
    const client = await asApp();
    expect(client.app?.name).toBe("demo");
    expect(await run(client, { type: "ping", reqId: "p" })).toEqual([{ type: "pong", reqId: "p" }]);
  });

  test("an invalid app name is refused", async () => {
    const client = fakeClient();
    expect(await run(client, { type: "client_capabilities", reqId: "w", capabilities: [], app: { name: "Bad Name" } }))
      .toEqual([{ type: "error", reqId: "w", message: expect.stringMatching(/app.name/) }]);
    expect(client.app).toBeUndefined();
  });
});

describe("creating app conversations", () => {
  test("app-only fields are refused on ordinary conversations, before anything is created", async () => {
    const tui = fakeClient();
    const [answer] = await run(tui, { type: "new_conversation", reqId: "x", lifetime: "temporary" });
    expect(answer).toMatchObject({ type: "error", reqId: "x", message: expect.stringMatching(/lifetime.*app/) });
  });

  test("bad fields name the problem", async () => {
    const client = await asApp();
    for (const [fields, pattern] of [
      [{ lifetime: "forever" }, /lifetime/],
      [{ idleTtlMs: 1000 }, /idleTtlMs is only for temporary/],
      [{ lifetime: "temporary", idleTtlMs: -1 }, /idleTtlMs/],
      [{ system: { base: "most" } }, /system.base/],
      [{ cwd: "relative/dir" }, /absolute/],
      [{ cwd: "/definitely/not/here" }, /not an existing directory/],
      [{ tools: { builtin: ["bash", "warp"] } }, /warp/],
      [{ tools: { app: [{ name: "read", description: "x", inputSchema: { type: "object" } }] } }, /built-in/],
      [{ subagent: true }, /subagent/],
      [{ app: "other" }, /This connection is app demo/],
    ] as const) {
      const [answer] = await run(client, { type: "new_conversation", reqId: "bad", provider: "openai", model: "gpt-5.4", ...fields });
      expect(answer).toMatchObject({ type: "error", reqId: "bad" });
      expect((answer as { message: string }).message).toMatch(pattern);
    }
    expect(registry.listAppRecords()).toEqual([]);
  });

  test("saved: filed under apps/<app>/, shown, never unread, the app's title", async () => {
    const client = await asApp();
    const convId = await createApp(client, { title: "My app chat" });
    const created = client.events.find(event => event.type === "conversation_created") as Extract<Event, { type: "conversation_created" }>;
    expect(created.app).toMatchObject({ convId, app: "demo", lifetime: "saved", systemBase: "none", builtinTools: [], appTools: [], ownerConnected: true });
    const summary = convStore.getSummary(convId)!;
    const folders = convStore.listFolders();
    const folder = folders.find(candidate => candidate.id === summary.folderId)!;
    expect(folder.name).toBe("demo");
    expect(folders.find(candidate => candidate.id === folder.parentId)).toMatchObject({ name: "apps", muted: true });
    expect(convStore.listSummaries().some(row => row.id === convId)).toBe(true);
    expect(summary).toMatchObject({ title: "My app chat", unread: false, notificationsMuted: true });
    convStore.markUnread(convId);
    expect(convStore.isUnread(convId)).toBe(false);
    expect(client.subscriptions.has(convId)).toBe(true);
    expect(existsSync(conversationWorkspaceDir(convId))).toBe(true);
    // A second saved conversation reuses the folders.
    const second = await createApp(client, {});
    expect(convStore.getSummary(second)!.folderId).toBe(summary.folderId);
  });

  test("temporary and ephemeral are hidden from every list and from sidebar ordering", async () => {
    const client = await asApp();
    const visible = convStore.listSummaries().length;
    const temporary = await createApp(client, { lifetime: "temporary" });
    const ephemeral = await createApp(client, { lifetime: "ephemeral" });
    expect(convStore.listSummaries().length).toBe(visible);
    expect(convStore.listSidebarState().conversations.some(row => row.id === temporary || row.id === ephemeral)).toBe(false);
    expect(convStore.hasConversation(temporary) && convStore.hasConversation(ephemeral)).toBe(true);
    expect(convStore.getSummary(ephemeral)).not.toBeNull();
    expect(convStore.listAllSummaries().some(row => row.id === temporary)).toBe(true);
    // A new visible conversation's place ignores them.
    const tui = fakeClient();
    const [ordinary] = await run(tui, { type: "new_conversation", reqId: "o", provider: "openai", model: "gpt-5.4" });
    const ordinaryId = (ordinary as { convId: string }).convId;
    created.push(ordinaryId);
    const roots = convStore.listSummaries().filter(row => !row.folderId).map(row => row.sortOrder);
    expect(convStore.getSummary(ordinaryId)!.sortOrder).toBe(Math.min(...roots));
  });

  test("ephemeral conversations are never written: no file, queue entry, pending instructions or journal", async () => {
    const client = await asApp();
    const convId = await createApp(client, { lifetime: "ephemeral", system: { text: "Be brief." } });
    const record = registry.getAppRecord(convId)!;
    expect(record.ephemeralWorkspace && existsSync(record.ephemeralWorkspace)).toBe(true);
    expect(existsSync(conversationWorkspaceDir(convId))).toBe(false);
    convStore.appendMessages(convId, [{ role: "user", content: "hello", metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.4", tokens: 0 } }]);
    convStore.markDirty(convId);
    convStore.flush(convId);
    convStore.flushAll();
    convStore.pushQueuedMessage(convId, "later", "next-turn");
    convStore.setSystemInstructions(convId, "changed");
    setActiveJob(convId, new AbortController(), Date.now());
    expect(convStore.listRestartRecoverableConversationIds()).not.toContain(convId);
    clearActiveJob(convId);
    const onDisk = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter(name => name.includes(convId)) : [];
    expect(onDisk(conversationsDir())).toEqual([]);
    expect(onDisk(dataDir()).filter(name => !name.startsWith("workspaces"))).toEqual([]);
    for (const file of ["message-queue.json", "pending-conversation-instructions.json"]) {
      const path = join(dataDir(), file);
      if (existsSync(path)) expect(readFileSync(path, "utf8")).not.toContain(convId);
    }
    expect(existsSync(registry.appRegistryPath()) ? readFileSync(registry.appRegistryPath(), "utf8") : "").not.toContain(convId);
    accountPool.touchConversationAccount(convId, "main");
    accountPool.flushAssignments();
    expect(readFileSync(join(scratch, "accounts.json"), "utf8")).not.toContain(convId);
    // It survives cache pressure: memory is its only copy.
    convStore.conversationCacheInternalsForTest.setLimits({ maxEntries: 0, maxFileBytes: 0 });
    expect(convStore.getCached(convId)).toBeDefined();
    convStore.conversationCacheInternalsForTest.resetLimits();
    convStore.clearQueuedMessages(convId);
  });

  test("saved and temporary records persist; ephemeral ones do not", async () => {
    const client = await asApp();
    const saved = await createApp(client, { tools: { app: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }] } });
    const temporary = await createApp(client, { lifetime: "temporary", idleTtlMs: 5000 });
    const ephemeral = await createApp(client, { lifetime: "ephemeral" });
    const file = JSON.parse(readFileSync(registry.appRegistryPath(), "utf8")) as { conversations: Record<string, unknown> };
    expect(Object.keys(file.conversations).sort()).toEqual([saved, temporary].sort());
    expect(file.conversations[saved]).toMatchObject({ app: "demo", lifetime: "saved", appTools: [{ name: "lookup" }] });
    expect(file.conversations[temporary]).toMatchObject({ lifetime: "temporary", idleTtlMs: 5000 });
    // A restart reads them back; the ephemeral one is gone with the daemon.
    registry.resetAppRegistryForTests();
    expect(registry.loadAppRegistry()).toBe(2);
    expect(registry.getAppRecord(saved)?.appTools[0]?.name).toBe("lookup");
    expect(registry.isAppConversation(ephemeral)).toBe(false);
    created.splice(created.indexOf(ephemeral), 1);
    convStore.purge(ephemeral);
  });
});

describe("awaited turns", () => {
  test("send_message with awaitResult answers turn_result with the turn's identity", async () => {
    const client = await asApp();
    const convId = await createApp(client, { lifetime: "ephemeral" });
    turnBlocks.value = [{ type: "text", text: "Looking." }, { type: "tool_call" }, { type: "tool_result" }, { type: "text", text: "A frog." }];
    const events = await run(client, { type: "send_message", reqId: "s1", convId, text: "What is zorp?\nmore", startedAt: 1234, awaitResult: true });
    expect(events).toContainEqual({ type: "turn_result", reqId: "s1", convId, turnId: "1234", text: "A frog.", stopReason: "end_turn", usage: { outputTokens: 7, durationMs: 5 } });
    expect(events.filter(event => event.type === "turn_result")).toHaveLength(1);
    expect(convStore.getSummary(convId)!.title).toBe("What is zorp?");
    expect(registry.getAppRecord(convId)!.lastTurnResult).toMatchObject({ turnId: "1234", text: "A frog." });
  });

  test("the current owner hears every turn's end; an awaiting connection gets its reqId", async () => {
    const owner = await asApp();
    const convId = await createApp(owner, { lifetime: "temporary" });
    const other = await asApp();
    const events = await run(other, { type: "send_message", reqId: "s2", convId, text: "hi", startedAt: 99, awaitResult: true });
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_result", reqId: "s2", turnId: "99" }));
    expect(owner.events.filter(event => event.type === "turn_result")).toEqual([expect.objectContaining({ type: "turn_result", convId, turnId: "99" })]);
    expect(owner.events.find(event => event.type === "turn_result")).not.toHaveProperty("reqId");
  });

  test("a send refused before its turn starts forgets its await", async () => {
    const client = await asApp();
    const convId = await createApp(client, { lifetime: "ephemeral" });
    orchestrateSendMessage.mockImplementationOnce(async () => ({ ok: false, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now(), error: "Already streaming" }));
    await run(client, { type: "send_message", reqId: "s3", convId, text: "x", startedAt: 5, awaitResult: true });
    notifyAssistantTurnEnded({ convId, promptStartedAt: 5, ok: true, blocks: [], tokens: 0, durationMs: 0, manualCompaction: false });
    expect(client.events.filter(event => event.type === "turn_result" && "reqId" in event && event.reqId === "s3")).toEqual([]);
  });

  test("an aborted turn reports aborted; a paused or restart-interrupted one reports nothing yet", async () => {
    const client = await asApp();
    const convId = await createApp(client, { lifetime: "temporary" });
    const before = client.events.length;
    notifyAssistantTurnEnded({ convId, promptStartedAt: 1, ok: false, aborted: true, blocks: [], tokens: 0, durationMs: 1, manualCompaction: false });
    notifyAssistantTurnEnded({ convId, promptStartedAt: 2, ok: true, suspended: true, blocks: [], tokens: 0, durationMs: 1, manualCompaction: false });
    notifyAssistantTurnEnded({ convId, promptStartedAt: 3, ok: false, aborted: true, daemonRestart: true, blocks: [], tokens: 0, durationMs: 1, manualCompaction: false });
    notifyAssistantTurnEnded({ convId, promptStartedAt: 4, ok: false, error: "boom", blocks: [], tokens: 0, durationMs: 1, manualCompaction: false });
    expect(client.events.slice(before).map(event => event.type === "turn_result" ? [event.turnId, event.stopReason, event.error] : event.type))
      .toEqual([["1", "aborted", undefined], ["4", "error", "boom"]]);
  });

  test("app_run: created, turn_result, then the ephemeral conversation is deleted", async () => {
    const client = await asApp();
    const events = await run(client, { type: "app_run", reqId: "r1", prompt: "Name a prime.", startedAt: 77, system: { text: "Terse." }, provider: "openai", model: "gpt-5.4" });
    // The deletion reaches the owner as a broadcast to the conversation's subscribers.
    expect(events.map(event => [event.type, "reqId" in event ? event.reqId : undefined])).toEqual([
      ["conversation_created", "r1"],
      ["turn_result", "r1"],
    ]);
    const createdEvent = events[0] as Extract<Event, { type: "conversation_created" }>;
    expect(createdEvent.app).toMatchObject({ lifetime: "ephemeral", title: "Name a prime." });
    expect(events[1]).toMatchObject({ type: "turn_result", turnId: "77", stopReason: "end_turn" });
    expect(registry.isAppConversation(createdEvent.convId)).toBe(false);
    expect(convStore.hasConversation(createdEvent.convId)).toBe(false);
    expect(broadcasts).toContainEqual({ type: "conversation_deleted", convId: createdEvent.convId, reason: "run_finished" });
  });

  test("app_run keeps the conversation with keep, and refuses bad fields with error before creating anything", async () => {
    const client = await asApp();
    const kept = await run(client, { type: "app_run", reqId: "r2", prompt: "Hi.", keep: true, provider: "openai", model: "gpt-5.4" });
    const convId = (kept[0] as { convId: string }).convId;
    created.push(convId);
    expect(registry.getAppRecord(convId)?.lifetime).toBe("ephemeral");
    const bad = await run(client, { type: "app_run", reqId: "r3", prompt: "Hi.", tools: { builtin: ["laser"] }, provider: "openai", model: "gpt-5.4" });
    expect(bad).toEqual([{ type: "error", reqId: "r3", convId: expect.any(String), message: expect.stringMatching(/laser/) }]);
    const tui = fakeClient();
    expect(await run(tui, { type: "app_run", reqId: "r4", prompt: "Hi." })).toEqual([{ type: "error", reqId: "r4", message: expect.stringMatching(/needs an app/) }]);
    expect(await run(client, { type: "app_run", reqId: "r5", prompt: " " })).toEqual([{ type: "error", reqId: "r5", message: expect.stringMatching(/prompt/) }]);
  });
});

describe("ownership", () => {
  test("an ephemeral conversation ends when its owner disconnects; others wait for a new owner", async () => {
    const owner = await asApp();
    const ephemeral = await createApp(owner, { lifetime: "ephemeral" });
    const temporary = await createApp(owner, { lifetime: "temporary" });
    const workspace = registry.getAppRecord(ephemeral)!.ephemeralWorkspace!;
    owner.socket.destroyed = true;
    closeListener!(owner);
    await Bun.sleep(20);
    expect(registry.isAppConversation(ephemeral)).toBe(false);
    expect(convStore.hasConversation(ephemeral)).toBe(false);
    expect(existsSync(workspace)).toBe(false);
    expect(registry.isAppConversation(temporary)).toBe(true);
    expect(appApi.appConversationOwner(temporary)).toBeNull();
  });

  test("attach makes a new owner, carries the last turn result, and may replace the app tools", async () => {
    const first = await asApp();
    const convId = await createApp(first, { lifetime: "temporary" });
    await run(first, { type: "send_message", reqId: "s", convId, text: "hi", startedAt: 42, awaitResult: true });
    const second = await asApp();
    const [attached] = await run(second, { type: "attach_app_conversation", reqId: "a", convId, tools: { app: [{ name: "pick", description: "Pick one.", inputSchema: { type: "object" } }] } });
    expect(attached).toMatchObject({ type: "app_conversation_attached", reqId: "a", convId, conversation: { appTools: ["pick"], ownerConnected: true }, lastTurnResult: { turnId: "42", text: "Done." } });
    expect(appApi.appConversationOwner(convId)).toBe(second as never);
    expect(second.subscriptions.has(convId)).toBe(true);
    const [bad] = await run(second, { type: "attach_app_conversation", reqId: "b", convId, tools: { app: [{ name: "bash", description: "x", inputSchema: {} }] } });
    expect(bad).toMatchObject({ type: "error", reqId: "b" });
  });

  test("another connection cannot take an ephemeral conversation, nor another app's", async () => {
    const owner = await asApp();
    const ephemeral = await createApp(owner, { lifetime: "ephemeral" });
    const thief = await asApp();
    expect(await run(thief, { type: "attach_app_conversation", reqId: "t", convId: ephemeral })).toEqual([
      expect.objectContaining({ type: "error", reqId: "t", message: expect.stringMatching(/ephemeral/) }),
    ]);
    const saved = await createApp(owner, {});
    const otherApp = await asApp("other");
    expect(await run(otherApp, { type: "attach_app_conversation", reqId: "o", convId: saved })).toEqual([
      expect.objectContaining({ type: "error", reqId: "o", message: expect.stringMatching(/belongs to app demo/) }),
    ]);
  });

  test("list_app_conversations lists hidden ones, and saved ones on request", async () => {
    const client = await asApp();
    const saved = await createApp(client, {});
    const temporary = await createApp(client, { lifetime: "temporary" });
    const [hidden] = await run(client, { type: "list_app_conversations", reqId: "l" });
    const hiddenIds = (hidden as Extract<Event, { type: "app_conversations_list" }>).conversations.map(info => info.convId);
    expect(hiddenIds).toContain(temporary);
    expect(hiddenIds).not.toContain(saved);
    const [all] = await run(client, { type: "list_app_conversations", reqId: "l2", includeSaved: true, app: "demo" });
    expect((all as Extract<Event, { type: "app_conversations_list" }>).conversations.map(info => info.convId)).toEqual(expect.arrayContaining([saved, temporary]));
  });
});

describe("deleting and expiring", () => {
  test("deleting is for good and never touches an app cwd; a daemon workspace and Claude Code sessions go", async () => {
    const client = await asApp();
    const cwd = join(scratch, "app-cwd");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "keep.txt"), "mine");
    const withCwd = await createApp(client, { cwd });
    const withWorkspace = await createApp(client, { lifetime: "temporary" });
    const workspace = conversationWorkspaceDir(withWorkspace);
    expect(existsSync(workspace)).toBe(true);
    // A Claude Code session of the app-cwd conversation.
    const projects = join(scratch, "claude", "projects", workspaces.claudeProjectDirName(cwd));
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "11111111-2222-3333-4444-555555555555.jsonl"), "{}");
    writeFileSync(join(projects, "99999999-2222-3333-4444-555555555555.jsonl"), "{}");
    convStore.appendMessages(withCwd, [{ role: "assistant", content: [{ type: "text", text: "x" }], metadata: null, providerData: { anthropic: { sessionId: "11111111-2222-3333-4444-555555555555", resumeAt: "u", cwd } } }]);
    const events = await run(client, { type: "delete_conversation", reqId: "d1", convId: withCwd });
    created.splice(created.indexOf(withCwd), 1);
    expect(events).toContainEqual({ type: "conversation_deleted", reqId: "d1", convId: withCwd, reason: "deleted" });
    expect(readFileSync(join(cwd, "keep.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(projects, "11111111-2222-3333-4444-555555555555.jsonl"))).toBe(false);
    expect(existsSync(join(projects, "99999999-2222-3333-4444-555555555555.jsonl"))).toBe(true);
    expect(convStore.hasConversation(withCwd) || convStore.hasDeletedConversation(withCwd)).toBe(false);
    await run(client, { type: "delete_conversation", reqId: "d2", convId: withWorkspace });
    created.splice(created.indexOf(withWorkspace), 1);
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(join(dataDir(), "trash", "workspaces", withWorkspace))).toBe(false);
    expect(readFileSync(registry.appRegistryPath(), "utf8")).not.toContain(withWorkspace);
  });

  test("an app cwd that equals a daemon path is still never removed", () => {
    const cwd = join(scratch, "ephemeral", "conv-cwd");
    mkdirSync(cwd, { recursive: true });
    workspaces.removeAppWorkspace({ convId: "conv-cwd", app: "demo", lifetime: "ephemeral", createdAt: 0, lastActivityAt: 0, system: { text: "", base: "none" }, builtin: [], appTools: [], cwd });
    expect(existsSync(cwd)).toBe(true);
  });

  test("temporary conversations expire after their idle time, never while running", async () => {
    const client = await asApp();
    const idle = await createApp(client, { lifetime: "temporary", idleTtlMs: 1000 });
    const busy = await createApp(client, { lifetime: "temporary", idleTtlMs: 1000 });
    const fresh = await createApp(client, { lifetime: "temporary", idleTtlMs: 60_000 });
    setActiveJob(busy, new AbortController(), Date.now());
    const now = Date.now() + 2000;
    expect(await appApi.sweepExpiredAppConversations(now)).toEqual([idle]);
    created.splice(created.indexOf(idle), 1);
    expect(convStore.hasConversation(idle) || convStore.hasDeletedConversation(idle)).toBe(false);
    expect(broadcasts).toContainEqual({ type: "conversation_deleted", convId: idle, reason: "expired" });
    clearActiveJob(busy);
    // Any command on it counts as activity.
    await run(client, { type: "load_instructions", reqId: "li", convId: fresh });
    expect(registry.getAppRecord(fresh)!.lastActivityAt).toBeGreaterThan(registry.getAppRecord(fresh)!.createdAt - 1);
  });

  test("startup drops records whose conversation is gone and sweeps what crashed ephemeral conversations left", async () => {
    registry.registerAppConversation({ convId: "gone-1", app: "demo", lifetime: "saved", createdAt: 0, lastActivityAt: 0, system: { text: "", base: "none" }, builtin: [], appTools: [] });
    const leftover = join(workspaces.ephemeralWorkspaceRoot(), "crashed-conv");
    mkdirSync(leftover, { recursive: true });
    const project = join(scratch, "claude", "projects", workspaces.claudeProjectDirName(leftover));
    mkdirSync(project, { recursive: true });
    await appApi.recoverAppConversations();
    expect(registry.isAppConversation("gone-1")).toBe(false);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(project)).toBe(false);
  });
});

describe("the server keeps hidden conversations and app clients apart", () => {
  test("broadcasts reach app clients only for subscribed conversations, hidden ones only their subscribers", async () => {
    const socketDir = mkdtempSync(join(tmpdir(), "exo-app-sock-"));
    const path = join(socketDir, "s.sock");
    const realServer = new DaemonServer(path, (client, command) => {
      if (command.type === "client_capabilities" && command.app) client.app = command.app;
      if (command.type === "subscribe") realServer.subscribe(client, command.convId);
    });
    realServer.setHiddenConversationFilter(convId => convId === "hidden-1");
    await realServer.start();
    const open = async (): Promise<{ socket: Socket; lines: string[] }> => {
      const lines: string[] = [];
      const socket = connect(path);
      await new Promise<void>(resolve => socket.once("connect", () => resolve()));
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
      return { socket, lines };
    };
    try {
      const tui = await open();
      const app = await open();
      const watcher = await open();
      app.socket.write(`${JSON.stringify({ type: "client_capabilities", capabilities: [], app: { name: "demo" } })}\n`);
      app.socket.write(`${JSON.stringify({ type: "subscribe", convId: "app-conv" })}\n`);
      watcher.socket.write(`${JSON.stringify({ type: "subscribe", convId: "hidden-1" })}\n`);
      await Bun.sleep(50);
      const closed: string[] = [];
      realServer.onClientClosed(client => closed.push(client.id));
      realServer.broadcast({ type: "usage_update", provider: "openai", usage: null });
      realServer.broadcast({ type: "conversation_deleted", convId: "app-conv" });
      realServer.broadcast({ type: "conversation_deleted", convId: "hidden-1" });
      realServer.broadcast({ type: "daemon_shutdown", mode: "restart" });
      realServer.broadcastLegacyTokenStats(() => ({}) as never);
      await Bun.sleep(50);
      const types = (lines: string[]) => lines.map(line => { const event = JSON.parse(line); return event.convId ? `${event.type}:${event.convId}` : event.type; });
      expect(types(tui.lines)).toEqual(["usage_update", "conversation_deleted:app-conv", "daemon_shutdown", "token_stats"]);
      expect(types(app.lines)).toEqual(["conversation_deleted:app-conv", "daemon_shutdown"]);
      expect(types(watcher.lines)).toEqual(["usage_update", "conversation_deleted:app-conv", "conversation_deleted:hidden-1", "daemon_shutdown", "token_stats"]);
      app.socket.destroy();
      await Bun.sleep(50);
      expect(closed).toHaveLength(1);
      tui.socket.destroy();
      watcher.socket.destroy();
    } finally {
      await realServer.stop();
      rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
