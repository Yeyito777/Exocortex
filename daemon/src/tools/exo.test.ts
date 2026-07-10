import { afterEach, describe, expect, mock, test } from "bun:test";
import { createExocortexToolRuntime } from "../exocortex-tool-runtime";
import {
  clearActiveJob,
  create,
  createWithInitialUserMessage,
  deleteFolder,
  findTopLevelFolderByName,
  get,
  getQueuedMessages,
  getSummary,
  listSidebarState,
  remove,
  setActiveJob,
} from "../conversations";
import { resetConversationActivityForTest, setSubagentActive } from "../conversation-activity";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID } from "../messages";
import { EXO_ACTIONS, exo } from "./exo";

const conversationIds: string[] = [];
const folderIds: string[] = [];

function id(suffix: string): string {
  const value = `exo-tool-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  conversationIds.push(value);
  return value;
}

function fakeServer() {
  return {
    broadcast: mock(() => {}),
    sendTo: mock(() => {}),
    sendToSubscribers: mock(() => {}),
    sendToSubscribersExcept: mock(() => {}),
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
    hasSubscribers: mock(() => false),
  };
}

function successfulOutcome(text = "done") {
  return {
    ok: true as const,
    blocks: [{ type: "text" as const, text }],
    tokens: 3,
    durationMs: 10,
    endedAt: Date.now(),
  };
}

afterEach(() => {
  resetConversationActivityForTest();
  for (const convId of conversationIds.splice(0)) {
    clearActiveJob(convId);
    remove(convId);
  }
  for (const folderId of folderIds.splice(0).reverse()) deleteFolder(folderId);
  const subagents = findTopLevelFolderByName("subagents");
  if (subagents && listSidebarState().conversations.every(conversation => conversation.folderId !== subagents.id)) {
    deleteFolder(subagents.id);
  }
});

describe("native exo tool contract", () => {
  test("keeps a compact top-level orchestration surface", () => {
    expect(EXO_ACTIONS).toEqual([
      "send", "list", "jobs", "info", "history", "abort", "queue", "commands",
    ]);
    expect(EXO_ACTIONS).not.toContain("transcribe" as never);
    expect(EXO_ACTIONS).not.toContain("llm" as never);
    expect(EXO_ACTIONS).not.toContain("folder_mkdir" as never);
    expect(EXO_ACTIONS).not.toContain("delete" as never);
    expect(EXO_ACTIONS).not.toContain("rename" as never);
    expect(EXO_ACTIONS).not.toContain("status" as never);
    const schema = JSON.stringify(exo.inputSchema);
    expect(schema).not.toContain("folder_mkdir");
    expect(schema).not.toContain("system_prompt");
    expect(schema).not.toContain('"title"');
    expect(schema).toContain("max_depth");
    expect(exo.description).toContain("Transcription and cross-instance targeting are intentionally excluded");
    expect(exo.systemHint).toContain("action=commands");
    expect(exo.systemHint).toContain("max_depth is required");
    expect(exo.systemHint).toContain("external `exo` CLI through bash only when debugging or targeting another daemon");
  });

  test("preserves long task text in summaries so the TUI can wrap it", () => {
    const text = `${"Inspect every relevant file and report the exact behavior. ".repeat(5)}TAIL_SENTINEL`;

    expect(text.length).toBeGreaterThan(180);
    expect(exo.summarize({ action: "send", text }).detail).toBe(`send: ${text}`);
  });

  test("forwards calls through the daemon-injected runtime with the active parent id", async () => {
    const execute = mock(async () => ({ output: "ok", isError: false }));
    const signal = new AbortController().signal;
    const result = await exo.execute(
      { action: "status" },
      { conversationId: "parent-1", subagentMaxDepth: 3, exocortex: { execute } },
      signal,
    );

    expect(result).toEqual({ output: "ok", isError: false });
    expect(execute).toHaveBeenCalledWith({ action: "status" }, "parent-1", signal, 3);
  });
});

describe("native exo daemon runtime", () => {
  test("spawns detached subagents directly and notifies their parent", async () => {
    const parentId = id("parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    let resolveTurn!: (outcome: ReturnType<typeof successfulOutcome>) => void;
    const runTurn = mock(() => new Promise<ReturnType<typeof successfulOutcome>>((resolve) => {
      resolveTurn = resolve;
    }));
    const notifyParent = mock(() => {});
    const server = fakeServer();
    const runtime = createExocortexToolRuntime({
      server: server as never,
      runTurn,
      notifyParent,
      hasCredentials: () => true,
    });

    const result = await runtime.execute({ action: "send", text: "Inspect /tmp/project", max_depth: 0 }, parentId);
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.output);
    const childId = payload.conversation_id as string;
    conversationIds.push(childId);

    expect(payload).toMatchObject({ status: "running", detached: true, created: true, max_depth: 0, notify_parent: parentId });
    expect(getSummary(childId)?.folderId).toBe(findTopLevelFolderByName("subagents")?.id);
    expect(getSummary(parentId)?.subagentCount).toBe(1);
    expect(runTurn).toHaveBeenCalledWith(childId, "Inspect /tmp/project", 0);
    expect(server.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation_updated",
      summary: expect.objectContaining({ id: parentId, subagentCount: 1 }),
    }));

    resolveTurn(successfulOutcome("child result"));
    await Promise.resolve();
    expect(getSummary(parentId)?.subagentCount).toBe(0);
    expect(notifyParent).toHaveBeenCalledWith(parentId, childId, "Inspect /tmp/project", expect.objectContaining({ ok: true }));
  });

  test("can wait for a child result and queues recursive sends to the active parent", async () => {
    const parentId = id("wait-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome("waited result"),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const waited = await runtime.execute({ action: "send", text: "Wait for this", mode: "wait", max_depth: 0 }, parentId);
    expect(waited).toMatchObject({ isError: false });
    expect(waited.output).toContain("waited result");
    const match = waited.output.match(/exo:([^\s]+)/);
    expect(match?.[1]).toBeTruthy();
    if (match?.[1]) conversationIds.push(match[1]);

    const queued = await runtime.execute({ action: "send", conversation_id: parentId, text: "follow up", max_depth: 0 }, parentId);
    expect(queued.isError).toBe(false);
    expect(getQueuedMessages(parentId)).toEqual([expect.objectContaining({ text: "follow up", timing: "next-turn", subagentMaxDepth: 0 })]);
  });

  test("requires and monotonically decreases the nested subagent depth budget", async () => {
    const parentId = id("depth-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    const runTurn = mock(async () => successfulOutcome("bounded"));
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn,
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const missing = await runtime.execute({ action: "send", text: "missing" }, parentId);
    expect(missing).toMatchObject({ isError: true });
    expect(missing.output).toContain("max_depth is required");

    const tooDeep = await runtime.execute(
      { action: "send", text: "too deep", max_depth: 2, mode: "wait" },
      parentId,
      undefined,
      2,
    );
    expect(tooDeep).toMatchObject({ isError: true });
    expect(tooDeep.output).toContain("child max_depth must be between 0 and 1");

    const allowed = await runtime.execute(
      { action: "send", text: "allowed", max_depth: 1, mode: "wait" },
      parentId,
      undefined,
      2,
    );
    expect(allowed).toMatchObject({ isError: false });
    const childId = allowed.output.match(/exo:([^\s]+)/)?.[1];
    expect(childId).toBeTruthy();
    if (childId) conversationIds.push(childId);
    expect(runTurn).toHaveBeenLastCalledWith(childId, "allowed", 1);

    const missingQueueDepth = await runtime.execute({
      action: "queue",
      conversation_id: parentId,
      text: "missing queue depth",
    }, parentId);
    expect(missingQueueDepth).toMatchObject({ isError: true });
    expect(missingQueueDepth.output).toContain("max_depth is required");

    const exhausted = await runtime.execute(
      { action: "queue", conversation_id: parentId, text: "nope", max_depth: 0 },
      parentId,
      undefined,
      0,
    );
    expect(exhausted).toMatchObject({ isError: true });
    expect(exhausted.output).toContain("cannot spawn or queue");
  });

  test("caps concurrent native subagents per parent before creating another conversation", async () => {
    const parentId = id("capacity-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    for (let index = 0; index < 8; index++) setSubagentActive(parentId, `active-${index}`, true);
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const result = await runtime.execute({ action: "send", text: "overflow", max_depth: 0 }, parentId);
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("already has 8 active subagents");
  });

  test("caps active native subagents daemon-wide", async () => {
    const parentId = id("global-capacity-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    for (let index = 0; index < 32; index++) {
      setSubagentActive(`other-parent-${Math.floor(index / 8)}`, `global-active-${index}`, true);
    }
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const result = await runtime.execute({ action: "send", text: "overflow", max_depth: 0 }, parentId);
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("already has 32 active native subagents");
  });

  test("discovers lower-frequency commands only on demand", async () => {
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const listed = JSON.parse((await runtime.execute({ action: "commands" }, undefined)).output);
    expect(listed.commands.map((command: { name: string }) => command.name)).toEqual([
      "folder", "mark", "pin", "reorder", "rename", "delete", "llm", "clone", "system_prompt", "stats", "status",
    ]);

    const help = JSON.parse((await runtime.execute({
      action: "commands",
      command: "help",
      args: { command: "folder" },
    }, undefined)).output);
    expect(help).toMatchObject({
      command: "folder",
      input_schema: {
        type: "object",
        properties: { operation: { type: "string", enum: expect.arrayContaining(["ls", "move"]) } },
        required: ["operation"],
        additionalProperties: false,
      },
      examples: expect.any(Array),
    });
  });

  test("manages conversations, jobs, history, and folders without IPC", async () => {
    const parentId = id("manage-parent");
    const childId = id("manage-child");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    createWithInitialUserMessage(
      childId,
      DEFAULT_PROVIDER_ID,
      DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID],
      "child",
      undefined,
      false,
      { text: "original task", startedAt: Date.now() },
    );
    const server = fakeServer();
    const runtime = createExocortexToolRuntime({
      server: server as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    expect((await runtime.execute({ action: "commands", command: "rename", args: { conversation_id: childId, title: "renamed child" } }, parentId)).isError).toBe(false);
    expect(getSummary(childId)?.title).toBe("renamed child");
    expect((await runtime.execute({ action: "queue", conversation_id: childId, text: "next task", timing: "message-end", max_depth: 0 }, parentId)).isError).toBe(false);

    const info = JSON.parse((await runtime.execute({ action: "info", conversation_id: childId }, parentId)).output);
    expect(info).toMatchObject({ conversation_id: childId, title: "renamed child" });
    expect(info.queued_messages).toEqual([expect.objectContaining({ text: "next task", timing: "message-end", max_depth: 0 })]);
    expect((await runtime.execute({ action: "history", conversation_id: childId }, parentId)).output).toContain("original task");
    expect(JSON.parse((await runtime.execute({ action: "list", query: childId }, parentId)).output).conversations).toEqual([
      expect.objectContaining({ id: childId }),
    ]);

    setSubagentActive(parentId, childId, true);
    setSubagentActive(parentId, childId, false);
    const active = new AbortController();
    setActiveJob(childId, active, Date.now());
    expect(JSON.parse((await runtime.execute({ action: "jobs" }, parentId)).output).jobs).toEqual([
      expect.objectContaining({ id: childId, status: "running" }),
    ]);
    expect((await runtime.execute({ action: "abort", conversation_id: childId }, parentId)).isError).toBe(false);
    expect(active.signal.aborted).toBe(true);
    clearActiveJob(childId);

    const folderName = `native-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mkdir = JSON.parse((await runtime.execute({ action: "commands", command: "folder", args: { operation: "mkdir", path: `${folderName}/nested` } }, parentId)).output);
    folderIds.push(...mkdir.created.map((folder: { id: string }) => folder.id));
    expect(mkdir.created).toHaveLength(2);
    expect((await runtime.execute({ action: "commands", command: "folder", args: { operation: "pin", path: folderName } }, parentId)).isError).toBe(false);
    expect(listSidebarState().folders.find(folder => folder.id === mkdir.created[0].id)?.pinned).toBe(true);
    expect((await runtime.execute({ action: "commands", command: "folder", args: { operation: "move", sources: [childId], destination: `${folderName}/nested` } }, parentId)).isError).toBe(false);
    const listing = JSON.parse((await runtime.execute({ action: "commands", command: "folder", args: { operation: "ls", path: `${folderName}/nested` } }, parentId)).output);
    expect(listing.conversations).toEqual([expect.objectContaining({ id: childId })]);
    const tree = JSON.parse((await runtime.execute({ action: "commands", command: "folder", args: { operation: "tree", path: folderName } }, parentId)).output);
    expect(tree.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: childId, type: "conversation" })]));
    const renamedFolderName = `${folderName}-renamed`;
    expect((await runtime.execute({ action: "commands", command: "folder", args: { operation: "rename", path: folderName, name: renamedFolderName } }, parentId)).isError).toBe(false);

    const removed = await runtime.execute({ action: "commands", command: "folder", args: { operation: "remove", path: renamedFolderName } }, parentId);
    expect(removed.isError).toBe(false);
    expect(getSummary(childId)).toBeNull();
    conversationIds.splice(conversationIds.indexOf(childId), 1);
    folderIds.length = 0;
    expect(server.broadcast).toHaveBeenCalled();
  });

  test("bounds and paginates conversation listings and history", async () => {
    const prefix = `bounded-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const firstId = id("bounded-first");
    const secondId = id("bounded-second");
    create(firstId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], `${prefix} first`);
    create(secondId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], `${prefix} second`);
    const conversation = get(secondId)!;
    conversation.messages.push(
      { role: "user", content: "oldest", metadata: null },
      { role: "assistant", content: "middle", metadata: null },
      { role: "user", content: "newest", metadata: null },
    );
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const firstPage = JSON.parse((await runtime.execute({ action: "list", query: prefix, limit: 1 }, firstId)).output);
    expect(firstPage).toMatchObject({ total: 2, returned: 1, offset: 0, limit: 1, truncated: true, next_offset: 1 });
    const secondPage = JSON.parse((await runtime.execute({ action: "list", query: prefix, limit: 1, offset: 1 }, firstId)).output);
    expect(secondPage).toMatchObject({ total: 2, returned: 1, offset: 1, limit: 1, truncated: true, next_offset: null });
    expect(secondPage.conversations[0].id).not.toBe(firstPage.conversations[0].id);

    const newest = JSON.parse((await runtime.execute({ action: "history", conversation_id: secondId, limit: 1 }, firstId)).output);
    expect(newest).toMatchObject({ total_entries: 3, returned: 1, offset: 0, limit: 1, truncated: true, has_older: true });
    expect(newest.history).toContain("newest");
    const previous = JSON.parse((await runtime.execute({ action: "history", conversation_id: secondId, limit: 1, offset: 1 }, firstId)).output);
    expect(previous.history).toContain("middle");
  });

  test("runs one-shot LLM calls through the discovered command while retaining the legacy alias", async () => {
    const runCompletion = mock(async () => ({ text: "one-shot result" }));
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
      runCompletion,
    });

    const result = await runtime.execute({
      action: "commands",
      command: "llm",
      args: { text: "question", system: "be terse", max_tokens: 123 },
    }, undefined);
    expect(result).toEqual({ output: "one-shot result", isError: false });
    expect(runCompletion).toHaveBeenCalledWith("be terse", "question", expect.objectContaining({ maxTokens: 123, tracking: { source: "llm_complete" } }));

    const legacy = await runtime.execute({ action: "llm", text: "legacy" }, undefined);
    expect(legacy.isError).toBe(false);
  });

  test("runs conversation metadata, clone, system-prompt, and stats commands", async () => {
    const parentId = id("command-parent");
    const siblingId = id("command-sibling");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    create(siblingId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "sibling");
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    expect((await runtime.execute({ action: "commands", command: "mark", args: { marked: true } }, parentId)).isError).toBe(false);
    expect(getSummary(parentId)?.marked).toBe(true);
    expect((await runtime.execute({ action: "commands", command: "pin", args: { pinned: true } }, parentId)).isError).toBe(false);
    expect(getSummary(parentId)?.pinned).toBe(true);
    await runtime.execute({ action: "commands", command: "pin", args: { pinned: false } }, parentId);

    const siblings = listSidebarState().conversations.filter(conversation => !conversation.pinned && (conversation.folderId ?? null) === null);
    const parentIndex = siblings.findIndex(conversation => conversation.id === parentId);
    const direction = parentIndex > 0 ? "up" : "down";
    const reordered = await runtime.execute({ action: "commands", command: "reorder", args: { target: parentId, direction } }, parentId);
    expect(reordered.isError).toBe(false);

    const clone = JSON.parse((await runtime.execute({ action: "commands", command: "clone", args: { conversation_id: siblingId } }, parentId)).output);
    conversationIds.push(clone.conversation_id);
    expect(getSummary(clone.conversation_id)?.title).toContain("📋");

    const systemPrompt = await runtime.execute({ action: "commands", command: "system_prompt" }, parentId);
    expect(systemPrompt.output).toContain(`- Exocortex conversation ID: ${parentId}`);

    const stats = JSON.parse((await runtime.execute({ action: "commands", command: "stats" }, parentId)).output);
    expect(stats).toMatchObject({
      usage_by_provider: expect.any(Object),
      token_stats: expect.objectContaining({ today: expect.any(Object), lifetime: expect.any(Object) }),
      conversation: expect.objectContaining({ id: parentId }),
    });

    const status = JSON.parse((await runtime.execute({ action: "commands", command: "status" }, parentId)).output);
    expect(status).toMatchObject({ status: "ok", instance: "current", conversations: expect.any(Number) });

    const victimId = id("command-delete");
    create(victimId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "delete me");
    const deleted = await runtime.execute({
      action: "commands",
      command: "delete",
      args: { conversation_id: victimId },
    }, parentId);
    expect(deleted).toMatchObject({ isError: false });
    expect(getSummary(victimId)).toBeNull();
  });
});
