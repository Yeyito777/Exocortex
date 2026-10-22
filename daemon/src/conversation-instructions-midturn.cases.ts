import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { applyAllPendingSystemInstructions, clearActiveJob, create, get, getEffectiveSystemInstructions, getSystemInstructions, loadFromDisk, remove, setActiveJob, setSystemInstructions } from "./conversations";
import { loadPendingConversationInstructions, savePendingConversationInstructions } from "./persistence";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import type { streamMessage } from "./api";
import { DaemonClient } from "../../tui/src/client";
import { createInitialState, type RenderState } from "../../tui/src/state";
import { handleEvent } from "../../tui/src/events";
import { handleInstructionsModalKey, openInstructionsPicker } from "../../tui/src/instructions/controller";
import type { KeyEvent } from "../../tui/src/input";

// Conversation instructions live in history, which cannot be rewritten while a
// turn streams. A save mid-turn is accepted, read back at once, and written to
// history when the turn ends, before the next turn's request.

const IDS: string[] = [];
const DIRS: string[] = [];

function mkId(suffix: string): string {
  const id = `instructions-midturn-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/** The conversation's own instructions as stored in history (not any pending save). */
function storedInstructions(convId: string): string | null {
  const first = get(convId)?.messages[0];
  return first?.role === "system_instructions" && typeof first.content === "string" ? first.content : null;
}

async function harness(streamMessageFn: typeof streamMessage) {
  const dir = mkdtempSync(join(tmpdir(), "exo-instructions-midturn-"));
  DIRS.push(dir);
  const callbacks: OrchestrationCallbacks = { onHeaders() {}, onComplete() {}, streamMessageFn };
  let handler: ReturnType<typeof createHandler> | null = null;
  const server: DaemonServer = new DaemonServer(join(dir, "daemon.sock"), (client, cmd) => {
    if (cmd.type === "send_message") {
      void orchestrateSendMessage(server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt, callbacks, cmd.images, { subagentMaxDepth: null });
      return;
    }
    void handler?.(client, cmd);
  });
  handler = createHandler(server);
  await server.start();
  const state = createInitialState();
  const client: DaemonClient = new DaemonClient(event => handleEvent(event, state, client), join(dir, "daemon.sock"));
  await client.connect();
  const press = (...keys: Array<string | KeyEvent>) => {
    for (const key of keys) {
      const events: KeyEvent[] = typeof key === "string" ? [...key].map(char => ({ type: "char", char })) : [key];
      for (const event of events) expect(handleInstructionsModalKey(event, state, client).type).toBe("handled");
    }
  };
  return {
    state, client, press,
    settled: () => [...state.instructionsStore.entries.values()].every(entry => entry.saves.length === 0),
    close: async () => {
      client.disconnect();
      await server.stop();
    },
  };
}

/** Every chat notice the TUI showed: none of them may be a failed save. */
function notices(state: RenderState): string[] {
  return [...state.messages, ...state.streamingTailMessages]
    .flatMap(message => message.role === "system" ? [message.text] : []);
}

const ESC: KeyEvent = { type: "escape" };
const ENTER: KeyEvent = { type: "enter" };

afterEach(() => {
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("conversation instructions saved mid-turn", () => {
  test("are accepted without a notice, shown at once, and land before the next turn", async () => {
    const systems: string[] = [];
    const releaseFirst = gate();
    const answering = gate();
    const fakeStream = (async (_provider, _messages, _model, cb, options) => {
      systems.push(String(options?.system ?? ""));
      cb.onBlockStart?.("text");
      cb.onText("working");
      if (systems.length === 1) {
        answering.open();
        await releaseFirst.promise;
      }
      return finalAnswer("done");
    }) as typeof streamMessage;
    const h = await harness(fakeStream);
    const convId = mkId("e2e");
    create(convId, "openai", "gpt-5.5");
    expect(setSystemInstructions(convId, "Old rule.")).toBe(true);
    try {
      h.state.convId = convId;
      h.client.loadConversation(convId);
      h.client.sendMessage(convId, "first", Date.now());
      await answering.promise;

      // :wq in /instructions → Conversation while the turn streams.
      openInstructionsPicker(h.state, h.client, "conversation");
      await waitFor(() => h.state.instructionsModal?.picker?.loadReqId === null, "picker load");
      expect(h.state.instructionsModal!.picker!.texts.conversation).toBe("Old rule.");
      h.press(ENTER, "d", "d", "i", "New rule.", ESC, ":wq", ENTER);
      expect(h.state.instructionsModal).toBeNull();
      await waitFor(h.settled, "first save");

      // Saved again before the turn ends: the last one wins.
      openInstructionsPicker(h.state, h.client, "conversation");
      await waitFor(() => h.state.instructionsModal?.picker?.loadReqId === null, "picker reload");
      expect(h.state.instructionsModal!.picker!.texts.conversation).toBe("New rule.");
      h.press(ENTER, "d", "d", "i", "Newest rule.", ESC, ":wq", ENTER);
      await waitFor(h.settled, "second save");

      // The turn is still running: history is untouched, every read sees the save.
      expect(storedInstructions(convId)).toBe("Old rule.");
      expect(getSystemInstructions(convId)).toBe("Newest rule.");
      expect(getEffectiveSystemInstructions(convId)).toContain("Newest rule.");
      expect(loadPendingConversationInstructions().get(convId)).toBe("Newest rule.");
      openInstructionsPicker(h.state, h.client, "conversation");
      await waitFor(() => h.state.instructionsModal?.picker?.loadReqId === null, "picker reload mid-turn");
      expect(h.state.instructionsModal!.picker!.texts.conversation).toBe("Newest rule.");
      h.press(ESC);
      // The saves' history refresh kept the live turn on screen.
      await waitFor(() => h.state.pendingAI?.blocks.some(block => block.type === "text" && block.text === "working") === true, "live turn");

      releaseFirst.open();
      await waitFor(() => storedInstructions(convId) === "Newest rule.", "instructions to land at turn end");
      expect(loadPendingConversationInstructions().has(convId)).toBe(false);
      expect(systems[0]).toContain("Old rule.");

      h.client.sendMessage(convId, "second", Date.now());
      await waitFor(() => systems.length === 2, "second turn");
      expect(systems[1]).toContain("Newest rule.");
      expect(systems[1]).not.toContain("Old rule.");

      // Nothing flickered back, and nothing complained.
      openInstructionsPicker(h.state, h.client, "conversation");
      await waitFor(() => h.state.instructionsModal?.picker?.loadReqId === null, "picker after turn");
      expect(h.state.instructionsModal!.picker!.texts.conversation).toBe("Newest rule.");
      expect(notices(h.state).filter(text => /not saved|streaming/i.test(text))).toEqual([]);
    } finally {
      releaseFirst.open();
      await h.close();
    }
  });

  test("a save that undoes a pending one leaves nothing pending", () => {
    const convId = mkId("undo");
    create(convId, "openai", "gpt-5.5");
    setSystemInstructions(convId, "Keep.");
    setActiveJob(convId, new AbortController(), Date.now());
    setSystemInstructions(convId, "Changed.");
    expect(loadPendingConversationInstructions().get(convId)).toBe("Changed.");
    setSystemInstructions(convId, "Keep.");
    expect(loadPendingConversationInstructions().has(convId)).toBe(false);
    expect(getSystemInstructions(convId)).toBe("Keep.");
  });

  test("a clear saved mid-turn reads as none and removes them at turn end", async () => {
    const convId = mkId("clear");
    create(convId, "openai", "gpt-5.5");
    setSystemInstructions(convId, "Remove me.");
    setActiveJob(convId, new AbortController(), Date.now());
    setSystemInstructions(convId, "");
    expect(getSystemInstructions(convId)).toBeNull();
    expect(getEffectiveSystemInstructions(convId) ?? "").not.toContain("Remove me.");
    expect(storedInstructions(convId)).toBe("Remove me.");
    clearActiveJob(convId);
    await waitFor(() => storedInstructions(convId) === null, "clear to land");
    expect(get(convId)!.messages.some(message => message.role === "system_instructions")).toBe(false);
  });

  test("a save still pending when the daemon stopped lands after it starts again", async () => {
    const convId = mkId("restart");
    create(convId, "openai", "gpt-5.5");
    setSystemInstructions(convId, "Before restart.");
    // The daemon went down mid-turn with this save accepted.
    savePendingConversationInstructions(new Map([[convId, "Saved mid-turn."]]));

    loadFromDisk();
    expect(getSystemInstructions(convId)).toBe("Saved mid-turn.");
    applyAllPendingSystemInstructions();
    await waitFor(() => storedInstructions(convId) === "Saved mid-turn.", "pending save to land after restart");
    expect(loadPendingConversationInstructions().has(convId)).toBe(false);
  });
});
