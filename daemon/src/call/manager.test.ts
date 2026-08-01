import { describe, expect, mock, test } from "bun:test";
import type { Conversation } from "../messages";
import type { RealtimeSidebandEvent } from "./protocol";
import type { NativeRealtimeStartParams, NativeRealtimeTransport } from "./transport";
import { buildRealtimeInitialItems, estimateRealtimeTokens, RealtimeCallManager } from "./manager";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-call",
    provider: "openai",
    model: "gpt-5.4",
    effort: "medium",
    fastMode: false,
    messages: [
      { role: "user", content: "Earlier question", metadata: null },
      { role: "assistant", content: "Earlier answer", metadata: null },
    ],
    createdAt: 1,
    updatedAt: 1,
    lastContextTokens: null,
    marked: false,
    pinned: false,
    sortOrder: 0,
    title: "Call test",
    ...overrides,
  };
}

class FakeTransport implements NativeRealtimeTransport {
  stopped = 0;
  starts: NativeRealtimeStartParams[] = [];
  handoffs: Array<{ handoffId: string; text: string }> = [];

  async start(params: NativeRealtimeStartParams) {
    this.starts.push(params);
    return { answerSdp: "v=0\r\no=answer", callId: "rtc-test" };
  }
  async appendHandoff(handoffId: string, text: string): Promise<void> { this.handoffs.push({ handoffId, text }); }
  async stop(): Promise<void> { this.stopped++; }
}

function fakeServer() {
  const direct: Array<Record<string, unknown>> = [];
  const subscriber: Array<Record<string, unknown>> = [];
  return {
    direct,
    subscriber,
    server: {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { direct.push(event); }),
      sendToSubscribers: mock((_convId: string, event: Record<string, unknown>) => { subscriber.push(event); }),
      broadcast: mock(() => {}),
      sendHistoryUpdatedToSubscribers: mock(() => {}),
    },
  };
}

describe("realtime call manager", () => {
  test("prepares Bidi context, attaches WebRTC, persists transcripts, and delegates handoffs", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
    const persisted: Array<{ role: string; text: string }> = [];
    const statuses: string[] = [];
    let emit: ((event: RealtimeSidebandEvent) => void | Promise<void>) | null = null;
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: handler => {
        emit = handler;
        return realtime;
      },
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => "Prefer concise spoken replies.",
      getAccountScope: () => "scope",
      persistTranscript: (_id, role, text) => {
        persisted.push({ role, text });
        return true;
      },
      persistStatus: (_id, text) => {
        statuses.push(text);
        return true;
      },
      delegate: async (_id, text) => `Agent completed: ${text}`,
    });

    const started = await manager.start(conv.id);
    expect(started.state).toBe("waiting_for_media");
    expect(server.subscriber).toContainEqual(expect.objectContaining({
      type: "call_state",
      callId: started.callId,
      state: "waiting_for_media",
    }));

    const mediaClient = {} as never;
    await manager.attachMedia(mediaClient, conv.id, started.callId, "v=0\r\no=offer", "media-req");
    expect(realtime.starts).toHaveLength(1);
    expect(realtime.starts[0]).toMatchObject({
      threadId: conv.id,
      sessionId: started.callId,
      offerSdp: "v=0\r\no=offer",
    });
    expect(realtime.starts[0]!.prompt).toContain("multipart requests");
    expect(realtime.starts[0]!.prompt).toContain("completeness matters");
    expect(realtime.starts[0]!.initialItems).toEqual([
      { role: "developer", text: "Prefer concise spoken replies." },
      { role: "user", text: "Earlier question" },
      { role: "assistant", text: "Earlier answer" },
    ]);
    expect(statuses).toEqual(["Realtime call started."]);
    expect(server.direct).toContainEqual({
      type: "call_sdp_answer",
      reqId: "media-req",
      convId: conv.id,
      callId: started.callId,
      sdp: "v=0\r\no=answer",
    });

    await emit!({ type: "transcript_done", role: "user", text: "Please inspect it" });
    expect(persisted).toEqual([{ role: "user", text: "Please inspect it" }]);

    await emit!({ type: "transcript_delta", role: "assistant", text: "Spoken " });
    expect(server.subscriber).toContainEqual(expect.objectContaining({
      type: "call_transcript",
      role: "assistant",
      text: "Spoken ",
      final: false,
      endedAt: null,
      model: "gpt-live-1-boulder-alpha",
      tokens: expect.any(Number),
    }));
    await Bun.sleep(5);
    await emit!({ type: "transcript_delta", role: "assistant", text: "reply." });
    expect(persisted.filter(entry => entry.role === "assistant")).toHaveLength(0);

    // Frameless Bidi may omit assistant turn.done and pause between output
    // chunks. The next user turn is the reliable boundary; do not persist a
    // quiet-period prefix that later becomes a duplicated assistant message.
    await emit!({ type: "transcript_delta", role: "user", text: "Next " });
    expect(persisted).toContainEqual({ role: "assistant", text: "Spoken reply." });
    expect(server.subscriber).toContainEqual(expect.objectContaining({
      type: "call_transcript",
      role: "assistant",
      text: "Spoken reply.",
      final: true,
      endedAt: expect.any(Number),
      model: "gpt-live-1-boulder-alpha",
      tokens: expect.any(Number),
    }));
    await emit!({ type: "transcript_done", role: "assistant", text: "Spoken reply" });
    expect(persisted.filter(entry => entry.role === "assistant")).toHaveLength(1);

    await emit!({ type: "handoff", handoffId: "delegation-1", text: "inspect the repository" });
    expect(persisted).toContainEqual({ role: "user", text: "inspect the repository" });
    expect(server.subscriber.some(event =>
      event.type === "call_state" && typeof event.message === "string" && event.message.includes("Delegating")
    )).toBe(false);
    expect(realtime.handoffs).toEqual([{
      handoffId: "delegation-1",
      text: "Agent completed: inspect the repository",
    }]);

    await manager.stop(conv.id, started.callId);
    expect(realtime.stopped).toBe(1);
    expect(statuses).toEqual(["Realtime call started.", "Realtime call ended."]);
    expect(manager.hasActiveCall()).toBe(false);
  });

  test("shuts down cleanly while authentication is still starting", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
    let finishAuthentication!: () => void;
    const authentication = new Promise<void>(resolve => { finishAuthentication = resolve; });
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: () => realtime,
      ensureAuthenticated: () => authentication,
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: () => true,
    });

    const starting = manager.start(conv.id).then(() => null, error => error as Error);
    await Promise.resolve();
    await manager.stopAll();
    finishAuthentication();
    const startError = await starting;

    expect(startError).toBeInstanceOf(Error);
    expect(startError!.message).toContain("stopped while starting");
    expect(realtime.stopped).toBe(1);
    expect(manager.hasActiveCall()).toBe(false);
    expect(server.subscriber).toContainEqual(expect.objectContaining({ state: "closed" }));
  });

  test("does not split a delegation preamble when the handoff input is repeated as user turn.done", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
    const persisted: Array<{ role: string; text: string }> = [];
    let emit: ((event: RealtimeSidebandEvent) => void | Promise<void>) | null = null;
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: handler => {
        emit = handler;
        return realtime;
      },
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: (_id, role, text) => {
        persisted.push({ role, text });
        return true;
      },
      delegate: async () => "The delegated answer.",
    });

    const started = await manager.start(conv.id);
    await manager.attachMedia({} as never, conv.id, started.callId, "v=0\r\no=offer", "media-req");
    await emit!({ type: "handoff", handoffId: "handoff-1", text: "Check the time" });
    await emit!({ type: "transcript_delta", role: "assistant", text: "Lemme" });
    // The service emits a second representation of the same input turn after
    // delegation.created. This is not a new user boundary.
    await emit!({ type: "transcript_done", role: "user", text: "Check the time" });

    expect(persisted).toEqual([{ role: "user", text: "Check the time" }]);

    await emit!({ type: "transcript_done", role: "assistant", text: "Lemme check." });
    expect(persisted).toEqual([
      { role: "user", text: "Check the time" },
      { role: "assistant", text: "Lemme check." },
    ]);
    expect(persisted).not.toContainEqual({ role: "assistant", text: "Lemme" });
    await manager.stopAll();
  });

  test("rejects non-OpenAI owners and enforces one global active call", async () => {
    const openAI = conversation();
    const deepSeek = conversation({ id: "deep", provider: "deepseek", model: "deepseek-chat" });
    const realtime = new FakeTransport();
    const server = fakeServer();
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: () => realtime,
      ensureAuthenticated: async () => {},
      getConversation: id => id === openAI.id ? openAI : id === deepSeek.id ? deepSeek : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: () => true,
    });

    await expect(manager.start(deepSeek.id)).rejects.toThrow("OpenAI conversation");
    await manager.start(openAI.id);
    await expect(manager.start(deepSeek.id)).rejects.toThrow("already active");
    await manager.stopAll();
  });
});

describe("buildRealtimeInitialItems", () => {
  test("omits a generic developer prompt when no conversation instructions exist", () => {
    const items = buildRealtimeInitialItems(conversation(), null, "scope");
    expect(items).toEqual([
      { role: "user", text: "Earlier question" },
      { role: "assistant", text: "Earlier answer" },
    ]);
  });

  test("keeps instructions first and bounds oversized history", () => {
    const conv = conversation({
      messages: Array.from({ length: 100 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `${index}: ${"x".repeat(2_000)}`,
        metadata: null,
      })),
    });
    const items = buildRealtimeInitialItems(conv, "Voice persona instructions", "scope");
    expect(items[0]?.role).toBe("developer");
    expect(items[0]?.text).toContain("Voice persona instructions");
    expect(items.length).toBeLessThanOrEqual(64);
    expect(items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(28_000);
    expect(items.at(-1)?.text).toContain("99:");
  });
});

describe("estimateRealtimeTokens", () => {
  test("keeps live metadata nonzero for spoken text", () => {
    expect(estimateRealtimeTokens("")).toBe(0);
    expect(estimateRealtimeTokens("One sec.")).toBeGreaterThan(0);
  });
});
