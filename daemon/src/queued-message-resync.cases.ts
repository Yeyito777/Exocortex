import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DaemonServer, type ConnectedClient } from "./server";
import { createHandler } from "./handler";
import { create, remove } from "./conversations";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import type { streamMessage } from "./api";
import type { Command } from "./protocol";
import { DaemonClient } from "../../tui/src/client";
import { createInitialState, type RenderState } from "../../tui/src/state";
import { createMessageMetadata, createPendingAI } from "../../tui/src/messages";
import { handleEvent } from "../../tui/src/events";
import { beginConversationLoad } from "../../tui/src/events/conversations";

// The owner's TUI runs remotely over SSH against a heavily loaded daemon. These
// cases drive the real daemon handler and the real TUI event handling through a
// socket, with a fake provider and a dispatcher that can hold commands the way a
// stalled daemon event loop does, then run them back to back.

const IDS: string[] = [];
const DIRS: string[] = [];

function mkId(suffix: string): string {
  const id = `queued-resync-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/** The visible transcript: user prompts, committed AI text, then the live tail. */
function transcript(state: RenderState): string[] {
  const rows = state.messages.flatMap(message => {
    if (message.role === "user") return [`user:${message.text}`];
    if (message.role === "assistant") return message.blocks.flatMap(block => block.type === "text" ? [`ai:${block.text}`] : []);
    return [];
  });
  for (const block of state.pendingAI?.blocks ?? []) if (block.type === "text") rows.push(`live:${block.text}`);
  return rows;
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

interface Harness {
  server: DaemonServer;
  client: DaemonClient;
  state: RenderState;
  callbacks: OrchestrationCallbacks;
  /** Hold incoming commands, as a blocked daemon event loop would. */
  hold(): void;
  /** Run every held command synchronously in arrival order. */
  flush(): void;
  held(): Command[];
  /** Open a conversation the way the remote TUI does: placeholder first. */
  open(convId: string): void;
  onComplete: (() => void) | null;
  close(): Promise<void>;
}

async function harness(streamMessageFn: typeof streamMessage): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "exo-queued-resync-"));
  DIRS.push(dir);
  const socketPath = join(dir, "daemon.sock");
  let handler: ReturnType<typeof createHandler> | null = null;
  let holding = false;
  const heldCommands: Array<{ client: ConnectedClient; cmd: Command }> = [];
  const h = { onComplete: null } as Harness;
  const callbacks: OrchestrationCallbacks = {
    onHeaders() {},
    onComplete() { h.onComplete?.(); },
    streamMessageFn,
  };
  // The handler's own send_message path, with this fake provider.
  const dispatch = (client: ConnectedClient, cmd: Command): void | Promise<unknown> => {
    if (cmd.type === "send_message") {
      return orchestrateSendMessage(server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt, callbacks, cmd.images, { subagentMaxDepth: null });
    }
    return handler?.(client, cmd);
  };
  const server: DaemonServer = new DaemonServer(socketPath, (client, cmd) => {
    if (!holding) return void dispatch(client, cmd);
    heldCommands.push({ client, cmd });
  });
  handler = createHandler(server);
  await server.start();
  const state = createInitialState();
  const client: DaemonClient = new DaemonClient(event => handleEvent(event, state, client), socketPath);
  await client.connect();
  Object.assign(h, {
    server, client, state, callbacks,
    hold: () => { holding = true; },
    flush: () => {
      holding = false;
      for (const { client: from, cmd } of heldCommands.splice(0)) void dispatch(from, cmd);
    },
    held: () => heldCommands.map(({ cmd }) => cmd),
    open: (convId: string) => {
      beginConversationLoad(state, convId, client);
      client.loadConversation(convId);
    },
    close: async () => {
      client.disconnect();
      await server.stop();
    },
  });
  return h;
}

async function openAndWait(h: Harness, convId: string): Promise<void> {
  h.open(convId);
  await waitFor(() => h.state.convId === convId && h.state.conversationLoading === null, `open ${convId}`);
}

afterEach(() => {
  for (const id of IDS.splice(0)) remove(id);
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a prompt accepted while its sender is away shows once on re-open", () => {
  test("a direct send whose admission yields to the sender's switch away and back", async () => {
    const releaseAnswer = gate();
    const answering = gate();
    const fakeStream = (async (_provider, _messages, _model, cb) => {
      cb.onBlockStart?.("text");
      cb.onText("answering the prompt");
      answering.open();
      await releaseAnswer.promise;
      return finalAnswer("answering the prompt");
    }) as typeof streamMessage;
    const h = await harness(fakeStream);
    const convA = mkId("direct-a");
    const convB = mkId("direct-b");
    create(convA, "anthropic", "claude-opus-5-5");
    create(convB, "anthropic", "claude-opus-5-5");
    try {
      await openAndWait(h, convA);

      // The daemon's event loop is stalled. The TUI shows the prompt
      // optimistically, then the user looks at another conversation and comes
      // back before the daemon has read any of it.
      h.hold();
      const startedAt = Date.now();
      h.state.messages.push({ role: "user", text: "fix the locale warnings", metadata: createMessageMetadata(startedAt, h.state.model, { endedAt: startedAt }) });
      h.state.pendingAI = createPendingAI(startedAt, h.state.model);
      h.client.sendMessage(convA, "fix the locale warnings", startedAt);
      h.open(convB);
      h.open(convA);
      await waitFor(() => h.held().some(cmd => cmd.type === "load_conversation" && cmd.convId === convA), "commands to reach the daemon");
      h.flush();

      await answering.promise;
      await waitFor(() => h.state.conversationLoading === null
        && transcript(h.state).includes("live:answering the prompt"), "re-open and live answer");
      expect(transcript(h.state)).toEqual(["user:fix the locale warnings", "live:answering the prompt"]);

      releaseAnswer.open();
      await waitFor(() => h.state.pendingAI === null, "turn completion");
      expect(transcript(h.state)).toEqual(["user:fix the locale warnings", "ai:answering the prompt"]);
    } finally {
      releaseAnswer.open();
      await h.close();
    }
  });

  test("the sender that stays sees its prompt once and keeps a same-text queued copy", async () => {
    const releaseAnswer = gate();
    const fakeStream = (async (_provider, _messages, _model, cb) => {
      cb.onBlockStart?.("text");
      cb.onText("on it");
      await releaseAnswer.promise;
      return finalAnswer("on it");
    }) as typeof streamMessage;
    const h = await harness(fakeStream);
    const convA = mkId("stay");
    create(convA, "anthropic", "claude-opus-5-5");
    try {
      await openAndWait(h, convA);
      const startedAt = Date.now();
      h.state.messages.push({ role: "user", text: "continue", metadata: createMessageMetadata(startedAt, h.state.model, { endedAt: startedAt }) });
      h.state.pendingAI = createPendingAI(startedAt, h.state.model);
      // Queued again right away, before the daemon echoes the first send.
      h.state.queuedMessages.push({ id: "local-continue", optimistic: true, convId: convA, text: "continue", timing: "message-end", source: "daemon", createdAt: Date.now() });
      h.client.sendMessage(convA, "continue", startedAt);
      await waitFor(() => transcript(h.state).includes("live:on it"), "live answer");
      expect(transcript(h.state)).toEqual(["user:continue", "live:on it"]);
      expect(h.state.queuedMessages.map(message => message.id)).toEqual(["local-continue"]);
    } finally {
      releaseAnswer.open();
      await h.close();
    }
  });

  // Claude Code shape: the provider runs its own tool round and takes queued
  // next-turn input at that boundary, inside one request.
  function claudeCodeStream(release: { first: Promise<void>; second: Promise<void> }, signals: { streaming: () => void; answering: () => void }) {
    let requests = 0;
    return (async (_provider, _messages, _model, cb, options) => {
      requests += 1;
      const queued = options!.queuedInput!;
      const unsubscribe = queued.subscribe(() => {});
      try {
        if (requests === 1) {
          cb.onBlockStart?.("text");
          cb.onText("working on it");
          cb.onToolCall?.({ type: "tool_call", toolCallId: "tool-1", toolName: "bash", input: {}, summary: "build" });
          signals.streaming();
          await release.first;
          cb.onToolResult?.({ type: "tool_result", toolCallId: "tool-1", toolName: "bash", output: "built", isError: false });
          cb.onProviderRound?.({
            blocks: [],
            messages: [
              { role: "assistant", content: [{ type: "text", text: "working on it" }, { type: "tool_use", id: "tool-1", name: "bash", input: {} }] },
              { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "built" }] },
            ],
            outputTokens: 1,
          });
          await new Promise(resolve => setTimeout(resolve, 0));
          const taken = queued.pending();
          if (taken.length === 0) return finalAnswer("built it");
          await cb.onQueuedInput!(taken);
        }
        cb.onBlockStart?.("text");
        cb.onText("answering the queued prompt");
        signals.answering();
        await release.second;
        return finalAnswer("answering the queued prompt");
      } finally {
        unsubscribe();
      }
    }) as typeof streamMessage;
  }

  for (const timing of ["next-turn", "message-end"] as const) {
    const expectedLive = timing === "next-turn"
      ? ["user:first prompt", "ai:working on it", "user:queued prompt", "live:answering the queued prompt"]
      : ["user:first prompt", "ai:working on it", "ai:built it", "user:queued prompt", "live:answering the queued prompt"];

    for (const when of ["while away", "while the re-open is in flight"] as const) {
      test(`a ${timing} queued prompt delivered ${when}`, async () => {
        const releaseFirst = gate();
        const releaseSecond = gate();
        const streaming = gate();
        const answering = gate();
        const h = await harness(claudeCodeStream(
          { first: releaseFirst.promise, second: releaseSecond.promise },
          { streaming: streaming.open, answering: answering.open },
        ));
        const convA = mkId(`${timing}-a`);
        const convB = mkId(`${timing}-b`);
        create(convA, "anthropic", "claude-opus-5-5");
        create(convB, "anthropic", "claude-opus-5-5");
        try {
          await openAndWait(h, convA);
          const turn = orchestrateSendMessage(h.server, null, undefined, convA, "first prompt", Date.now(), h.callbacks);
          await streaming.promise;
          await waitFor(() => transcript(h.state).includes("live:working on it"), "first round live");

          const queueId = crypto.randomUUID();
          h.state.queuedMessages.push({ id: queueId, optimistic: true, convId: convA, text: "queued prompt", timing, source: "daemon", createdAt: Date.now() });
          h.client.queueMessage(convA, "queued prompt", timing, undefined, { queueId });
          await waitFor(() => h.state.queuedMessages.some(message => message.id === queueId && !message.optimistic), "queue acknowledgement");

          await openAndWait(h, convB);
          if (when === "while away") {
            releaseFirst.open();
            await answering.promise;
            await openAndWait(h, convA);
          } else {
            // The re-open reaches the daemon at the delivery boundary: after the
            // first round settles, before the queued prompt is committed.
            h.hold();
            h.open(convA);
            await waitFor(() => h.held().some(cmd => cmd.type === "load_conversation" && cmd.convId === convA), "re-open to reach the daemon");
            if (timing === "message-end") h.onComplete = () => { h.onComplete = null; h.flush(); };
            else h.flush();
            releaseFirst.open();
            await answering.promise;
          }
          await waitFor(() => h.state.conversationLoading === null
            && transcript(h.state).includes("live:answering the queued prompt"), "re-opened live answer");
          expect(transcript(h.state)).toEqual(expectedLive);
          expect(h.state.queuedMessages).toEqual([]);

          releaseSecond.open();
          await turn;
          await waitFor(() => h.state.pendingAI === null, "turn completion");
          expect(transcript(h.state)).toEqual([...expectedLive.slice(0, -1), "ai:answering the queued prompt"]);
          expect(h.state.queuedMessages).toEqual([]);
        } finally {
          releaseFirst.open();
          releaseSecond.open();
          await h.close();
        }
      });
    }
  }
});
