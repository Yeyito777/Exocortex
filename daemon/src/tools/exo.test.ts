import { afterEach, describe, expect, mock, test } from "bun:test";
import { createExocortexToolRuntime } from "../exocortex-tool-runtime";
import {
  clearActiveJob,
  create,
  createWithInitialUserMessage,
  deleteFolder,
  findTopLevelFolderByName,
  getQueuedMessages,
  getSummary,
  listSidebarState,
  remove,
  setActiveJob,
} from "../conversations";
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
      "send", "list", "jobs", "info", "history", "delete", "abort", "queue", "rename", "status", "commands",
    ]);
    expect(EXO_ACTIONS).not.toContain("transcribe" as never);
    expect(EXO_ACTIONS).not.toContain("llm" as never);
    expect(EXO_ACTIONS).not.toContain("folder_mkdir" as never);
    const schema = JSON.stringify(exo.inputSchema);
    expect(schema).not.toContain("folder_mkdir");
    expect(schema).not.toContain("system_prompt");
    expect(exo.description).toContain("Transcription and cross-instance targeting are intentionally excluded");
    expect(exo.systemHint).toContain("action=commands with command=ls");
    expect(exo.systemHint).toContain("external `exo` CLI through bash only when debugging or targeting another daemon");
  });

  test("forwards calls through the daemon-injected runtime with the active parent id", async () => {
    const execute = mock(async () => ({ output: "ok", isError: false }));
    const signal = new AbortController().signal;
    const result = await exo.execute(
      { action: "status" },
      { conversationId: "parent-1", exocortex: { execute } },
      signal,
    );

    expect(result).toEqual({ output: "ok", isError: false });
    expect(execute).toHaveBeenCalledWith({ action: "status" }, "parent-1", signal);
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

    const result = await runtime.execute({ action: "send", text: "Inspect /tmp/project" }, parentId);
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.output);
    const childId = payload.conversation_id as string;
    conversationIds.push(childId);

    expect(payload).toMatchObject({ status: "running", detached: true, created: true, notify_parent: parentId });
    expect(getSummary(childId)?.folderId).toBe(findTopLevelFolderByName("subagents")?.id);
    expect(getSummary(parentId)?.subagentCount).toBe(1);
    expect(runTurn).toHaveBeenCalledWith(childId, "Inspect /tmp/project");
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

    const waited = await runtime.execute({ action: "send", text: "Wait for this", mode: "wait" }, parentId);
    expect(waited).toMatchObject({ isError: false });
    expect(waited.output).toContain("waited result");
    const match = waited.output.match(/exo:([^\s]+)/);
    expect(match?.[1]).toBeTruthy();
    if (match?.[1]) conversationIds.push(match[1]);

    const queued = await runtime.execute({ action: "send", conversation_id: parentId, text: "follow up" }, parentId);
    expect(queued.isError).toBe(false);
    expect(getQueuedMessages(parentId)).toEqual([expect.objectContaining({ text: "follow up", timing: "next-turn" })]);
  });

  test("discovers lower-frequency commands only on demand", async () => {
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const listed = JSON.parse((await runtime.execute({ action: "commands", command: "ls" }, undefined)).output);
    expect(listed.commands.map((command: { name: string }) => command.name)).toEqual([
      "folder", "mark", "pin", "reorder", "llm", "clone", "system_prompt", "stats",
    ]);

    const help = JSON.parse((await runtime.execute({
      action: "commands",
      command: "help",
      args: { command: "folder" },
    }, undefined)).output);
    expect(help).toMatchObject({ command: "folder", args: expect.objectContaining({ operation: expect.any(String) }) });
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

    expect((await runtime.execute({ action: "rename", conversation_id: childId, title: "renamed child" }, parentId)).isError).toBe(false);
    expect(getSummary(childId)?.title).toBe("renamed child");
    expect((await runtime.execute({ action: "queue", conversation_id: childId, text: "next task", timing: "message-end" }, parentId)).isError).toBe(false);

    const info = JSON.parse((await runtime.execute({ action: "info", conversation_id: childId }, parentId)).output);
    expect(info).toMatchObject({ conversation_id: childId, title: "renamed child" });
    expect(info.queued_messages).toEqual([expect.objectContaining({ text: "next task", timing: "message-end" })]);
    expect((await runtime.execute({ action: "history", conversation_id: childId }, parentId)).output).toContain("original task");
    expect(JSON.parse((await runtime.execute({ action: "list" }, parentId)).output)).toEqual(expect.arrayContaining([expect.objectContaining({ id: childId })]));

    const active = new AbortController();
    setActiveJob(childId, active, Date.now());
    expect(JSON.parse((await runtime.execute({ action: "jobs" }, parentId)).output)).toEqual(expect.arrayContaining([expect.objectContaining({ id: childId, status: "running" })]));
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
  });
});
