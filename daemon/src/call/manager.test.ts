import { describe, expect, mock, test } from "bun:test";
import type { Conversation } from "../messages";
import type { RealtimeSidebandEvent } from "./protocol";
import type { NativeRealtimeStartParams, NativeRealtimeTransport } from "./transport";
import { buildRealtimeInitialItems, estimateRealtimeTokens, mergeCompletedTranscript, RealtimeCallManager, stripRepeatedInterruptedTranscript } from "./manager";
import type { RealtimeVoice } from "@exocortex/shared/realtime";

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
  inputs: string[] = [];
  cancellations = 0;

  async start(params: NativeRealtimeStartParams) {
    this.starts.push(params);
    return { answerSdp: "v=0\r\no=answer", callId: "rtc-test" };
  }
  async appendHandoff(handoffId: string, text: string): Promise<void> { this.handoffs.push({ handoffId, text }); }
  async appendInput(text: string): Promise<void> { this.inputs.push(text); }
  async cancelResponse(): Promise<void> { this.cancellations++; }
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
  test("accepts generic participant and speaker-state updates and rejects unknown speakers", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const manager = new RealtimeCallManager(fakeServer().server as never, {
      createTransport: () => realtime,
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: () => true,
      persistStatus: () => true,
    });
    const participants = [
      { id: "owner", displayName: "Owner", trust: "owner" as const },
      { id: "friend", displayName: "Friend", trust: "friend" as const },
    ];
    const started = await manager.start(
      conv.id,
      undefined,
      { type: "external", id: "discord:paramount:voice", toolName: "discord", endpointId: "voice" },
      participants,
    );

    expect(() => manager.updateSpeakers(conv.id, started.callId, {
      participantIds: ["owner"],
      observedAt: 100,
    })).not.toThrow();
    expect(() => manager.updateSpeakers(conv.id, started.callId, {
      participantIds: ["owner", "friend"],
      observedAt: 120,
    })).not.toThrow();
    expect(() => manager.updateSpeakers(conv.id, started.callId, {
      participantIds: ["stranger"],
      observedAt: 140,
    })).toThrow("not present in the call participant roster");

    await manager.attachMedia({} as never, conv.id, started.callId, "v=0\r\no=offer", "media-req");
    expect(realtime.starts[0]?.initialItems[0]).toEqual({
      role: "developer",
      text: "[call participants]\nOwner <owner> [owner]\nFriend <friend> [friend]\nSpeaker identity and trust come from the authenticated media adapter.",
    });

    await manager.stop(conv.id, started.callId);
  });

  test("attributes input turns to one speaker, overlapping speakers, or unknown conservatively", async () => {
    const conv = conversation();
    const server = fakeServer();
    let emit: ((event: RealtimeSidebandEvent) => void | Promise<void>) | null = null;
    const persistedSources: Array<Record<string, unknown>> = [];
    const delegations: Array<Record<string, unknown>> = [];
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: handler => {
        emit = handler;
        return new FakeTransport();
      },
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: (_id, _role, _text, _startedAt, details) => {
        persistedSources.push(details ?? {});
        return true;
      },
      persistStatus: () => true,
      delegate: async (_id, delegation) => {
        delegations.push(delegation);
        return { status: "completed", text: "done" };
      },
    });
    const participants = [
      { id: "owner", displayName: "Owner", trust: "owner" as const },
      { id: "friend", displayName: "Friend", trust: "friend" as const },
    ];
    const started = await manager.start(
      conv.id,
      undefined,
      { type: "external", id: "discord:paramount:voice", toolName: "discord", endpointId: "voice" },
      participants,
    );
    const now = Date.now();

    manager.updateSpeakers(conv.id, started.callId, { participantIds: ["owner"], observedAt: now - 400 });
    manager.updateSpeakers(conv.id, started.callId, { participantIds: [], observedAt: now - 300 });
    await emit!({ type: "transcript_done", role: "user", text: "owner request" });

    manager.updateSpeakers(conv.id, started.callId, { participantIds: ["owner", "friend"], observedAt: now - 200 });
    manager.updateSpeakers(conv.id, started.callId, { participantIds: [], observedAt: now - 100 });
    await emit!({ type: "transcript_done", role: "user", text: "overlap" });
    await emit!({ type: "transcript_done", role: "user", text: "no speaker boundary" });

    const userTurns = server.subscriber.filter(event => event.type === "call_transcript"
      && event.role === "user" && event.final === true);
    expect(userTurns[0]?.speaker).toEqual({ kind: "single", participants: [participants[0]] });
    expect(userTurns[1]?.speaker).toEqual({ kind: "multiple", participants: [participants[1], participants[0]] });
    expect(userTurns[2]?.speaker).toEqual({ kind: "unknown", participants: [] });
    expect(persistedSources.slice(0, 3).map(source => source.speaker)).toEqual([
      { kind: "single", participants: [participants[0]] },
      { kind: "multiple", participants: [participants[1], participants[0]] },
      { kind: "unknown", participants: [] },
    ]);

    manager.updateSpeakers(conv.id, started.callId, { participantIds: ["owner"], observedAt: now });
    manager.updateSpeakers(conv.id, started.callId, { participantIds: [], observedAt: now + 1 });
    await emit!({ type: "transcript_done", role: "user", text: "delegated owner request" });
    await emit!({ type: "handoff", handoffId: "speaker-handoff", text: "inspect it" });
    await Bun.sleep(0);
    expect(delegations[0]?.speaker).toEqual({ kind: "single", participants: [participants[0]] });

    await manager.stop(conv.id, started.callId);
  });

  test("transcribes platform-separated utterances and sends attributed text to Bidi", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
    const persisted: Array<{ role: string; text: string; startedAt: number; details: Record<string, unknown> }> = [];
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: () => realtime,
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: (_id, role, text, startedAt, details) => {
        persisted.push({ role, text, startedAt: startedAt ?? -1, details: details ?? {} });
        return true;
      },
      persistStatus: () => true,
      transcribeUtterance: async () => "separate speaker transcript",
    });
    const participant = { id: "owner", displayName: "Owner", trust: "owner" as const };
    const started = await manager.start(
      conv.id,
      undefined,
      {
        type: "external",
        id: "discord:paramount:voice",
        toolName: "discord",
        endpointId: "voice",
        inputMode: "attributed_utterances",
      },
      [participant],
    );
    await manager.attachMedia({} as never, conv.id, started.callId, "v=0\r\no=offer", "media-req");

    manager.submitUtterance(conv.id, started.callId, {
      utteranceId: "utterance-1",
      participantId: participant.id,
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/wav",
      startedAt: 1_000,
      endedAt: 2_000,
    });
    // A transport retry with the same idempotency key must not duplicate speech.
    manager.submitUtterance(conv.id, started.callId, {
      utteranceId: "utterance-1",
      participantId: participant.id,
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/wav",
      startedAt: 1_000,
      endedAt: 2_000,
    });
    for (let attempt = 0; attempt < 20 && realtime.inputs.length === 0; attempt++) await Bun.sleep(0);

    expect(realtime.inputs).toEqual([
      "[call speaker: Owner <owner> [owner]]\nseparate speaker transcript",
    ]);
    expect(persisted.filter(entry => entry.role === "user")).toEqual([{
      role: "user",
      text: "separate speaker transcript",
      startedAt: 1_000,
      details: expect.objectContaining({
        endedAt: 2_000,
        speaker: { kind: "single", participants: [participant] },
      }),
    }]);
    expect(server.subscriber).toContainEqual(expect.objectContaining({
      type: "call_transcript",
      role: "user",
      text: "separate speaker transcript",
      speaker: { kind: "single", participants: [participant] },
      final: true,
    }));

    await manager.stop(conv.id, started.callId);
  });

  test("prepares Bidi context, attaches WebRTC, persists transcripts, and delegates handoffs", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
    const persisted: Array<{ role: string; text: string }> = [];
    const persistedSources: Array<Record<string, unknown>> = [];
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
      persistTranscript: (_id, role, text, _startedAt, details) => {
        persisted.push({ role, text });
        persistedSources.push(details ?? {});
        return true;
      },
      persistStatus: (_id, text) => {
        statuses.push(text);
        return true;
      },
      delegate: async (_id, delegation) => ({
        status: "completed",
        text: `Agent completed: ${delegation.backendTask}`,
      }),
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
      voice: "cove",
    });
    expect(realtime.starts[0]!.prompt).toContain("delegate only the backend work");
    expect(realtime.starts[0]!.prompt).toContain("completeness matters");
    expect(realtime.starts[0]!.prompt).toContain("do not claim to be checking, waiting, loading, or making progress");
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
      adapter: { type: "tui", id: "local" },
      sdp: "v=0\r\no=answer",
    });

    await emit!({ type: "transcript_done", role: "user", text: "Please inspect it" });
    expect(persisted).toEqual([{ role: "user", text: "Please inspect it" }]);
    expect(persistedSources[0]).toMatchObject({
      callId: started.callId,
      adapterType: "tui",
      adapterId: "local",
    });

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
    await emit!({ type: "transcript_done", role: "user", text: "Next request" });

    await emit!({ type: "handoff", handoffId: "delegation-1", text: "inspect the repository" });
    await Bun.sleep(0);
    expect(persisted).toContainEqual({ role: "user", text: "Next request" });
    expect(persisted).not.toContainEqual({ role: "user", text: "inspect the repository" });
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
      delegate: async () => ({ status: "completed", text: "The delegated answer." }),
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

  test("removes a replayed user utterance when the model is interrupted mid-response", async () => {
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
    });

    const started = await manager.start(conv.id);
    await manager.attachMedia({} as never, conv.id, started.callId, "v=0\r\no=offer", "media-req");
    const request = "Would be cool if you read the files and tell me what this project is about";
    await emit!({ type: "transcript_done", role: "user", text: request });
    await emit!({ type: "transcript_delta", role: "assistant", text: "Sure. Checking the" });
    await emit!({ type: "transcript_delta", role: "user", text: "Yo, sorry. Gimme a moment. " });
    await emit!({ type: "transcript_delta", role: "user", text: request });
    await emit!({
      type: "transcript_done",
      role: "user",
      text: `Yo, sorry. Gimme a moment. ${request}`,
    });

    expect(persisted).toEqual([
      { role: "user", text: request },
      { role: "assistant", text: "Sure. Checking the" },
      { role: "user", text: "Yo, sorry. Gimme a moment." },
    ]);
    const projectedUserEvents = server.subscriber.filter(event =>
      event.type === "call_transcript" && event.role === "user"
    );
    expect(projectedUserEvents.at(-2)).toMatchObject({
      text: "Yo, sorry. Gimme a moment.",
      final: false,
    });
    expect(projectedUserEvents.at(-1)).toMatchObject({
      text: "Yo, sorry. Gimme a moment.",
      final: true,
    });
    await manager.stopAll();
  });

  test("returns a clean result to GPT-Live when the delegated stream is cancelled", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
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
      persistTranscript: () => true,
      delegate: async () => ({ status: "cancelled" }),
    });

    const started = await manager.start(conv.id);
    await manager.attachMedia({} as never, conv.id, started.callId, "v=0\r\no=offer", "media-req");
    await emit!({ type: "handoff", handoffId: "handoff-cancelled", text: "Inspect the repository" });
    await Bun.sleep(0);

    expect(realtime.handoffs).toEqual([{
      handoffId: "handoff-cancelled",
      text: "The delegated request was canceled.",
    }]);
    await manager.stopAll();
  });

  test("hangup aborts an in-flight delegation before closing the transport", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
    let emit: ((event: RealtimeSidebandEvent) => void | Promise<void>) | null = null;
    let delegationAborted = false;
    let delegationStarted!: () => void;
    const startedDelegation = new Promise<void>(resolve => { delegationStarted = resolve; });
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: handler => {
        emit = handler;
        return realtime;
      },
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: () => true,
      delegate: async (_id, _delegation, signal) => {
        delegationStarted();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => {
          delegationAborted = true;
          resolve();
        }, { once: true }));
        return { status: "cancelled" };
      },
    });

    const started = await manager.start(conv.id);
    await manager.attachMedia({} as never, conv.id, started.callId, "v=0\r\no=offer", "media-req");
    await emit!({ type: "handoff", handoffId: "handoff-running", text: "Inspect the repository" });
    await startedDelegation;
    await manager.stop(conv.id, started.callId);

    expect(delegationAborted).toBe(true);
    expect(realtime.stopped).toBe(1);
    expect(realtime.handoffs).toEqual([]);
  });

  test("agent-initiated hangup lets the tool-owning delegation finish", async () => {
    const conv = conversation();
    const realtime = new FakeTransport();
    const server = fakeServer();
    let emit: ((event: RealtimeSidebandEvent) => void | Promise<void>) | null = null;
    let delegationStarted!: () => void;
    let finishDelegation!: () => void;
    let delegationAborted = false;
    let delegationFinished = false;
    const startedDelegation = new Promise<void>(resolve => { delegationStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishDelegation = resolve; });
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: handler => {
        emit = handler;
        return realtime;
      },
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: () => true,
      delegate: async (_id, _delegation, signal) => {
        signal.addEventListener("abort", () => { delegationAborted = true; }, { once: true });
        delegationStarted();
        await finish;
        delegationFinished = true;
        return { status: "completed", text: "The call ended." };
      },
    });

    const started = await manager.start(conv.id);
    await manager.attachMedia({} as never, conv.id, started.callId, "v=0\r\no=offer", "media-req");
    await emit!({ type: "handoff", handoffId: "handoff-hangup", text: "Hang up the call" });
    await startedDelegation;
    await manager.stopFromAgent(conv.id);

    expect(delegationAborted).toBe(false);
    expect(realtime.stopped).toBe(1);
    finishDelegation();
    await Bun.sleep(0);
    expect(delegationFinished).toBe(true);
    expect(realtime.handoffs).toEqual([]);
  });

  test("rejects non-OpenAI owners while allowing independent media adapters", async () => {
    const openAI = conversation();
    const otherOpenAI = conversation({ id: "other-openai", title: "Discord call" });
    const deepSeek = conversation({ id: "deep", provider: "deepseek", model: "deepseek-chat" });
    const transports: FakeTransport[] = [];
    const server = fakeServer();
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      ensureAuthenticated: async () => {},
      getConversation: id => id === openAI.id ? openAI : id === otherOpenAI.id ? otherOpenAI : id === deepSeek.id ? deepSeek : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: () => true,
    });

    await expect(manager.start(deepSeek.id)).rejects.toThrow("OpenAI conversation");
    const tui = await manager.start(openAI.id);
    const discord = await manager.start(otherOpenAI.id, undefined, {
      type: "external",
      id: "discord:paramount:voice-1",
      toolName: "discord",
      accountAlias: "paramount",
      endpointId: "voice-1",
      label: "#voice",
    });
    expect(tui.callId).not.toBe(discord.callId);
    expect(transports).toHaveLength(2);
    await expect(manager.start(otherOpenAI.id)).rejects.toThrow("tui media adapter");
    await manager.stop(openAI.id, tui.callId);
    expect(manager.hasActiveCall()).toBe(true);
    await manager.stop(otherOpenAI.id, discord.callId);
    expect(manager.hasActiveCall()).toBe(false);
    await manager.stopAll();
  });

  test("targets events and hangup by call ID when one conversation has multiple adapters", async () => {
    const conv = conversation();
    const server = fakeServer();
    const transports: FakeTransport[] = [];
    const emitters: Array<(event: RealtimeSidebandEvent) => void | Promise<void>> = [];
    const manager = new RealtimeCallManager(server.server as never, {
      createTransport: handler => {
        const transport = new FakeTransport();
        transports.push(transport);
        emitters.push(handler);
        return transport;
      },
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      persistTranscript: () => true,
      persistStatus: () => true,
    });

    const tui = await manager.start(conv.id);
    const discordAdapter = {
      type: "external" as const,
      id: "discord:paramount:voice-1",
      toolName: "discord",
      accountAlias: "paramount",
      endpointId: "voice-1",
    };
    const discord = await manager.start(conv.id, undefined, discordAdapter);
    await manager.attachMedia({} as never, conv.id, tui.callId, "v=0");
    await manager.attachMedia({} as never, conv.id, discord.callId, "v=0");

    await emitters[1]!({ type: "transcript_delta", role: "assistant", text: "Discord reply" });
    expect(server.subscriber.at(-1)).toMatchObject({
      type: "call_transcript",
      callId: discord.callId,
      adapter: discordAdapter,
    });
    await expect(manager.stop(conv.id)).rejects.toThrow("Multiple realtime calls");
    await manager.stop(conv.id, discord.callId);
    expect(transports[1]!.stopped).toBe(1);
    expect(transports[0]!.stopped).toBe(0);
    expect(manager.hasActiveCall()).toBe(true);
    await manager.stop(conv.id, tui.callId);
    expect(manager.hasActiveCall()).toBe(false);
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

  test("persists an explicit voice and reuses it for later calls", async () => {
    const conv = conversation();
    let savedVoice: RealtimeVoice = "cove";
    const saved: string[] = [];

    const makeManager = (transport: FakeTransport) => new RealtimeCallManager(fakeServer().server as never, {
      createTransport: () => transport,
      ensureAuthenticated: async () => {},
      getConversation: id => id === conv.id ? conv : undefined,
      getEffectiveInstructions: () => null,
      getAccountScope: () => null,
      getVoice: () => savedVoice,
      saveVoice: voice => {
        savedVoice = voice;
        saved.push(voice);
      },
      persistStatus: () => true,
    });

    const selectedTransport = new FakeTransport();
    const selectedManager = makeManager(selectedTransport);
    const selected = await selectedManager.start(conv.id, "sol");
    await selectedManager.attachMedia({} as never, conv.id, selected.callId, "v=0");
    expect(selectedTransport.starts[0]?.voice).toBe("sol");
    expect(saved).toEqual(["sol"]);
    await selectedManager.stop(conv.id, selected.callId);

    const reusedTransport = new FakeTransport();
    const reusedManager = makeManager(reusedTransport);
    const reused = await reusedManager.start(conv.id);
    await reusedManager.attachMedia({} as never, conv.id, reused.callId, "v=0");
    expect(reusedTransport.starts[0]?.voice).toBe("sol");
    expect(saved).toEqual(["sol"]);
    await reusedManager.stop(conv.id, reused.callId);
  });
});

describe("estimateRealtimeTokens", () => {
  test("keeps live metadata nonzero for spoken text", () => {
    expect(estimateRealtimeTokens("")).toBe(0);
    expect(estimateRealtimeTokens("One sec.")).toBeGreaterThan(0);
  });
});

describe("mergeCompletedTranscript", () => {
  test("retains a live prefix when interrupted turn.done contains only a suffix", () => {
    expect(mergeCompletedTranscript("Alright", ", no problem.")).toBe("Alright, no problem.");
    expect(mergeCompletedTranscript("Spoken ", "reply.")).toBe("Spoken reply.");
  });

  test("does not duplicate complete or overlapping turn.done snapshots", () => {
    expect(mergeCompletedTranscript("Lemme", "Lemme check.")).toBe("Lemme check.");
    expect(mergeCompletedTranscript("Spoken reply.", "Spoken reply")).toBe("Spoken reply.");
    expect(mergeCompletedTranscript("hello wor", "world")).toBe("hello world");
  });
});

describe("stripRepeatedInterruptedTranscript", () => {
  const previous = "Would be cool if you read the files and explain the project";

  test("strips a complete replay after a barge-in preamble", () => {
    expect(stripRepeatedInterruptedTranscript(
      previous,
      `Yo, sorry. Gimme a moment. ${previous}`,
    )).toBe("Yo, sorry. Gimme a moment.");
  });

  test("strips a complete replay before newly added words", () => {
    expect(stripRepeatedInterruptedTranscript(
      previous,
      `${previous}. Also check the tests.`,
    )).toBe("Also check the tests.");
  });

  test("does not remove short or embedded coincidental repetition", () => {
    expect(stripRepeatedInterruptedTranscript("check the files", "Please check the files")).toBe("Please check the files");
    expect(stripRepeatedInterruptedTranscript(
      previous,
      `I quoted: ${previous}, but that was only an example.`,
    )).toContain(previous);
  });
});
