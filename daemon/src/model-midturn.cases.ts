import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { applyAllPendingModels, clearActiveJob, create, get, getPendingModel, getSummary, loadFromDisk, remove, setActiveJob, setModel, setPendingModel, setPendingModelAppliedListener } from "./conversations";
import { loadPendingModelSelectionsJson, savePendingModelSelectionsJson } from "./persistence";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import { broadcastConversationUpdated } from "./conversation-events";
import type { streamMessage } from "./api";
import { DaemonClient } from "../../tui/src/client";
import { createInitialState, type RenderState } from "../../tui/src/state";
import { handleEvent } from "../../tui/src/events";
import { focusedConversation } from "../../tui/src/state";

// A model switch asked for while a turn streams waits for that turn to end and
// takes effect before the next one starts. It is held by the daemon, so every
// attached client sees it and it survives reconnects and restarts.

const IDS: string[] = [];
const DIRS: string[] = [];

function mkId(suffix: string): string {
  const id = `model-midturn-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

function finalAnswer(text: string) {
  return {
    text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [],
    transcriptMessages: [{ role: "assistant" as const, content: [{ type: "text" as const, text }] }],
  };
}

async function connectTui(socket: string): Promise<{ state: RenderState; client: DaemonClient }> {
  const state = createInitialState();
  const client: DaemonClient = new DaemonClient(event => handleEvent(event, state, client), socket);
  await client.connect();
  return { state, client };
}

async function harness(streamMessageFn: typeof streamMessage) {
  const dir = mkdtempSync(join(tmpdir(), "exo-model-midturn-"));
  DIRS.push(dir);
  const socket = join(dir, "daemon.sock");
  const callbacks: OrchestrationCallbacks = { onHeaders() {}, onComplete() {}, streamMessageFn };
  let handler: ReturnType<typeof createHandler> | null = null;
  const server: DaemonServer = new DaemonServer(socket, (client, cmd) => {
    if (cmd.type === "send_message") {
      void orchestrateSendMessage(server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt, callbacks, cmd.images, { subagentMaxDepth: null });
      return;
    }
    void handler?.(client, cmd);
  });
  handler = createHandler(server);
  setPendingModelAppliedListener(convId => broadcastConversationUpdated(server, convId));
  await server.start();
  const tuis: DaemonClient[] = [];
  return {
    socket,
    tui: async () => {
      const tui = await connectTui(socket);
      tuis.push(tui.client);
      return tui;
    },
    close: async () => {
      setPendingModelAppliedListener(null);
      for (const client of tuis) client.disconnect();
      await server.stop();
    },
  };
}

/** A stub provider that records each turn's model and holds the first turn open. */
function stubStream() {
  const models: string[] = [];
  const releaseFirst = gate();
  const answering = gate();
  const stream = (async (_provider, _messages, model, cb) => {
    models.push(String(model));
    cb.onBlockStart?.("text");
    cb.onText("working");
    if (models.length === 1) {
      answering.open();
      await releaseFirst.promise;
    }
    return finalAnswer("done");
  }) as typeof streamMessage;
  return { models, releaseFirst, answering, stream };
}

afterEach(() => {
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("model switches queued mid-turn", () => {
  test("wait for the turn, show in every client, the last one counts, and apply before the next turn", async () => {
    const stub = stubStream();
    const h = await harness(stub.stream);
    const convId = mkId("e2e");
    create(convId, "openai", "gpt-5.5", undefined, "high");
    try {
      const a = await h.tui();
      a.state.convId = convId;
      a.client.loadConversation(convId);
      a.client.sendMessage(convId, "first", Date.now());
      await stub.answering.promise;

      // Mid-turn: queued, acknowledged, no refusal.
      a.client.setModel(convId, "openai", "gpt-5.4", "low");
      await waitFor(() => getPendingModel(convId)?.model === "gpt-5.4", "queued switch");
      a.client.setModel(convId, "openai", "gpt-5.4", "medium");
      await waitFor(() => getPendingModel(convId)?.effort === "medium", "replaced switch");
      expect(get(convId)!.model).toBe("gpt-5.5");
      expect(loadPendingModelSelectionsJson()[convId]).toEqual({ provider: "openai", model: "gpt-5.4", effort: "medium" });
      await waitFor(() => focusedConversation(a.state)?.pendingModel?.effort === "medium", "first client sees it");
      expect(a.state.messages.some(message => message.role === "system" && /streaming/i.test(message.text))).toBe(false);

      // A client that connects (or reconnects) now sees it too.
      const b = await h.tui();
      b.client.listConversations();
      await waitFor(() => b.state.sidebar.conversations.find(conv => conv.id === convId)?.pendingModel?.model === "gpt-5.4", "second client sees it");

      stub.releaseFirst.open();
      await waitFor(() => get(convId)!.model === "gpt-5.4", "switch at turn end");
      expect(get(convId)!.effort).toBe("medium");
      expect(getPendingModel(convId)).toBeNull();
      expect(loadPendingModelSelectionsJson()[convId]).toBeUndefined();
      await waitFor(() => a.state.model === "gpt-5.4" && focusedConversation(a.state)?.pendingModel === undefined, "client follows");
      expect(stub.models).toEqual(["gpt-5.5"]);

      a.client.sendMessage(convId, "second", Date.now());
      await waitFor(() => stub.models.length === 2, "second turn");
      expect(stub.models[1]).toBe("gpt-5.4");
    } finally {
      stub.releaseFirst.open();
      await h.close();
    }
  });

  test("back to the running model clears it; its effort applies at once", async () => {
    const stub = stubStream();
    const h = await harness(stub.stream);
    const convId = mkId("clear");
    create(convId, "openai", "gpt-5.5", undefined, "high");
    try {
      const a = await h.tui();
      a.state.convId = convId;
      a.client.loadConversation(convId);
      a.client.sendMessage(convId, "first", Date.now());
      await stub.answering.promise;
      a.client.setModel(convId, "openai", "gpt-5.4", "high");
      await waitFor(() => getPendingModel(convId) !== null, "queued");
      a.client.setModel(convId, "openai", "gpt-5.5", "low");
      await waitFor(() => getPendingModel(convId) === null, "cleared");
      expect(get(convId)!.effort).toBe("low");
      expect(loadPendingModelSelectionsJson()[convId]).toBeUndefined();
      await waitFor(() => focusedConversation(a.state)?.pendingModel === undefined && a.state.effort === "low", "client sees it cleared");
    } finally {
      stub.releaseFirst.open();
      await h.close();
    }
  });

  test("an effort set while a model waits goes with that model", async () => {
    const stub = stubStream();
    const h = await harness(stub.stream);
    const convId = mkId("effort");
    create(convId, "openai", "gpt-5.5", undefined, "high");
    try {
      const a = await h.tui();
      a.client.sendMessage(convId, "first", Date.now());
      await stub.answering.promise;
      a.client.setModel(convId, "openai", "gpt-5.4", "high");
      await waitFor(() => getPendingModel(convId) !== null, "queued");
      a.client.setEffort(convId, "low");
      await waitFor(() => getPendingModel(convId)?.effort === "low", "effort follows the queued model");
      expect(get(convId)!.effort).toBe("high");
    } finally {
      stub.releaseFirst.open();
      await h.close();
    }
  });

  test("a switch still waiting when the next turn starts takes effect first", async () => {
    const stub = stubStream();
    stub.releaseFirst.open();
    const h = await harness(stub.stream);
    const convId = mkId("turn-start");
    create(convId, "openai", "gpt-5.5", undefined, "high");
    try {
      // Left over (e.g. the idle hook could not load the conversation).
      setPendingModel(convId, { provider: "openai", model: "gpt-5.4", effort: "low" });
      const a = await h.tui();
      a.client.sendMessage(convId, "go", Date.now());
      await waitFor(() => stub.models.length === 1, "turn");
      expect(stub.models[0]).toBe("gpt-5.4");
      expect(getPendingModel(convId)).toBeNull();
      expect(get(convId)!.effort).toBe("low");
    } finally {
      await h.close();
    }
  });

  test("a switch queued when the daemon stopped mid-turn takes effect after it starts again", () => {
    const convId = mkId("restart");
    create(convId, "openai", "gpt-5.5", undefined, "high");
    setActiveJob(convId, new AbortController(), Date.now());
    setPendingModel(convId, { provider: "openai", model: "gpt-5.4", effort: "low" });
    expect(loadPendingModelSelectionsJson()[convId]).toEqual({ provider: "openai", model: "gpt-5.4", effort: "low" });
    // The daemon went down mid-turn: memory is gone, the queued switch is on disk.
    const onDisk = loadPendingModelSelectionsJson();
    clearActiveJob(convId);
    savePendingModelSelectionsJson(onDisk);
    expect(get(convId)!.model).toBe("gpt-5.4");
    setModel(convId, "openai", "gpt-5.5", "high", false);
    loadFromDisk();
    expect(get(convId)!.model).toBe("gpt-5.5");
    expect(getPendingModel(convId)).toEqual({ provider: "openai", model: "gpt-5.4", effort: "low" });
    expect(getSummary(convId)?.pendingModel).toEqual({ provider: "openai", model: "gpt-5.4", effort: "low" });
    applyAllPendingModels();
    expect(get(convId)!.model).toBe("gpt-5.4");
    expect(get(convId)!.effort).toBe("low");
    expect(getPendingModel(convId)).toBeNull();
    expect(loadPendingModelSelectionsJson()[convId]).toBeUndefined();
  });
});
