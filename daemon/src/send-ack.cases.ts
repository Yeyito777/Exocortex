import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DaemonServer, type ConnectedClient } from "./server";
import { createHandler } from "./handler";
import { create, get, remove } from "./conversations";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import { runDirectSendOnce } from "./direct-send";
import { beginDaemonShutdown, resetDaemonShutdownModeForTest } from "./daemon-lifecycle";
import type { streamMessage } from "./api";
import type { Command } from "./protocol";
import { DaemonClient } from "../../tui/src/client";
import { clearPendingAI, createInitialState, type RenderState } from "../../tui/src/state";
import { createMessageMetadata, createPendingAI, type UserMessage } from "../../tui/src/messages";
import { handleEvent } from "../../tui/src/events";
import { beginConversationLoad } from "../../tui/src/events/conversations";
import { noteResentDirectSends, trackDirectSend } from "../../tui/src/sendecho";

// A prompt the TUI sent as its daemon restarted, or as its /ssh link dropped,
// must reach the conversation exactly once or come back to the prompt. These
// cases drive the real TUI client and event handling against real daemon
// servers on one socket path, with a fake provider; a "restart" stops one
// server and starts another, the way the TUI sees a daemon restart.

const IDS: string[] = [];
const DIRS: string[] = [];

function mkId(suffix: string): string {
  const id = `send-ack-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function transcript(state: RenderState): string[] {
  const rows = state.messages.flatMap(message => {
    if (message.role === "user") return [`user:${message.text}`];
    if (message.role === "assistant") return message.blocks.flatMap(block => block.type === "text" ? [`ai:${block.text}`] : []);
    return [];
  });
  for (const block of state.pendingAI?.blocks ?? []) if (block.type === "text") rows.push(`live:${block.text}`);
  return rows;
}

/** User messages the daemon stored for `startedAt`. */
function storedPrompts(convId: string, startedAt: number): number {
  return get(convId)?.messages.filter(message => message.role === "user" && message.metadata?.startedAt === startedAt).length ?? 0;
}

interface Daemon {
  server: DaemonServer;
  /** Commands the daemon read but never ran: it went away first. */
  dropSends: boolean;
  /** Called once the send's user message is committed, before its ack goes out. */
  onCommitted: (() => void) | null;
  /** Sends that reached the daemon. */
  sends: Command[];
  stop(): Promise<void>;
}

/** The link drops: nothing more the daemon writes reaches the TUI. */
function dropConnections(daemon: Daemon): void {
  for (const client of (daemon.server as unknown as { clients: Map<string, ConnectedClient> }).clients.values()) client.socket.destroy();
}

interface Harness {
  socketPath: string;
  state: RenderState;
  client: DaemonClient;
  daemon: Daemon;
  /** Model requests made, across daemons. */
  requests(): number;
  start(): Promise<Daemon>;
  /** What the TUI does when the connection drops and comes back (main.ts). */
  reconnect(convId: string): Promise<void>;
  open(convId: string): Promise<void>;
  /** The TUI's direct send (main.ts sendDirectly). */
  send(convId: string, text: string): number;
  close(): Promise<void>;
}

async function harness(answer: (request: number) => Promise<string>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "exo-send-ack-"));
  DIRS.push(dir);
  const socketPath = join(dir, "daemon.sock");
  let requests = 0;
  const fakeStream = (async (_provider, _messages, _model, cb) => {
    const text = await answer(++requests);
    cb.onBlockStart?.("text");
    cb.onText(text);
    return {
      text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [],
      transcriptMessages: [{ role: "assistant" as const, content: [{ type: "text" as const, text }] }],
    };
  }) as typeof streamMessage;
  const callbacks: OrchestrationCallbacks = { onHeaders() {}, onComplete() {}, streamMessageFn: fakeStream };

  const start = async (): Promise<Daemon> => {
    let handler: ReturnType<typeof createHandler> | null = null;
    const daemon = { dropSends: false, onCommitted: null, sends: [] } as unknown as Daemon;
    // The handler's own send_message path (handler.ts), with the fake provider.
    const dispatch = (client: ConnectedClient, cmd: Command): unknown => {
      if (cmd.type !== "send_message") return handler?.(client, cmd);
      daemon.sends.push(cmd);
      if (daemon.dropSends) return;
      const send = { reqId: cmd.reqId, convId: cmd.convId, startedAt: cmd.startedAt };
      const run = (onCommitted?: () => void) => orchestrateSendMessage(
        server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt, callbacks, cmd.images,
        { subagentMaxDepth: null, onUserMessageCommitted: () => { daemon.onCommitted?.(); onCommitted?.(); } },
      );
      return cmd.acceptAck ? runDirectSendOnce(server, client, send, run) : run();
    };
    const server: DaemonServer = new DaemonServer(socketPath, (client, cmd) => void dispatch(client, cmd));
    handler = createHandler(server);
    await server.start();
    Object.assign(daemon, {
      server,
      stop: async () => {
        await handler!.stop();
        await server.stop();
      },
    });
    return daemon;
  };

  const state = createInitialState();
  const daemon = await start();
  const client: DaemonClient = new DaemonClient(event => handleEvent(event, state, client), socketPath);
  await client.connect();
  const h: Harness = {
    socketPath, state, client, daemon,
    requests: () => requests,
    start: async () => (h.daemon = await start()),
    open: async (convId) => {
      beginConversationLoad(state, convId, client);
      client.loadConversation(convId);
      await waitFor(() => state.convId === convId && state.conversationLoading === null, `open ${convId}`);
    },
    reconnect: async (convId) => {
      await waitFor(() => !client.connected, "the TUI to see the connection drop");
      // handleDaemonConnectionLost: the live tail goes; unconfirmed sends stay.
      clearPendingAI(state);
      const { replayedCommands } = await client.connect();
      noteResentDirectSends(state, replayedCommands);
      await h.open(convId);
    },
    send: (convId, text) => {
      const startedAt = Date.now();
      const message: UserMessage = { role: "user", text, metadata: createMessageMetadata(startedAt, state.model, { endedAt: startedAt }) };
      state.messages.push(message);
      state.pendingAI = createPendingAI(startedAt, state.model);
      client.sendMessage(convId, text, startedAt);
      trackDirectSend(state, convId, message);
      return startedAt;
    },
    close: async () => {
      client.disconnect();
      await h.daemon.stop();
    },
  };
  return h;
}

afterEach(() => {
  resetDaemonShutdownModeForTest();
  for (const id of IDS.splice(0)) remove(id);
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a prompt sent across a daemon restart or a dropped link runs once", () => {
  test("written as the daemon went away, it is sent to the next daemon", async () => {
    const h = await harness(async () => "on it");
    const convId = mkId("lost-write");
    create(convId, "anthropic", "claude-opus-5-5");
    try {
      await h.open(convId);
      h.daemon.dropSends = true;
      const startedAt = h.send(convId, "look into #1");
      await waitFor(() => h.daemon.sends.length === 1, "the send to reach the old daemon");
      await h.daemon.stop();
      expect(storedPrompts(convId, startedAt)).toBe(0);

      await h.start();
      await h.reconnect(convId);
      await waitFor(() => h.state.pendingAI === null && transcript(h.state).includes("ai:on it"), "the answer");
      expect(transcript(h.state)).toEqual(["user:look into #1", "ai:on it"]);
      expect(storedPrompts(convId, startedAt)).toBe(1);
      expect(h.requests()).toBe(1);
      expect(h.state.inputBuffer).toBe("");
      expect(h.state.unconfirmedSends).toEqual([]);
    } finally {
      await h.close();
    }
  });

  test("refused while the daemon shuts down, it waits for the next daemon", async () => {
    const h = await harness(async () => "on it");
    const convId = mkId("shutdown");
    create(convId, "anthropic", "claude-opus-5-5");
    try {
      await h.open(convId);
      beginDaemonShutdown("restart");
      const startedAt = h.send(convId, "look into #1");
      await waitFor(() => h.daemon.sends.length === 1, "the send to reach the stopping daemon");
      await Bun.sleep(20);
      // Not a failure the user has to act on: no error, the bubble stays.
      expect(transcript(h.state)).toEqual(["user:look into #1"]);
      expect(h.state.inputBuffer).toBe("");
      expect(h.state.messages.some(message => message.role === "system")).toBe(false);
      await h.daemon.stop();
      resetDaemonShutdownModeForTest();

      await h.start();
      await h.reconnect(convId);
      await waitFor(() => h.state.pendingAI === null && transcript(h.state).includes("ai:on it"), "the answer");
      expect(transcript(h.state)).toEqual(["user:look into #1", "ai:on it"]);
      expect(storedPrompts(convId, startedAt)).toBe(1);
      expect(h.requests()).toBe(1);
    } finally {
      await h.close();
    }
  });

  test("sent while disconnected, it goes once the daemon is back", async () => {
    const h = await harness(async () => "on it");
    const convId = mkId("offline");
    create(convId, "anthropic", "claude-opus-5-5");
    try {
      await h.open(convId);
      await h.daemon.stop();
      await waitFor(() => !h.client.connected, "the drop");
      const startedAt = h.send(convId, "look into #1");

      await h.start();
      await h.reconnect(convId);
      await waitFor(() => h.state.pendingAI === null && transcript(h.state).includes("ai:on it"), "the answer");
      expect(transcript(h.state)).toEqual(["user:look into #1", "ai:on it"]);
      expect(storedPrompts(convId, startedAt)).toBe(1);
      expect(h.daemon.sends).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  test("its ack lost to a link drop while the turn runs, the resend is not run again", async () => {
    const release = gate();
    const h = await harness(async () => { await release.promise; return "on it"; });
    const convId = mkId("ack-lost-running");
    create(convId, "anthropic", "claude-opus-5-5");
    try {
      await h.open(convId);
      // The link drops right after the daemon stored the prompt: neither its
      // ack nor its echo reaches the TUI.
      h.daemon.onCommitted = () => {
        h.daemon.onCommitted = null;
        dropConnections(h.daemon);
      };
      const startedAt = h.send(convId, "look into #1");
      await waitFor(() => storedPrompts(convId, startedAt) === 1, "the prompt to be stored");

      await h.reconnect(convId);
      await waitFor(() => h.daemon.sends.length === 2, "the resend");
      await waitFor(() => h.state.unconfirmedSends.length === 0, "the resend's ack");
      release.open();
      await waitFor(() => h.state.pendingAI === null && transcript(h.state).includes("ai:on it"), "the answer");
      expect(transcript(h.state)).toEqual(["user:look into #1", "ai:on it"]);
      expect(storedPrompts(convId, startedAt)).toBe(1);
      expect(h.requests()).toBe(1);
      expect(h.state.queuedMessages).toEqual([]);
    } finally {
      release.open();
      await h.close();
    }
  });

  test("stored and then the daemon restarted, the resend is answered, not run again", async () => {
    const h = await harness(async () => "on it");
    const convId = mkId("ack-lost-restart");
    create(convId, "anthropic", "claude-opus-5-5");
    try {
      await h.open(convId);
      const stopping: Array<Promise<void>> = [];
      h.daemon.onCommitted = () => {
        h.daemon.onCommitted = null;
        // The daemon dies before its ack is written.
        dropConnections(h.daemon);
        stopping.push(h.daemon.stop());
      };
      const startedAt = h.send(convId, "look into #1");
      await waitFor(() => stopping.length === 1, "the restart");
      await Promise.all(stopping);
      await waitFor(() => h.requests() === 1 && get(convId)?.messages.at(-1)?.role === "assistant", "the turn to finish");

      const next = await h.start();
      await h.reconnect(convId);
      await waitFor(() => next.sends.length === 1, "the resend");
      await waitFor(() => h.state.unconfirmedSends.length === 0 && h.state.pendingAI === null, "the resend's ack");
      expect(transcript(h.state)).toEqual(["user:look into #1", "ai:on it"]);
      expect(storedPrompts(convId, startedAt)).toBe(1);
      expect(h.requests()).toBe(1);
    } finally {
      await h.close();
    }
  });
});
