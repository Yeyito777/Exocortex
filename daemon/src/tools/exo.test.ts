import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { configDir } from "@exocortex/shared/paths";
import { createExocortexToolRuntime } from "../exocortex-tool-runtime";
import {
  clearActiveJob,
  create,
  createFolder,
  createWithInitialUserMessage,
  deleteFolder,
  findTopLevelFolderByName,
  get,
  getEffectiveSystemInstructions,
  getFolderInstructions,
  getQueuedMessages,
  getSummary,
  getSystemInstructions,
  listSidebarState,
  remove,
  setActiveJob,
} from "../conversations";
import { resetConversationActivityForTest, setBackgroundTaskActive, setChronoTaskActive, setSubagentActive } from "../conversation-activity";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID } from "../messages";
import { EXO_ACTIONS, exo } from "./exo";
import { buildSystemPrompt, getUserAddendum, setUserAddendum } from "../system";
import {
  listExternalNotificationSubscriptions,
  registerExternalNotificationSource,
  resetExternalNotificationsForTest,
} from "../external-notifications";

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
    sendHistoryUpdatedToSubscribers: mock(() => {}),
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
  resetExternalNotificationsForTest();
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
      "send", "list", "jobs", "tasks", "info", "history", "abort", "queue", "commands",
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
    expect(schema).toContain('"title"');
    expect(schema).toContain("Short title of about three words");
    expect(schema).toContain("max_depth");
    expect(schema).toContain("Maximum number of additional subagent generations permitted");
    expect(schema).toContain("not a target. Use 0 unless the target clearly needs to delegate");
    expect(exo.description).toContain("Transcription and cross-instance targeting are intentionally excluded");
    expect(exo.systemHint).toBe([
      "Use the native `exo` tool for the current daemon and its subagents.",
      "Default to doing the work yourself; use subagents only for multiple substantial, independent workstreams that can run concurrently, or for a genuinely hard problem where an independent second analysis is likely to materially improve the result—not merely to offload routine work.",
      "When an OpenAI subagent is otherwise warranted, omit `model` for the newest default (currently gpt-5.6-sol), use gpt-5.6-terra or gpt-5.6-luna for lighter/grunt work that doesn't require intelligence at all, and use older generations only when requested or required.",
      "Starting a subagent requires a short title of about three words; it becomes the child conversation title and identifies the task in the parent UI.",
      "Set max_depth=0 unless a subagent clearly needs to delegate further.",
      "When asked to manage external notification subscriptions, use action=commands with command=notifications; it can discover sources and defaults subscription targets to the active conversation.",
      "Subagents start in the daemon's working directory, so include the target absolute directory in tasks when relevant.",
    ].join("\n"));
  });

  test("preserves long task text in summaries so the TUI can wrap it", () => {
    const text = `${"Inspect every relevant file and report the exact behavior. ".repeat(5)}TAIL_SENTINEL`;

    expect(text.length).toBeGreaterThan(180);
    expect(exo.summarize({ action: "send", text, title: "Inspect relevant files" }).detail)
      .toBe(`send: ${text} --title Inspect relevant files`);
  });

  test("includes supplied arguments in summaries", () => {
    expect(exo.summarize({
      action: "send",
      text: "Inspect the renderer",
      title: "Inspect renderer flow",
      conversation_id: "child-1",
      max_depth: 2,
      provider: "openai",
      model: "gpt-5.6-terra",
      mode: "detach",
      notify_parent: false,
      full: true,
    }).detail).toBe(
      "send: Inspect the renderer --title Inspect renderer flow --conversation_id child-1 --max_depth 2 --provider openai "
      + "--model gpt-5.6-terra --mode detach --notify_parent false --full",
    );
    expect(exo.summarize({
      action: "history",
      conversation_id: "child-1",
      limit: 20,
      offset: 5,
      full: true,
    }).detail).toBe("history: child-1 --limit 20 --offset 5 --full");
    expect(exo.summarize({
      action: "commands",
      command: "help",
      args: { command: "rename", verbose: false },
    }).detail).toBe('commands: help --args {"command":"rename","verbose":false}');
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
  test("lists active tasks for the current, selected, or all conversations", async () => {
    const parentId = id("task-parent");
    const otherId = id("task-other");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "Task parent");
    create(otherId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "Task other");
    setSubagentActive(parentId, "child-task", true, { title: "Inspect child", startedAt: 100 });
    setBackgroundTaskActive(parentId, "bash:42:one", true, {
      title: "bun test daemon",
      startedAt: 200,
      toolName: "bash",
      pid: 42,
      backgroundedAt: 250,
      outputPath: "/tmp/bash-42.tmp",
      cwd: "/workspace",
    });
    setBackgroundTaskActive(otherId, "bash:43:two", true, {
      title: "bun test tui",
      startedAt: 300,
      toolName: "bash",
      pid: 43,
      backgroundedAt: 350,
      outputPath: "/tmp/bash-43.tmp",
    });
    setChronoTaskActive(parentId, "chrono:wake:one", true, {
      title: "Wake for inbox",
      startedAt: 400,
      dueAt: 4_000,
      chronoMode: "wake",
    });
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      hasCredentials: () => true,
    });

    const own = JSON.parse((await runtime.execute({ action: "tasks", kind: "background" }, parentId)).output);
    expect(own).toMatchObject({ scope: "conversation", owner_conversation_id: parentId, kind: "background", total: 1 });
    expect(own.tasks[0]).toMatchObject({
      id: "bash:42:one",
      kind: "background",
      status: "running",
      owner_conversation_id: parentId,
      owner_title: "Task parent",
      tool: "bash",
      pid: 42,
      output_path: "/tmp/bash-42.tmp",
    });

    const selected = JSON.parse((await runtime.execute({ action: "tasks", conversation_id: otherId }, parentId)).output);
    expect(selected.tasks.map((task: { id: string }) => task.id)).toEqual(["bash:43:two"]);

    const all = JSON.parse((await runtime.execute({ action: "tasks", scope: "all", query: "bun test", limit: 10 }, parentId)).output);
    expect(all).toMatchObject({ scope: "all", total: 2, returned: 2 });
    expect(all.tasks.map((task: { id: string }) => task.id)).toEqual(["bash:43:two", "bash:42:one"]);

    const chrono = JSON.parse((await runtime.execute({ action: "tasks", kind: "chrono" }, parentId)).output);
    expect(chrono).toMatchObject({ scope: "conversation", kind: "chrono", total: 1 });
    expect(chrono.tasks[0]).toMatchObject({
      id: "chrono:wake:one",
      kind: "chrono",
      due_at: 4_000,
      chrono_mode: "wake",
    });
  });

  test("discovers and stops exact managed background tasks through the command registry", async () => {
    const parentId = id("task-stop-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "Task parent");
    const stop = mock(() => true);
    setBackgroundTaskActive(parentId, "bash:44:stop", true, {
      title: "sleep 30",
      startedAt: 200,
      toolName: "bash",
      pid: 44,
      backgroundedAt: 250,
      outputPath: "/tmp/bash-44.tmp",
      stop,
    });
    const server = fakeServer();
    const runtime = createExocortexToolRuntime({
      server: server as never,
      runTurn: async () => successfulOutcome(),
      hasCredentials: () => true,
    });

    const help = await runtime.execute({ action: "commands", command: "help", args: { command: "task" } }, parentId);
    expect(help.output).toContain('"stop"');
    const result = await runtime.execute({
      action: "commands",
      command: "task",
      args: { operation: "stop", task_id: "bash:44:stop" },
    }, parentId);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({ task_id: "bash:44:stop", status: "stopping" });
    expect(stop).toHaveBeenCalledWith(true);
    expect(server.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation_updated",
      summary: expect.objectContaining({ id: parentId }),
    }));
  });

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

    const result = await runtime.execute({ action: "send", text: "Inspect /tmp/project", title: "Inspect project files", max_depth: 0 }, parentId);
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.output);
    const childId = payload.conversation_id as string;
    conversationIds.push(childId);

    expect(payload).toMatchObject({ title: "Inspect project files", status: "running", detached: true, created: true, max_depth: 0, notify_parent: parentId });
    expect(getSummary(childId)?.folderId).toBe(findTopLevelFolderByName("subagents")?.id);
    expect(getSummary(childId)?.title).toBe("Inspect project files");
    expect(getSummary(parentId)?.subagentCount).toBe(1);
    expect(getSummary(parentId)?.tasks).toEqual([
      expect.objectContaining({ id: childId, kind: "subagent", title: "Inspect project files", startedAt: expect.any(Number) }),
    ]);
    expect(runTurn).toHaveBeenCalledWith(childId, "Inspect /tmp/project", 0, expect.any(Number));
    expect(server.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation_updated",
      summary: expect.objectContaining({ id: parentId, subagentCount: 1 }),
    }));

    resolveTurn(successfulOutcome("child result"));
    await Promise.resolve();
    expect(getSummary(parentId)?.subagentCount).toBe(0);
    expect(notifyParent).toHaveBeenCalledWith(parentId, childId, "Inspect /tmp/project", expect.objectContaining({ ok: true }));
  });

  test("registers durable parent notification state before starting a detached child", async () => {
    const parentId = id("durable-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "parent");
    let resolveTurn!: (outcome: ReturnType<typeof successfulOutcome>) => void;
    const runTurn = mock(() => new Promise<ReturnType<typeof successfulOutcome>>((resolve) => {
      resolveTurn = resolve;
    }));
    const beginParentNotification = mock(() => {});
    const completeParentNotification = mock(() => {});
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn,
      beginParentNotification,
      completeParentNotification,
      hasCredentials: () => true,
    });

    const result = await runtime.execute({
      action: "send",
      text: "survive restart",
      title: "Survive daemon restart",
      max_depth: 1,
    }, parentId);
    const childId = JSON.parse(result.output).conversation_id as string;
    conversationIds.push(childId);
    const startedAt = (runTurn.mock.calls[0] as unknown[])[3] as number;

    expect(beginParentNotification).toHaveBeenCalledWith(
      { convId: parentId },
      childId,
      "survive restart",
      startedAt,
      1,
    );
    expect(beginParentNotification.mock.invocationCallOrder[0]).toBeLessThan(runTurn.mock.invocationCallOrder[0]);

    const outcome = successfulOutcome("durable result");
    resolveTurn(outcome);
    await Promise.resolve();
    expect(completeParentNotification).toHaveBeenCalledWith(childId, outcome);
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

    const waited = await runtime.execute({ action: "send", text: "Wait for this", title: "Wait child result", mode: "wait", max_depth: 0 }, parentId);
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

    const missingTitle = await runtime.execute({ action: "send", text: "missing title", max_depth: 0 }, parentId);
    expect(missingTitle).toMatchObject({ isError: true });
    expect(missingTitle.output).toContain("title is required for action=send");

    const longTitle = await runtime.execute({
      action: "send",
      text: "too many title words",
      title: "one two three four five six seven",
      max_depth: 0,
    }, parentId);
    expect(longTitle).toMatchObject({ isError: true });
    expect(longTitle.output).toContain("title must be short");

    const tooDeep = await runtime.execute(
      { action: "send", text: "too deep", max_depth: 2, mode: "wait" },
      parentId,
      undefined,
      2,
    );
    expect(tooDeep).toMatchObject({ isError: true });
    expect(tooDeep.output).toContain("child max_depth must be between 0 and 1");

    const allowed = await runtime.execute(
      { action: "send", text: "allowed", title: "Allowed nested task", max_depth: 1, mode: "wait" },
      parentId,
      undefined,
      2,
    );
    expect(allowed).toMatchObject({ isError: false });
    const childId = allowed.output.match(/exo:([^\s]+)/)?.[1];
    expect(childId).toBeTruthy();
    if (childId) conversationIds.push(childId);
    expect(runTurn).toHaveBeenLastCalledWith(childId, "allowed", 1, expect.any(Number));

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

    const result = await runtime.execute({ action: "send", text: "overflow", title: "Overflow child task", max_depth: 0 }, parentId);
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

    const result = await runtime.execute({ action: "send", text: "overflow", title: "Overflow global task", max_depth: 0 }, parentId);
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
      "folder", "mark", "pin", "reorder", "rename", "delete", "llm", "clone", "system_prompt", "instructions", "stats", "task", "status", "notifications",
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

  test("discovers notification sources and subscribes the active conversation", async () => {
    const parentId = id("notification-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "Notification parent");
    registerExternalNotificationSource({
      toolName: "discord",
      id: "account:paramount:notifications",
      label: "Paramount · DMs and @mentions",
    });
    const runtime = createExocortexToolRuntime({
      server: fakeServer() as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const sources = JSON.parse((await runtime.execute({
      action: "commands",
      command: "notifications",
      args: { operation: "sources", tool: "discord" },
    }, parentId)).output);
    expect(sources.sources).toEqual([
      expect.objectContaining({ tool: "discord", source_id: "account:paramount:notifications" }),
    ]);

    const result = JSON.parse((await runtime.execute({
      action: "commands",
      command: "notifications",
      args: {
        operation: "subscribe",
        tool: "discord",
        source_id: "account:paramount:notifications",
        delivery: "wake",
      },
    }, parentId)).output);
    expect(result).toMatchObject({ subscribed: true, conversation_id: parentId, delivery: "wake" });
    expect(listExternalNotificationSubscriptions({ convId: parentId })).toEqual([
      expect.objectContaining({ toolName: "discord", sourceId: "account:paramount:notifications" }),
    ]);

    const removed = JSON.parse((await runtime.execute({
      action: "commands",
      command: "notifications",
      args: { operation: "unsubscribe", subscription_id: result.subscription_id },
    }, parentId)).output);
    expect(removed.unsubscribed).toBe(1);
  });

  test("manages conversation, folder, and app instruction layers with revisions", async () => {
    const parentId = id("instructions-parent");
    create(parentId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "Instructions parent");
    const folder = createFolder(`instructions-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)!;
    folderIds.push(folder.id);
    const folderConvId = id("instructions-folder-child");
    create(folderConvId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "Folder child", undefined, false, folder.id);
    const server = fakeServer();
    const runtime = createExocortexToolRuntime({
      server: server as never,
      runTurn: async () => successfulOutcome(),
      notifyParent: () => {},
      hasCredentials: () => true,
    });

    const help = JSON.parse((await runtime.execute({
      action: "commands",
      command: "help",
      args: { command: "instructions" },
    }, parentId)).output);
    expect(help).toMatchObject({
      command: "instructions",
      description: "View or change persistent instructions. Only use when the user explicitly asks.",
      input_schema: {
        properties: {
          operation: { enum: ["get", "set", "clear"] },
          scope: { enum: ["conversation", "folder", "app"] },
        },
        required: ["operation", "scope"],
        additionalProperties: false,
      },
    });

    const conversationGet = JSON.parse((await runtime.execute({
      action: "commands",
      command: "instructions",
      args: { operation: "get", scope: "conversation" },
    }, parentId)).output);
    expect(conversationGet).toMatchObject({ scope: "conversation", target: { conversation_id: parentId }, text: "", affected_conversations: 1 });

    const conversationSet = await runtime.execute({
      action: "commands",
      command: "instructions",
      args: {
        operation: "set",
        scope: "conversation",
        text: "Be precise.",
        expected_revision: conversationGet.revision,
      },
    }, parentId);
    expect(conversationSet.isError).toBe(false);
    expect(getSystemInstructions(parentId)).toBe("Be precise.");
    expect(server.broadcast).toHaveBeenCalledWith({ type: "system_instructions_updated", convId: parentId, text: "Be precise." });
    expect(server.sendHistoryUpdatedToSubscribers).toHaveBeenCalled();

    const stale = await runtime.execute({
      action: "commands",
      command: "instructions",
      args: { operation: "clear", scope: "conversation", expected_revision: conversationGet.revision },
    }, parentId);
    expect(stale.isError).toBe(true);
    expect(stale.output).toContain("Instructions changed since they were read");

    const folderGet = JSON.parse((await runtime.execute({
      action: "commands",
      command: "instructions",
      args: { operation: "get", scope: "folder", folder_id: folder.id },
    }, parentId)).output);
    expect(folderGet).toMatchObject({ target: { folder_id: folder.id }, affected_conversations: 1 });
    server.sendHistoryUpdatedToSubscribers.mockClear();
    const folderSet = await runtime.execute({
      action: "commands",
      command: "instructions",
      args: {
        operation: "set",
        scope: "folder",
        folder_id: folder.id,
        text: "Use folder rules.",
        expected_revision: folderGet.revision,
      },
    }, parentId);
    expect(folderSet.isError).toBe(false);
    expect(getFolderInstructions(folder.id)).toBe("Use folder rules.");
    expect(getEffectiveSystemInstructions(folderConvId)).toContain("Use folder rules.");
    expect(server.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "folder_instructions_updated", folderId: folder.id }));
    expect(server.sendHistoryUpdatedToSubscribers).toHaveBeenCalledWith(folderConvId, expect.any(Object), expect.any(Object));

    const originalAppInstructions = getUserAddendum();
    try {
      const appGet = JSON.parse((await runtime.execute({
        action: "commands",
        command: "instructions",
        args: { operation: "get", scope: "app" },
      }, parentId)).output);
      const appText = `App instruction ${Date.now()}`;
      const appSet = await runtime.execute({
        action: "commands",
        command: "instructions",
        args: {
          operation: "set",
          scope: "app",
          text: appText,
          expected_revision: appGet.revision,
        },
      }, parentId);
      expect(appSet.isError).toBe(false);
      expect(getUserAddendum()).toBe(appText);
      expect(buildSystemPrompt()).toContain(appText);
      expect(readFileSync(join(configDir(), "system.md"), "utf8")).toBe(`${appText}\n`);

      const externalText = `External app instruction ${Date.now()}`;
      writeFileSync(join(configDir(), "system.md"), `${externalText}\n`);
      const staleAppSet = await runtime.execute({
        action: "commands",
        command: "instructions",
        args: {
          operation: "set",
          scope: "app",
          text: "Should not overwrite external edit",
          expected_revision: JSON.parse(appSet.output).revision,
        },
      }, parentId);
      expect(staleAppSet.isError).toBe(true);
      const freshAppGet = JSON.parse((await runtime.execute({
        action: "commands",
        command: "instructions",
        args: { operation: "get", scope: "app" },
      }, parentId)).output);
      expect(freshAppGet.text).toBe(externalText);
    } finally {
      setUserAddendum(originalAppInstructions);
    }
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
