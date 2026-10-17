import { describe, expect, test } from "bun:test";
import { browserOpenCommand, handleEvent, type DaemonActions } from "./events";
import { buildDiskSyncAssistantDiffPayload } from "./events/disk-sync-diagnostics";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, createPendingAI, type ConversationSummary, type FolderSummary } from "./messages";
import { createInitialState, isStreaming, canInterrupt, noteConversationOpenRequest, openFolderInstructionsDocument, resetDraftConversationState, type RenderState } from "./state";
import { buildMessageLines } from "./conversation";
import { getViewStartFor } from "./chatscroll";
import { requestVisibleToolOutputs } from "./events/tool-outputs";
import { subtractLoadedAssistantPrefix } from "./events/streaming-snapshot";
import { prepareConversationOpen } from "./conversationscroll";
import { beginConversationLoad, beginOptimisticConversation } from "./events/conversations";
import { bumpConversationToTop, focusConversationById, isOptimisticConversation } from "./sidebar";
import type { Event } from "./protocol";
import { createStartingBtw } from "./btw/state";
import { createGenerationThroughput, generationTokensPerSecond } from "@exocortex/shared/generation-throughput";

const daemon: DaemonActions = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

/** Mirror a presented frame: the viewport loader reads the last rendered rows. */
function presentHistory(state: RenderState, messageAreaHeight = 40): void {
  const rendered = buildMessageLines(state, state.cols);
  state.historyLines = rendered.lines;
  state.historyLineAnchors = rendered.lineAnchors;
  state.layout.totalLines = rendered.lines.length;
  state.layout.messageAreaHeight = messageAreaHeight;
}

describe("generation throughput events", () => {
  test("hydrates, updates, and preserves round samples through completion", () => {
    const state = createInitialState();
    state.convId = "throughput";
    const first = { provider: "openai" as const, model: "gpt-5.4", rates: [100] };
    handleEvent({
      type: "streaming_started", convId: state.convId, provider: "openai", model: "gpt-5.4",
      startedAt: 1_000, snapshotKind: "catchup", generationThroughput: first,
    }, state, daemon);
    expect(generationTokensPerSecond(state.pendingAI?.metadata?.generationThroughput)).toBe(100);
    const latest = { ...first, rates: [100, 200] };
    handleEvent({
      type: "tokens_update", convId: state.convId, tokens: 300, generationThroughput: latest,
    }, state, daemon);
    expect(generationTokensPerSecond(state.pendingAI?.metadata?.generationThroughput)).toBeCloseTo(155);
    handleEvent({
      type: "message_complete", convId: state.convId, endedAt: 3_600_000,
      blocks: [], tokens: 300, generationThroughput: latest,
    }, state, daemon);
    expect(state.pendingAI).toBeNull();
    expect(state.messages.at(-1)?.metadata?.generationThroughput).toEqual(latest);

    handleEvent({
      type: "streaming_started", convId: state.convId, provider: "openai", model: "gpt-5.4",
      startedAt: 4_000_000, snapshotKind: "start",
      generationThroughput: createGenerationThroughput("openai", "gpt-5.4"),
    }, state, daemon);
    expect(generationTokensPerSecond(state.pendingAI?.metadata?.generationThroughput)).toBe(0);
    handleEvent({
      type: "tokens_update", convId: state.convId, tokens: 500,
      generationThroughput: { ...first, rates: [500] },
    }, state, daemon);
    expect(generationTokensPerSecond(state.pendingAI?.metadata?.generationThroughput)).toBe(500);
    expect(state.messages.at(-1)?.metadata?.generationThroughput).toEqual(latest);
  });
});

describe("auth browser opener", () => {
  test("uses macOS open on Darwin", () => {
    expect(browserOpenCommand("https://example.com/auth", "darwin")).toEqual(["open", "https://example.com/auth"]);
  });

  test("uses xdg-open on Linux", () => {
    expect(browserOpenCommand("https://example.com/auth", "linux")).toEqual(["xdg-open", "https://example.com/auth"]);
  });

  test("uses cmd start on Windows", () => {
    expect(browserOpenCommand("https://example.com/auth", "win32")).toEqual(["cmd", "/c", "start", "", "https://example.com/auth"]);
  });
});

describe("ordinary turn handoff state", () => {
  test("Stop remains available for an active goal while the provider is suspended", () => {
    const state = createInitialState();
    state.convId = "sleeping-goal";
    state.goal = { objective: "wait then finish", status: "active", turns: 1, createdAt: 1, updatedAt: 1 };
    expect(isStreaming(state)).toBe(false);
    expect(canInterrupt(state)).toBe(true);
    state.goal.status = "paused";
    expect(canInterrupt(state)).toBe(false);
  });
  test("queues sends while the daemon hands off the focused conversation", () => {
    const state = createInitialState();
    state.convId = "conv-1";

    handleEvent({
      type: "conversation_updated",
      summary: summary({ streaming: true }),
    }, state, daemon);

    expect(state.pendingAI).toBeNull();
    expect(isStreaming(state)).toBe(true);

    handleEvent({
      type: "conversation_updated",
      summary: summary({ streaming: false }),
    }, state, daemon);
    expect(isStreaming(state)).toBe(false);
  });
});

describe("auth device code instructions", () => {
  test("starts by directing users to enable Codex device authorization", () => {
    const state = createInitialState();

    handleEvent({
      type: "auth_status",
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "CODE-1234",
        expiresInSeconds: 900,
      },
    }, state, daemon);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "system",
      text: [
        "OpenAI code authorization:",
        "1. Go to chatgpt.com > Settings > Security and login > Enable device authorization for Codex.",
        "2. Open https://auth.openai.com/codex/device in any browser and sign in.",
        "3. Enter this one-time code: CODE-1234",
        "The code expires in 15 minutes.",
        "Continue only if you started this login in Exocortex.",
      ].join("\n"),
    });
  });
});

describe("older-daemon compatibility", () => {
  test("ignores retired events and extra snapshot fields without policy-specific UI state", () => {
    const state = createInitialState();
    state.convId = "conv-tools";

    // Old wire frames are deliberately no longer part of the current Event schema.
    for (const reqId of [undefined, "tools-request"]) {
      handleEvent({
        type: "tool_policy",
        reqId,
        convId: state.convId,
        snapshot: { internal: [], external: [] },
        changed: true,
      } as unknown as Event, state, daemon);
    }
    handleEvent({
      type: "conversation_loaded",
      convId: "conv-tools",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [],
      contextTokens: 0,
      toolOutputsIncluded: false,
      toolPolicySnapshot: { internal: [], external: [] },
    } as unknown as Event, state, daemon);

    expect(state).not.toHaveProperty("pendingToolPolicyDraftId");
    expect(state).not.toHaveProperty("activeToolPolicy");
    expect(state.messages).toEqual([]);
  });
});

describe("retired call events", () => {
  test("ignores call events from an older daemon", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    const before = structuredClone({ messages: state.messages, pendingAI: state.pendingAI });

    for (const event of [
      { type: "call_state", convId: "conv-1", callId: "call-1", state: "live", message: "Realtime call started." },
      { type: "call_activity", convId: "conv-1", callId: "call-1", active: true },
      { type: "call_transcript", convId: "conv-1", callId: "call-1", role: "user", text: "hi", final: true, startedAt: 1, endedAt: 2, model: "gpt-live-1-boulder-alpha", tokens: 0 },
      { type: "call_sdp_answer", convId: "conv-1", callId: "call-1", sdp: "v=0" },
    ]) {
      expect(() => handleEvent(event as never, state, daemon)).not.toThrow();
    }

    expect({ messages: state.messages, pendingAI: state.pendingAI }).toEqual(before);
  });
});

describe("history_updated during a stream", () => {
  test("atomically replaces canonical history and the active stream tail", () => {
    const state = createInitialState();
    state.convId = "conv-call";
    state.pendingAI = {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "Reading documentation" },
        { type: "tool_call", toolCallId: "call-glob", toolName: "glob", input: {}, summary: "Glob docs/**" },
        { type: "tool_call", toolCallId: "call-read", toolName: "read", input: {}, summary: "Read README.md" },
      ],
      metadata: { startedAt: 1_000, endedAt: null, model: "gpt-5.6-sol", tokens: 20 },
    };

    handleEvent({
      type: "history_updated",
      convId: "conv-call",
      entries: [
        {
          type: "ai",
          blocks: [
            { type: "thinking", text: "Reading documentation" },
            { type: "tool_call", toolCallId: "call-glob", toolName: "glob", input: {}, summary: "Glob docs/**" },
          ],
          metadata: { startedAt: 1_000, endedAt: null, model: "gpt-5.6-sol", tokens: 10 },
        },
        {
          type: "user",
          text: "How long will this take?",
          metadata: {
            startedAt: 2_000,
            endedAt: 2_000,
            model: "gpt-5.6-sol",
            tokens: 0,
          },
        },
      ],
      pendingAI: {
        blocks: [
          { type: "tool_call", toolCallId: "call-read", toolName: "read", input: {}, summary: "Read README.md" },
        ],
        blockOffset: 2,
        metadata: { startedAt: 1_000, endedAt: null, model: "gpt-5.6-sol", tokens: 20 },
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    const displayedBlocks = [
      ...state.messages
        .filter(message => message.role === "assistant")
        .flatMap(message => message.blocks),
      ...(state.pendingAI?.blocks ?? []),
    ];
    expect(displayedBlocks.filter(block => block.type === "tool_call" && block.toolCallId === "call-glob")).toHaveLength(1);
    expect(displayedBlocks.filter(block => block.type === "tool_call" && block.toolCallId === "call-read")).toHaveLength(1);
    expect(state.pendingAIBlockOffset).toBe(2);
    expect(state.pendingAIPartialCommittedBlocks).toEqual([]);
  });
});

describe("conversation scroll restoration", () => {
  test("carries pre-load unread state into completed background conversation placement", () => {
    const state = createInitialState();
    state.convId = "current";
    state.layout.totalLines = 100;
    state.layout.messageAreaHeight = 20;
    state.scrollOffset = 40;
    state.sidebar.conversations = [
      summary({ id: "current" }),
      summary({ id: "background", unread: true, streaming: false }),
    ];

    prepareConversationOpen(state, "background");
    handleEvent({
      type: "conversation_loaded",
      convId: "background",
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "medium",
      fastMode: false,
      entries: [{
        type: "ai",
        blocks: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `answer ${index + 1}`).join("\n") }],
        metadata: null,
      }],
      contextTokens: 100,
      toolOutputsIncluded: false,
      hasOlderHistory: true,
    }, state, daemon);

    expect(state.conversationScroll.positions.get("current")).toBe(0.5);
    expect(state.conversationScroll.pendingRestore).toEqual({
      convId: "background",
      mode: "unread-response",
      waitForInitialBackfill: false,
    });
  });
});

describe("remote conversation open placeholder", () => {
  const loaded = (convId: string, text = "answer"): Extract<Event, { type: "conversation_loaded" }> => ({
    type: "conversation_loaded",
    convId,
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    entries: [{ type: "ai", blocks: [{ type: "text", text }], metadata: null }],
    contextTokens: 100,
    toolOutputsIncluded: false,
  });

  function openedState(): { state: RenderState; unsubscribed: string[]; actions: DaemonActions } {
    const state = createInitialState();
    state.convId = "current";
    state.messages = [{ role: "system", text: "old transcript", metadata: null }];
    state.sidebar.conversations = [
      summary({ id: "current" }),
      summary({ id: "target", title: "Remote chat", model: "gpt-5.4", effort: "low" }),
      summary({ id: "other" }),
    ];
    const unsubscribed: string[] = [];
    return { state, unsubscribed, actions: { ...daemon, unsubscribe: convId => unsubscribed.push(convId) } };
  }

  test("switches to the chat immediately and shows a loading spinner", () => {
    const { state, unsubscribed, actions } = openedState();

    prepareConversationOpen(state, "target");
    beginConversationLoad(state, "target", actions);

    expect(state.convId).toBe("target");
    expect(state.messages).toEqual([]);
    expect(state.model).toBe("gpt-5.4");
    expect(state.effort).toBe("low");
    expect(state.contextTokens).toBeNull();
    expect(unsubscribed).toEqual(["current"]);
    expect(state.sidebar.previousEnteredId).toBe("current");
    const lines = buildMessageLines(state, 80).lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(lines).toEqual([expect.stringMatching(/^  . Loading conversation\.\.\.$/)]);
  });

  test("replaces the spinner with the loaded transcript as a fresh open", () => {
    const { state, actions } = openedState();
    state.conversationScroll.positions.set("target", 0.25);
    prepareConversationOpen(state, "target");
    beginConversationLoad(state, "target", actions);
    presentHistory(state, 20);

    handleEvent({ ...loaded("target"), hasOlderHistory: true }, state, actions);

    expect(state.conversationLoading).toBeNull();
    expect(buildMessageLines(state, 80).lines.join("\n")).not.toContain("Loading conversation");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant" });
    // The placeholder's one-line layout must not overwrite the remembered position.
    expect(state.conversationScroll.pendingRestore).toMatchObject({ convId: "target", mode: "percentage", percentage: 0.25 });
  });

  test("keeps the sidebar cursor where the user moved it during the load", () => {
    const { state, actions } = openedState();
    beginConversationLoad(state, "target", actions);
    expect(state.sidebar.selectedId).toBe("target");

    focusConversationById(state.sidebar, "other");
    handleEvent(loaded("target"), state, actions);

    expect(state.convId).toBe("target");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "other" });
    expect(state.sidebar.selectedId).toBe("other");
  });

  test("drops an earlier in-flight open after switching again", () => {
    const { state, unsubscribed, actions } = openedState();
    beginConversationLoad(state, "other", actions);
    beginConversationLoad(state, "target", actions);
    expect(unsubscribed).toEqual(["current", "other"]);

    handleEvent(loaded("other", "stale"), state, actions);
    expect(state.convId).toBe("target");
    expect(state.messages).toEqual([]);
    expect(state.conversationLoading?.convId).toBe("target");

    handleEvent(loaded("target", "fresh"), state, actions);
    expect(state.convId).toBe("target");
    expect(state.conversationLoading).toBeNull();
    expect(unsubscribed).toEqual(["current", "other"]);
  });

  test("a late remote load does not yank the user out of a new draft", () => {
    const { state, unsubscribed, actions } = openedState();
    beginConversationLoad(state, "target", actions);
    noteConversationOpenRequest(state, "target", "conversation_1");
    resetDraftConversationState(state);

    handleEvent({ ...loaded("target"), reqId: "conversation_1" }, state, actions);

    expect(state.convId).toBeNull();
    expect(state.messages.some(message => message.role === "assistant")).toBe(false);
    expect(unsubscribed).toEqual(["current", "target"]);
  });

  test("a late local load does not yank the user out of the folder-instructions editor", () => {
    const { state, actions } = openedState();
    // Local opens keep the previous conversation until the load lands.
    noteConversationOpenRequest(state, "target", "conversation_1");
    openFolderInstructionsDocument(state, "folder-1");

    handleEvent({ ...loaded("target"), reqId: "conversation_1" }, state, actions);

    expect(state.convId).toBeNull();
    expect(state.folderInstructionsDoc?.folderId).toBe("folder-1");
  });

  test("a reconnect-replayed open queued before /new is not applied", () => {
    const { state, unsubscribed, actions } = openedState();
    // Opened while disconnected: the load sits in the offline queue.
    beginConversationLoad(state, "target", actions);
    noteConversationOpenRequest(state, "target", "conversation_1");
    resetDraftConversationState(state);
    // The replayed load answers after reconnect.
    handleEvent({ ...loaded("target"), reqId: "conversation_1" }, state, actions);

    expect(state.convId).toBeNull();
    expect(unsubscribed.at(-1)).toBe("target");
  });

  test("a local open still navigates when it answers the latest request", () => {
    const { state, unsubscribed, actions } = openedState();
    noteConversationOpenRequest(state, "other", "conversation_1");
    noteConversationOpenRequest(state, "target", "conversation_2");

    handleEvent({ ...loaded("other"), reqId: "conversation_1" }, state, actions);
    expect(state.convId).toBe("current");
    expect(unsubscribed).toEqual(["other"]);

    handleEvent({ ...loaded("target"), reqId: "conversation_2" }, state, actions);
    expect(state.convId).toBe("target");
  });

  test("a superseded load keeps the subscription a newer open of the same conversation needs", () => {
    const { state, unsubscribed, actions } = openedState();
    noteConversationOpenRequest(state, "target", "conversation_1");
    noteConversationOpenRequest(state, "target", "conversation_2");

    handleEvent({ ...loaded("target"), reqId: "conversation_1" }, state, actions);

    expect(state.convId).toBe("current");
    expect(unsubscribed).toEqual([]);
  });

  test("stops the spinner when the load fails", () => {
    const { state, actions } = openedState();
    beginConversationLoad(state, "target", actions);

    handleEvent({ type: "error", reqId: "conversation_1", convId: "target", message: "Conversation target not found" }, state, actions);

    expect(state.conversationLoading).toBeNull();
    expect(buildMessageLines(state, 80).lines.join("\n")).not.toContain("Loading conversation");
  });
});

describe("usage reset results", () => {
  test("reports a successful reset and remaining balance", () => {
    const state = createInitialState();
    handleEvent({
      type: "usage_reset_result",
      provider: "openai",
      outcome: "reset",
      windowsReset: 2,
      remainingResets: 3,
    }, state, daemon);

    expect(state.messages.at(-1)).toMatchObject({
      role: "system",
      text: "Usage reset. You have 3 usage resets left.",
    });
  });

  test("reports when there is no eligible window to reset", () => {
    const state = createInitialState();
    handleEvent({
      type: "usage_reset_result",
      provider: "openai",
      outcome: "nothing_to_reset",
      windowsReset: 0,
    }, state, daemon);

    expect(state.messages.at(-1)).toMatchObject({
      role: "system",
      text: "Your usage does not need a reset right now.",
    });
  });
});

describe("daemon queue synchronization", () => {
  test("replaces queue shadows from the shared snapshot while retaining unsent voice placeholders", () => {
    const state = createInitialState();
    state.queuedMessages = [
      { id: "stale", convId: "conv-1", text: "stale", timing: "message-end", source: "daemon", createdAt: 1 },
      { convId: "conv-1", text: "Transcribing…", timing: "message-end" },
    ];

    handleEvent({
      type: "queue_updated",
      messages: [{
        id: "shared",
        convId: "conv-2",
        text: "from another client",
        timing: "next-turn",
        source: "daemon",
        createdAt: 2,
        automation: { kind: "chrono_wake", sourceId: "chrono:test" },
      }],
    }, state, daemon);

    expect(state.queuedMessages).toEqual([
      {
        id: "shared",
        convId: "conv-2",
        text: "from another client",
        timing: "next-turn",
        source: "daemon",
        createdAt: 2,
        automation: { kind: "chrono_wake", sourceId: "chrono:test" },
      },
      { convId: "conv-1", text: "Transcribing…", timing: "message-end" },
    ]);
  });

  test("keeps unrelated optimistic entries until the daemon settles their ids", () => {
    const state = createInitialState();
    state.queuedMessages = [{ id: "optimistic", optimistic: true, convId: "conv-1", text: "pending", timing: "message-end", source: "daemon", createdAt: 1 }];

    handleEvent({ type: "queue_updated", messages: [] }, state, daemon);
    expect(state.queuedMessages).toHaveLength(1);

    handleEvent({ type: "queue_updated", messages: [], settledQueueIds: ["optimistic"] }, state, daemon);
    expect(state.queuedMessages).toEqual([]);
  });

  test("does not reintroduce an optimistically removed entry before its command settles", () => {
    const state = createInitialState();
    state.pendingQueueRemovalIds.add("removing");
    const canonical = {
      id: "removing", convId: "conv-1", text: "remove me", timing: "message-end" as const,
      source: "daemon" as const, createdAt: 1,
    };

    handleEvent({ type: "queue_updated", messages: [canonical] }, state, daemon);
    expect(state.queuedMessages).toEqual([]);

    // An enqueue replay can settle this id while it remains canonical; that must
    // not expose the entry or clear the later unqueue tombstone.
    handleEvent({ type: "queue_updated", messages: [canonical], settledQueueIds: ["removing"] }, state, daemon);
    expect(state.queuedMessages).toEqual([]);
    expect(state.pendingQueueRemovalIds.has("removing")).toBe(true);

    handleEvent({ type: "queue_updated", messages: [], settledQueueIds: ["removing"] }, state, daemon);
    expect(state.pendingQueueRemovalIds.size).toBe(0);
  });
});

describe("rejected queue and BTW requests", () => {
  test("a rejected enqueue drops its optimistic row instead of waiting forever", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.queuedMessages = [
      { id: "bad", optimistic: true, convId: "conv-1", text: "never", timing: "message-end", source: "daemon", createdAt: 1 },
      { id: "good", optimistic: true, convId: "conv-1", text: "fine", timing: "message-end", source: "daemon", createdAt: 2 },
    ];

    handleEvent({ type: "error", reqId: "queue_message:bad", convId: "conv-1", message: "Invalid queue timing" }, state, daemon);

    expect(state.queuedMessages.map(message => message.id)).toEqual(["good"]);
    expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "✗ Invalid queue timing" });
  });

  test("a rejected enqueue for a background conversation is still reported", () => {
    const state = createInitialState();
    state.convId = "open";
    state.queuedMessages = [{ id: "bad", optimistic: true, convId: "other", text: "never", timing: "message-end", source: "global-idle", createdAt: 1 }];

    handleEvent({ type: "error", reqId: "queue_message:bad", convId: "other", message: "boom" }, state, daemon);

    expect(state.queuedMessages).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "✗ Could not queue message: boom" });
  });

  test("a rejected unqueue lifts its tombstone so the canonical entry shows again", () => {
    const state = createInitialState();
    state.pendingQueueRemovalIds.add("keep");
    const canonical = { id: "keep", convId: "conv-1", text: "still queued", timing: "message-end" as const, source: "daemon" as const, createdAt: 1 };

    handleEvent({ type: "error", reqId: "unqueue_message:keep", message: "boom" }, state, daemon);
    handleEvent({ type: "queue_updated", messages: [canonical] }, state, daemon);

    expect(state.queuedMessages.map(message => message.id)).toEqual(["keep"]);
  });

  test("a rejected BTW query ends its starting panel turn", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.btw = createStartingBtw("conv-1", "btw-1", "question", "openai", "gpt-5.5", 100);

    handleEvent({ type: "error", reqId: "btw:query:btw-1:btw-1", convId: "conv-1", message: "boom" }, state, daemon);

    expect(state.btw?.phase).toBe("error");
    expect(state.btw?.status).toBe("boom");
  });
});

describe("paged conversation history events", () => {
  test("prepends a matching older page and advances the absolute rewind cursor", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages = [
      { role: "system_instructions", text: "rules", metadata: null },
      { role: "user", text: "u3", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "a3" }], metadata: null },
    ];
    state.historyStartIndex = 4;
    state.historyStartUserIndex = 2;
    state.historyTotalEntries = 6;
    state.historyHasOlder = true;
    state.historyLoadingOlder = true;
    state.historyLoadingStartedAt = 100;
    state.historyLoadingRequestId = "history-1";
    state.conversationScroll.pendingRestore = {
      convId: "conv-1",
      mode: "percentage",
      percentage: 0.25,
      waitForInitialBackfill: true,
    };
    state.deferredHistoryRender = {
      convId: "conv-1",
      width: 80,
      startMessageIndex: 1,
      generation: 1,
      complete: false,
    };
    state.layout.messageAreaHeight = 20;
    state.historyLines = ["cached visible bottom"];

    handleEvent({
      type: "conversation_history_loaded",
      reqId: "history-1",
      convId: "conv-1",
      requestSource: "initial-backfill",
      entries: [
        { type: "user", text: "u1" },
        { type: "ai", blocks: [{ type: "text", text: "a1" }], metadata: null },
        { type: "user", text: "u2" },
        { type: "ai", blocks: [{ type: "text", text: "a2" }], metadata: null },
      ],
      historyStartIndex: 0,
      historyStartUserIndex: 0,
      historyEndIndex: 4,
      historyTotalEntries: 6,
      hasOlderHistory: false,
    }, state, daemon);

    expect(state.messages.map((message) => message.role === "user" ? message.text : message.role)).toEqual([
      "system_instructions", "u1", "assistant", "u2", "assistant", "u3", "assistant",
    ]);
    expect(state.historyStartIndex).toBe(0);
    expect(state.historyStartUserIndex).toBe(0);
    expect(state.historyHasOlder).toBe(false);
    expect(state.historyLoadingOlder).toBe(false);
    expect(state.deferredHistoryRender).toBeNull();
    expect(state.conversationScroll.pendingRestore?.waitForInitialBackfill).toBe(false);
    // Bottom-anchored initial expansion skips the old/new double history reflow;
    // the normal render scheduled by main.ts replaces this cache afterward.
    expect(state.historyLines).toEqual(["cached visible bottom"]);
  });

  test("ignores a stale page without clearing the newer in-flight request", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyStartIndex = 20;
    state.historyStartUserIndex = 10;
    state.historyTotalEntries = 40;
    state.historyHasOlder = true;
    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = "history-new";

    handleEvent({
      type: "conversation_history_loaded",
      reqId: "history-old",
      convId: "conv-1",
      entries: [{ type: "user", text: "stale" }],
      historyStartIndex: 10,
      historyStartUserIndex: 5,
      historyEndIndex: 20,
      historyTotalEntries: 40,
      hasOlderHistory: true,
    }, state, daemon);

    expect(state.messages).toEqual([]);
    expect(state.historyLoadingOlder).toBe(true);
    expect(state.historyLoadingRequestId).toBe("history-new");
  });

  test("releases a saved-position restore when its matching initial page is superseded", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyStartIndex = 20;
    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = "history-initial";
    state.conversationScroll.pendingRestore = {
      convId: "conv-1",
      mode: "percentage",
      percentage: 0.25,
      waitForInitialBackfill: true,
    };

    handleEvent({
      type: "conversation_history_loaded",
      reqId: "history-initial",
      convId: "conv-1",
      requestSource: "initial-backfill",
      entries: [{ type: "user", text: "stale" }],
      historyStartIndex: 10,
      historyStartUserIndex: 5,
      historyEndIndex: 15,
      historyTotalEntries: 40,
      hasOlderHistory: true,
    }, state, daemon);

    expect(state.messages).toEqual([]);
    expect(state.historyLoadingOlder).toBe(false);
    expect(state.historyLoadingRequestId).toBeNull();
    expect(state.conversationScroll.pendingRestore?.waitForInitialBackfill).toBe(false);
  });

  test("releases a saved-position restore when the initial page request fails", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = "history-initial";
    state.conversationScroll.pendingRestore = {
      convId: "conv-1",
      mode: "percentage",
      percentage: 0.25,
      waitForInitialBackfill: true,
    };

    handleEvent({
      type: "error",
      reqId: "history-initial",
      convId: "conv-1",
      message: "history failed",
    }, state, daemon);

    expect(state.historyLoadingOlder).toBe(false);
    expect(state.historyLoadingRequestId).toBeNull();
    expect(state.conversationScroll.pendingRestore?.waitForInitialBackfill).toBe(false);
  });

  test("fetches only the omitted body of a prepended page while expanded", () => {
    const requests: Array<{ convId: string; toolCallIds?: string[] }> = [];
    const localDaemon: DaemonActions = {
      ...daemon,
      loadToolOutputs(convId, toolCallIds) { requests.push({ convId, toolCallIds }); },
    };
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.messages = [{
      role: "assistant",
      blocks: [{ type: "tool_result", toolCallId: "newer-call", toolName: "bash", output: "already loaded", isError: false }],
      metadata: null,
    }];
    state.historyStartIndex = 1;
    state.historyStartUserIndex = 1;
    state.historyTotalEntries = 2;
    state.historyHasOlder = true;
    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = "history-tools";

    handleEvent({
      type: "conversation_history_loaded",
      reqId: "history-tools",
      convId: "conv-1",
      entries: [{
        type: "ai",
        blocks: [{ type: "tool_result", toolCallId: "older-call", toolName: "", output: "", isError: false }],
        metadata: null,
      }],
      historyStartIndex: 0,
      historyStartUserIndex: 0,
      historyEndIndex: 1,
      historyTotalEntries: 2,
      hasOlderHistory: false,
    }, state, localDaemon);

    expect(requests).toEqual([]);
    presentHistory(state);
    requestVisibleToolOutputs(state, localDaemon);
    expect(requests).toEqual([{ convId: "conv-1", toolCallIds: ["older-call"] }]);
    expect(state.toolOutputsLoading).toBe(true);

    // The in-flight request gates the per-frame loader.
    requestVisibleToolOutputs(state, localDaemon);
    expect(requests).toHaveLength(1);
  });

  test("keeps already-loaded older entries across a non-destructive canonical update", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages = [
      { role: "user", text: "u1", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "a1" }], metadata: null },
      { role: "user", text: "u2 old", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "a2 old" }], metadata: null },
      { role: "user", text: "u3 old", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "a3 old" }], metadata: null },
    ];
    state.historyStartIndex = 0;
    state.historyStartUserIndex = 0;
    state.historyTotalEntries = 6;

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [
        { type: "user", text: "u2 canonical" },
        { type: "ai", blocks: [{ type: "text", text: "a2 canonical" }], metadata: null },
        { type: "user", text: "u3 canonical" },
        { type: "ai", blocks: [{ type: "text", text: "a3 canonical" }], metadata: null },
      ],
      historyStartIndex: 2,
      historyStartUserIndex: 1,
      historyTotalEntries: 6,
      hasOlderHistory: true,
      contextTokens: 10,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.messages.map((message) => message.role === "user"
      ? message.text
      : message.role === "assistant" ? message.blocks[0]?.type === "text" && message.blocks[0].text : message.role))
      .toEqual(["u1", "a1", "u2 canonical", "a2 canonical", "u3 canonical", "a3 canonical"]);
    expect(state.historyStartIndex).toBe(0);
    expect(state.historyStartUserIndex).toBe(0);
  });

  test("joins an older page's leading AI blocks onto the partially loaded entry", () => {
    const text = (value: string) => ({ type: "text" as const, text: value });
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages = [{ role: "assistant", blocks: [text("c"), text("d")], metadata: null }];
    state.historyStartIndex = 3;
    state.historyStartBlockIndex = 2;
    state.historyStartUserIndex = 2;
    state.historyHasOlder = true;
    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = "history-1";

    const page = {
      type: "conversation_history_loaded" as const,
      reqId: "history-1",
      convId: "conv-1",
      entries: [
        { type: "user" as const, text: "u2" },
        { type: "ai" as const, blocks: [text("a"), text("b")], metadata: null },
      ],
      historyStartIndex: 2,
      historyStartUserIndex: 1,
      historyEndIndex: 3,
      historyTotalEntries: 4,
      hasOlderHistory: true,
    };
    // A page that does not end at the loaded block cursor is stale.
    handleEvent(page, state, daemon);
    expect(state.messages).toHaveLength(1);

    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = "history-1";
    handleEvent({ ...page, historyEndBlockIndex: 2 }, state, daemon);

    expect(state.messages.map((message) => message.role === "assistant"
      ? message.blocks.map((block) => block.type === "text" ? block.text : block.type).join("")
      : message.role === "user" ? message.text : message.role)).toEqual(["u2", "abcd"]);
    expect([state.historyStartIndex, state.historyStartBlockIndex, state.historyStartUserIndex]).toEqual([2, 0, 1]);
  });

  test("subtracts persisted rounds from live blocks when the window starts inside the active entry", () => {
    const call = (id: string) => ({ type: "tool_call" as const, toolCallId: id, toolName: "Bash", input: {}, summary: "" });
    const result = (id: string) => ({ type: "tool_result" as const, toolCallId: id, toolName: "Bash", output: "", isError: false });
    const local = [
      { type: "text" as const, text: "a" }, call("1"), result("1"),
      { type: "text" as const, text: "b" }, call("2"), result("2"),
      { type: "text" as const, text: "live" },
    ];
    const tail = { type: "ai" as const, blocks: local.slice(3, 6), metadata: null };

    expect(subtractLoadedAssistantPrefix(local, [tail], 3)).toEqual([{ type: "text", text: "live" }]);
    expect(subtractLoadedAssistantPrefix(local, [{ ...tail, blocks: local.slice(0, 6) }])).toEqual([{ type: "text", text: "live" }]);
    // A tail that does not line up with the live blocks leaves them untouched.
    expect(subtractLoadedAssistantPrefix(local, [tail], 2)).toEqual(local);
  });

  test("keeps loaded leading blocks when a canonical update starts inside that AI entry", () => {
    const text = (value: string) => ({ type: "text" as const, text: value });
    const refresh = {
      type: "history_updated" as const,
      convId: "conv-1",
      entries: [{ type: "ai" as const, blocks: [text("c"), text("d"), text("e")], metadata: null }],
      historyStartIndex: 1,
      historyStartBlockIndex: 2,
      historyStartUserIndex: 1,
      historyTotalEntries: 2,
      hasOlderHistory: true,
      contextTokens: 10,
      toolOutputsIncluded: false,
    };
    const joined = (state: RenderState) => state.messages.map((message) => message.role === "assistant"
      ? message.blocks.map((block) => block.type === "text" ? block.text : block.type).join("")
      : message.role === "user" ? message.text : message.role);

    const state = createInitialState();
    state.convId = "conv-1";
    state.messages = [
      { role: "user", text: "u1", metadata: null },
      { role: "assistant", blocks: [text("a"), text("b"), text("c")], metadata: null },
    ];
    handleEvent(refresh, state, daemon);
    expect(joined(state)).toEqual(["u1", "abcde"]);
    expect([state.historyStartIndex, state.historyStartBlockIndex]).toEqual([0, 0]);

    // Without the leading blocks locally, adopt the refresh's own window.
    const partial = createInitialState();
    partial.convId = "conv-1";
    partial.messages = [{ role: "assistant", blocks: [text("a")], metadata: null }];
    partial.historyStartIndex = 1;
    handleEvent(refresh, partial, daemon);
    expect(joined(partial)).toEqual(["cde"]);
    expect([partial.historyStartIndex, partial.historyStartBlockIndex, partial.historyHasOlder]).toEqual([1, 2, true]);
  });

  test("history refresh keeps the canonical copy of a locally echoed direct turn", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages = [
      {
        role: "user",
        text: "older",
        metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.5", tokens: 0 },
      },
      {
        role: "user",
        text: "join call",
        metadata: { startedAt: 2, endedAt: 2, model: "gpt-5.5", tokens: 0 },
      },
    ];
    state.historyStartIndex = 0;
    state.historyStartUserIndex = 0;
    state.historyTotalEntries = 2;

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{
        type: "user",
        text: "join call",
        metadata: { startedAt: 2, endedAt: 2, model: "gpt-5.5", tokens: 9 },
      }],
      historyStartIndex: 2,
      historyStartUserIndex: 1,
      historyTotalEntries: 3,
      hasOlderHistory: true,
      contextTokens: 10,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.messages.map(message => message.role === "user" && message.text)).toEqual(["older", "join call"]);
    expect(state.messages[1]?.metadata?.tokens).toBe(9);
  });

  test("drops invalid ranges and resets scroll after a destructive canonical rewrite", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages = [{ role: "user", text: "removed old turn", metadata: null }];
    state.historyStartIndex = 0;
    state.historyHasOlder = false;
    state.scrollOffset = 50;

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "user", text: "remaining" }],
      historyStartIndex: 4,
      historyStartUserIndex: 2,
      historyTotalEntries: 5,
      hasOlderHistory: true,
      resetHistoryWindow: true,
      contextTokens: 10,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.messages).toMatchObject([{ role: "user", text: "remaining" }]);
    expect(state.historyStartIndex).toBe(4);
    expect(state.scrollOffset).toBe(0);
  });
});

describe("context compaction status events", () => {
  test("replaces the spinner with a retained marker below completed assistant content", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.pendingAI = createPendingAI(100, state.model);
    state.pendingAI.blocks.push({ type: "text", text: "work before compaction" });

    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: true,
      startedAt: 123,
    }, state, daemon);
    expect(state.contextCompactionStartedAt).toBe(123);

    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: false,
      completedAt: 456,
    }, state, daemon);
    expect(state.contextCompactionStartedAt).toBeNull();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [{ type: "text", text: "work before compaction" }],
    });
    expect(state.messages[1]).toMatchObject({
      role: "system",
      text: CONTEXT_COMPACTION_FINISHED_TEXT,
      metadata: {
        startedAt: 456,
        endedAt: 456,
        kind: CONTEXT_COMPACTION_FINISHED_KIND,
      },
    });
    expect(state.pendingAI?.blocks).toEqual([]);
    expect(state.suppressPendingAIMetadataStartedAt).toBe(100);

    // A same-conversation refresh can load the durable marker just before the
    // matching completion event; do not retain it twice.
    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: false,
      completedAt: 456,
    }, state, daemon);
    expect(state.messages.filter((message) => message.role === "system")).toHaveLength(1);
  });

  test("immediately locks user messages represented by a completed compaction", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "user",
      text: "now represented",
      metadata: null,
      contextCheckpoint: { contextTokens: 123_000, editable: true },
    });

    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: false,
      completedAt: 456,
    }, state, daemon);

    expect(state.messages[0]).toMatchObject({
      role: "user",
      contextCheckpoint: { contextTokens: 123_000, editable: false },
    });
  });
});

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv-1",
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    title: "Existing chat",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 1,
    ...overrides,
  };
}

describe("conversation creation sidebar selection", () => {
  for (const panelFocus of ["chat", "sidebar"] as const) {
    test(`selects the created conversation while ${panelFocus} is focused`, () => {
      const state = createInitialState();
      state.panelFocus = panelFocus;
      state.sidebar.open = true;
      state.sidebar.conversations = [summary({ id: "old-conv" })];
      state.sidebar.selectedItem = { type: "conversation", id: "old-conv" };
      state.sidebar.selectedId = "old-conv";

      handleEvent({
        type: "conversation_created",
        convId: "new-conv",
        provider: "openai",
        model: "gpt-5.5",
        effort: "high",
        fastMode: false,
      }, state, daemon);
      handleEvent({
        type: "conversation_updated",
        summary: summary({ id: "new-conv", title: "New chat", sortOrder: 2 }),
      }, state, daemon);

      expect(state.panelFocus).toBe(panelFocus);
      expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "new-conv" });
      expect(state.sidebar.selectedId).toBe("new-conv");
      expect(state.sidebar.pendingFocusItem).toBeNull();
    });
  }
});

describe("optimistic conversation creation", () => {
  function folder(id: string, parentId: string | null = null): FolderSummary {
    return { id, name: id, parentId, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 0 };
  }

  function recordingDaemon(): { actions: DaemonActions; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      actions: {
        ...daemon,
        subscribe(convId) { calls.push(`subscribe:${convId}`); },
        unsubscribe(convId) { calls.push(`unsubscribe:${convId}`); },
      },
    };
  }

  /** A draft in folder "work" whose first message was just sent as "new-conv". */
  function sentDraft(): RenderState {
    const state = createInitialState();
    state.sidebar.open = true;
    state.sidebar.folders = [folder("work"), folder("other")];
    state.sidebar.conversations = [
      summary({ id: "work-chat", folderId: "work", sortOrder: -2 }),
      summary({ id: "other-chat", folderId: "other", sortOrder: -1 }),
    ];
    state.sidebar.currentFolderId = "other";
    state.sidebar.selectedItem = { type: "conversation", id: "other-chat" };
    state.pendingAI = createPendingAI(1_000, "gpt-5.5");
    beginOptimisticConversation(state, {
      convId: "new-conv", provider: "openai", model: "gpt-5.5", effort: "high", fastMode: false,
      folderId: "work", title: "pending",
    });
    return state;
  }

  test("opens and focuses the conversation at the top of its folder before the daemon answers", () => {
    const state = sentDraft();

    expect(state.convId).toBe("new-conv");
    expect(state.sidebar.currentFolderId).toBe("work");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "new-conv" });
    const row = state.sidebar.conversations.find(conv => conv.id === "new-conv")!;
    expect(row).toMatchObject({ folderId: "work", streaming: true, sortOrder: -3 });
    expect(isOptimisticConversation(state.sidebar, "new-conv")).toBe(true);
  });

  test("acceptance adopts settings without moving the cursor the user moved", () => {
    const state = sentDraft();
    const { actions, calls } = recordingDaemon();
    // The user browses back to another folder while creation crosses the network.
    focusConversationById(state.sidebar, "other-chat");

    handleEvent({ type: "conversation_created", convId: "new-conv", provider: "openai", model: "gpt-5.5", effort: "xhigh", fastMode: false }, state, actions);
    expect(state.effort).toBe("xhigh");
    handleEvent({ type: "conversation_updated", summary: summary({ id: "new-conv", folderId: "work", sortOrder: -3, streaming: true }) }, state, actions);

    expect(state.convId).toBe("new-conv");
    expect(state.sidebar.currentFolderId).toBe("other");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "other-chat" });
    expect(isOptimisticConversation(state.sidebar, "new-conv")).toBe(false);
    expect(state.sidebar.conversations.filter(conv => conv.id === "new-conv")).toHaveLength(1);
    expect(calls).toEqual(["subscribe:new-conv"]);
  });

  test("acceptance after the user opened another conversation does not navigate back", () => {
    const state = sentDraft();
    const { actions, calls } = recordingDaemon();
    beginConversationLoad(state, "other-chat", actions);
    calls.length = 0;

    handleEvent({ type: "conversation_created", convId: "new-conv", provider: "openai", model: "gpt-5.5", effort: "high", fastMode: false }, state, actions);
    handleEvent({ type: "conversation_updated", summary: summary({ id: "new-conv", folderId: "work", sortOrder: -3, streaming: true }) }, state, actions);

    expect(state.convId).toBe("other-chat");
    expect(state.sidebar.currentFolderId).toBe("other");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "other-chat" });
    expect(calls).toEqual(["unsubscribe:new-conv"]);
  });

  test("a conversation created by another flow never replaces an open conversation", () => {
    const state = createInitialState();
    state.convId = "open-conv";
    state.sidebar.conversations = [summary({ id: "open-conv" })];
    state.sidebar.selectedItem = { type: "conversation", id: "open-conv" };
    const { actions, calls } = recordingDaemon();

    handleEvent({ type: "conversation_created", convId: "background", provider: "openai", model: "gpt-5.5", effort: "high", fastMode: false }, state, actions);
    handleEvent({ type: "conversation_updated", summary: summary({ id: "background", sortOrder: -1 }) }, state, actions);

    expect(state.convId).toBe("open-conv");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "open-conv" });
    expect(calls).toEqual(["unsubscribe:background"]);
  });

  test("a list sent before the daemon processed the creation keeps the row and the open view", () => {
    const state = sentDraft();
    const listed = state.sidebar.conversations.filter(conv => conv.id !== "new-conv");

    handleEvent({ type: "conversations_list", conversations: listed, folders: state.sidebar.folders }, state, daemon);

    expect(state.convId).toBe("new-conv");
    expect(state.sidebar.conversations.map(conv => conv.id)).toContain("new-conv");
    expect(isOptimisticConversation(state.sidebar, "new-conv")).toBe(true);

    handleEvent({ type: "conversations_list", conversations: [...listed, summary({ id: "new-conv", folderId: "work", sortOrder: -3 })], folders: state.sidebar.folders }, state, daemon);
    expect(isOptimisticConversation(state.sidebar, "new-conv")).toBe(false);
  });

  test("a rejected creation reports the error and returns to the draft", () => {
    const state = sentDraft();

    handleEvent({ type: "error", convId: "new-conv", message: "Not authenticated for provider openai." }, state, daemon);

    expect(state.convId).toBeNull();
    expect(state.pendingAI).toBeNull();
    expect(state.sidebar.conversations.map(conv => conv.id)).not.toContain("new-conv");
    expect(state.sidebar.selectedItem?.type).toBe("conversation");
    expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "✗ Not authenticated for provider openai." });
  });

  test("a creation rejected after the user left it is still reported", () => {
    const state = sentDraft();
    beginConversationLoad(state, "other-chat", daemon);

    handleEvent({ type: "error", convId: "new-conv", message: "Unknown provider: nope" }, state, daemon);

    expect(state.convId).toBe("other-chat");
    expect(state.sidebar.conversations.map(conv => conv.id)).not.toContain("new-conv");
    expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "✗ Could not create conversation: Unknown provider: nope" });
  });
});

describe("optimistic reordering on send", () => {
  test("moves an unpinned conversation to the top of its folder and keeps it selected", () => {
    const sidebar = createInitialState().sidebar;
    sidebar.conversations = [
      summary({ id: "top", folderId: "work", sortOrder: -5 }),
      summary({ id: "sent", folderId: "work", sortOrder: -1 }),
      summary({ id: "root", folderId: null, sortOrder: -9 }),
    ];
    focusConversationById(sidebar, "sent");

    expect(bumpConversationToTop(sidebar, "sent")).toBe(true);

    expect(sidebar.conversations.find(conv => conv.id === "sent")?.sortOrder).toBe(-6);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "sent" });
    expect(bumpConversationToTop(sidebar, "sent")).toBe(false);
  });

  test("leaves pinned conversations in place, as the daemon does", () => {
    const sidebar = createInitialState().sidebar;
    sidebar.conversations = [summary({ id: "pinned", pinned: true, sortOrder: 3 }), summary({ id: "other", sortOrder: -1 })];

    expect(bumpConversationToTop(sidebar, "pinned")).toBe(false);
    expect(sidebar.conversations.find(conv => conv.id === "pinned")?.sortOrder).toBe(3);
  });
});

describe("disk sync assistant diagnostics", () => {
  function assistantBlocks(state: ReturnType<typeof createInitialState>) {
    return state.messages.flatMap((msg) => msg.role === "assistant" ? msg.blocks : []);
  }

  test("reports when a same-conversation disk sync changes visible assistant text", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [{ type: "text", text: "local answer" }],
      metadata: null,
    });

    const payload = buildDiskSyncAssistantDiffPayload("conversation_loaded", "conv-1", state, {
      entries: [{ type: "ai", blocks: [{ type: "text", text: "disk answer" }], metadata: null }],
      pendingAI: null,
      toolOutputsIncluded: false,
    });

    expect(payload).toMatchObject({
      source: "conversation_loaded",
      convId: "conv-1",
      localVisibleBlocks: 1,
      diskVisibleBlocks: 1,
      firstDiff: {
        visibleBlockIndex: 0,
        local: { type: "text", chars: 12, preview: "local answer" },
        disk: { type: "text", chars: 11, preview: "disk answer" },
      },
    });
  });

  test("canonical same-conversation load replaces non-streaming local assistant tail", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push(
      { role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "new local tail" }], metadata: null },
    );

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(assistantBlocks(state)).toEqual([
      { type: "text", text: "persisted answer" },
    ]);
  });

  test("preserves only the live pending assistant tail across a stale same-conversation load", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({ role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null });
    state.pendingAI = {
      role: "assistant",
      blocks: [{ type: "text", text: "new local tail" }],
      metadata: { startedAt: 2, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.messages).toEqual([
      { role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null },
    ]);
    expect(state.pendingAI?.blocks).toEqual([{ type: "text", text: "new local tail" }]);
  });

  test("canonical history update replaces non-streaming local assistant tail", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "text", text: "persisted answer" },
        { type: "thinking", text: "still working" },
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ pwd" },
      ],
      metadata: null,
    });

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(assistantBlocks(state)).toEqual([
      { type: "text", text: "persisted answer" },
    ]);
  });

  test("history update keeps the live pending assistant tail", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({ role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null });
    state.pendingAI = {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "still working" },
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ pwd" },
      ],
      metadata: { startedAt: 2, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.messages).toEqual([
      { role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null },
    ]);
    expect(state.pendingAI?.blocks).toEqual([
      { type: "thinking", text: "still working" },
      { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ pwd" },
    ]);
  });

  test("does not preserve local assistant content over an incompatible disk rewrite", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "text", text: "old local answer" },
        { type: "text", text: "old local tail" },
      ],
      metadata: null,
    });

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "ai", blocks: [{ type: "text", text: "new compact summary" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(assistantBlocks(state)).toEqual([
      { type: "text", text: "new compact summary" },
    ]);
  });

  test("preserves expanded tool output across a compact same-conversation load", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
      metadata: null,
    });

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [{
        type: "ai",
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.showToolOutput).toBe(true);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
    });
  });

  test("fetches only the result a compact same-conversation load introduced", () => {
    const loadRequests: string[][] = [];
    const localDaemon: DaemonActions = {
      ...daemon,
      loadToolOutputs(_convId, toolCallIds) { loadRequests.push(toolCallIds ?? []); },
    };
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
      metadata: null,
    });

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [{
        type: "ai",
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
          { type: "tool_call", toolCallId: "sleep-1", toolName: "chrono", input: {}, summary: "sleep: 1h" },
          { type: "tool_result", toolCallId: "sleep-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, localDaemon);

    expect(state.showToolOutput).toBe(true);
    expect(loadRequests).toEqual([]);
    presentHistory(state);
    requestVisibleToolOutputs(state, localDaemon);
    expect(loadRequests).toEqual([["sleep-1"]]);
  });

  test("does not re-request a body that loaded empty on every frame", () => {
    const requests: string[][] = [];
    const localDaemon: DaemonActions = {
      ...daemon,
      loadToolOutputs(_convId, toolCallIds) { requests.push(toolCallIds ?? []); return `req-${requests.length}`; },
    };
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "quiet", toolName: "bash", input: {}, summary: "$ true" },
        { type: "tool_result", toolCallId: "quiet", toolName: "", output: "", isError: false },
      ],
      metadata: null,
    });
    presentHistory(state);
    requestVisibleToolOutputs(state, localDaemon);
    expect(requests).toEqual([["quiet"]]);

    handleEvent({ type: "tool_outputs_loaded", reqId: "req-1", convId: "conv-1", outputs: [{ toolCallId: "quiet", output: "" }] }, state, localDaemon);
    presentHistory(state);
    requestVisibleToolOutputs(state, localDaemon);
    requestVisibleToolOutputs(state, localDaemon);

    expect(requests).toEqual([["quiet"]]);
    expect(state.toolOutputsLoading).toBe(false);
  });

  test("keeps an expanded, scrolled viewport on the same output row across a compact history update", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.cols = 80;
    state.showToolOutput = true;
    state.layout.messageAreaHeight = 8;
    const blocks = (output: string) => [
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "bash", output, isError: false },
      { type: "text" as const, text: Array.from({ length: 30 }, (_, i) => `after ${i + 1}`).join("\n") },
    ];
    state.messages.push({ role: "assistant", blocks: blocks(Array.from({ length: 30 }, (_, i) => `out ${i + 1}`).join("\n")), metadata: null });
    state.scrollOffset = 40;
    const topVisibleLine = () => {
      const lines = buildMessageLines(state, state.cols).lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
      return lines[getViewStartFor(lines.length, state.layout.messageAreaHeight, state.scrollOffset)];
    };
    expect(topVisibleLine()).toBe("    out 13");

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "ai", blocks: blocks(""), metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(topVisibleLine()).toBe("    out 13");
  });

  test("preserves expanded tool output across a compact history update", () => {
    let loadToolOutputsCalls = 0;
    const localDaemon: DaemonActions = {
      ...daemon,
      loadToolOutputs() { loadToolOutputsCalls += 1; },
    };
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
      metadata: null,
    });

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{
        type: "ai",
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, localDaemon);

    expect(state.showToolOutput).toBe(true);
    presentHistory(state);
    requestVisibleToolOutputs(state, localDaemon);
    expect(loadToolOutputsCalls).toBe(0);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
    });
  });

  test("fetches only a newly introduced deferred-sleep result after a compact history update", () => {
    const loadRequests: string[][] = [];
    const localDaemon: DaemonActions = {
      ...daemon,
      loadToolOutputs(_convId, toolCallIds) { loadRequests.push(toolCallIds ?? []); },
    };
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
        { type: "tool_call", toolCallId: "sleep-1", toolName: "chrono", input: {}, summary: "sleep: 1h" },
      ],
      metadata: null,
    });

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{
        type: "ai",
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
          { type: "tool_call", toolCallId: "sleep-1", toolName: "chrono", input: {}, summary: "sleep: 1h" },
          { type: "tool_result", toolCallId: "sleep-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, localDaemon);

    expect(state.showToolOutput).toBe(true);
    presentHistory(state);
    requestVisibleToolOutputs(state, localDaemon);
    expect(state.toolOutputsLoading).toBe(true);
    expect(loadRequests).toEqual([["sleep-1"]]);

    handleEvent({
      type: "tool_outputs_loaded",
      convId: "conv-1",
      outputs: [
        { toolCallId: "sleep-1", output: "Sleep interrupted after 9s because the user sent a message (requested 1h)." },
      ],
    }, state, localDaemon);

    expect(state.toolOutputsLoading).toBe(false);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1" },
        { type: "tool_result", toolCallId: "call-1", output: "full output" },
        { type: "tool_call", toolCallId: "sleep-1" },
        {
          type: "tool_result",
          toolCallId: "sleep-1",
          output: "Sleep interrupted after 9s because the user sent a message (requested 1h).",
        },
      ],
    });
  });

  test("ignores hidden compact tool-result output differences until output is visible", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
      metadata: null,
    });
    const disk = {
      entries: [{
        type: "ai" as const,
        blocks: [
          { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result" as const, toolCallId: "call-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      pendingAI: null,
      toolOutputsIncluded: false,
    };

    expect(buildDiskSyncAssistantDiffPayload("history_updated", "conv-1", state, disk)).toBeNull();

    state.showToolOutput = true;
    expect(buildDiskSyncAssistantDiffPayload("history_updated", "conv-1", state, disk)).toMatchObject({
      firstDiff: {
        visibleBlockIndex: 1,
        local: { type: "tool_result", outputChars: 11, outputPreview: "full output" },
        disk: { type: "tool_result", outputChars: 0, outputPreview: "" },
      },
    });
  });
});

describe("user_message images", () => {
  test("a delivered queued message keeps the bytes this client sent when the echo carries only ids", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    const sent = { mediaType: "image/png" as const, base64: "iVBORw0KGgo=", sizeBytes: 300_000 };
    const echoed = { mediaType: "image/png" as const, base64: "", sizeBytes: 300_000, imageId: "a".repeat(64), width: 800, height: 600 };
    state.queuedMessages.push({ id: "queue-img", optimistic: true, convId: "conv-1", text: "look", timing: "message-end", images: [sent], source: "daemon", createdAt: 1 });
    handleEvent({ type: "user_message", convId: "conv-1", text: "look", startedAt: 5_000, queueId: "queue-img", images: [echoed] } as Event, state, daemon);
    expect(state.messages.at(-1)).toMatchObject({ role: "user", images: [sent] });
    // Another client's message: the ids are all there is, and a preview is fetched.
    handleEvent({ type: "user_message", convId: "conv-1", text: "theirs", startedAt: 6_000, queueId: "queue-other", images: [echoed] } as Event, state, daemon);
    expect(state.messages.at(-1)).toMatchObject({ role: "user", images: [echoed] });
  });
});

describe("instant steering display", () => {
  test("keeps the preempted partial reply above the steer without duplicating it on completion", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    const event = (value: Record<string, unknown>) => handleEvent({ convId: "conv-1", ...value } as Event, state, daemon);
    event({ type: "streaming_started", provider: "openai", model: "gpt-5.5", startedAt: 1_000, snapshotKind: "start" });
    // A reasoning summary can open without ever producing text.
    event({ type: "block_start", blockType: "thinking" });
    event({ type: "block_start", blockType: "text" });
    event({ type: "text_chunk", text: "I'll draw a cozy cat" });
    event({ type: "user_message", text: "3 ducks!", startedAt: 2_000, queueId: "steer-1" });
    event({ type: "block_start", blockType: "text" });
    event({ type: "text_chunk", text: "Three ducks it is!" });
    event({
      type: "message_complete",
      blocks: [{ type: "text", text: "I'll draw a cozy cat" }, { type: "text", text: "Three ducks it is!" }],
      endedAt: 3_000,
      tokens: 5,
    });

    expect(state.messages.map(message => message.role === "assistant"
      ? message.blocks.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "")
      : message.text)).toEqual([
      ["I'll draw a cozy cat"],
      "3 ducks!",
      ["Three ducks it is!"],
    ]);
  });
});

describe("streaming assistant metadata", () => {
  test("carries the work timer on start and heartbeat and resets only on injected human input", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    handleEvent({
      type: "streaming_started", convId: "conv-1", provider: "openai", model: "gpt-5.5",
      startedAt: 137_000, workTimerStartedAt: 3_000, snapshotKind: "start",
    }, state, daemon);
    expect(state.pendingAI?.metadata?.workTimerStartedAt).toBe(3_000);
    handleEvent({
      type: "user_message", convId: "conv-1", text: "automatic", startedAt: 140_000,
      automation: { kind: "goal_continuation" },
    }, state, daemon);
    expect(state.pendingAI?.metadata?.workTimerStartedAt).toBe(3_000);
    handleEvent({
      type: "user_message", convId: "conv-1", text: "human", startedAt: 145_000,
    }, state, daemon);
    expect(state.pendingAI?.metadata?.workTimerStartedAt).toBe(145_000);
    handleEvent({
      type: "streaming_started", convId: "conv-1", provider: "openai", model: "gpt-5.5",
      startedAt: 137_000, workTimerStartedAt: 145_000, snapshotKind: "heartbeat",
    }, state, daemon);
    expect(state.pendingAI?.metadata?.workTimerStartedAt).toBe(145_000);
  });
  for (const scrollOffset of [0, 20]) {
    for (const automated of [false, true]) {
      test(`incoming ${automated ? "background" : "user"} message preserves scroll offset ${scrollOffset}, including duplicate delivery`, () => {
        const state = createInitialState();
        state.convId = "conv-1";
        state.scrollOffset = scrollOffset;
        const event = {
          type: "user_message" as const,
          convId: "conv-1",
          text: automated ? "[notification] Background task completed" : "next question",
          startedAt: 2,
          ...(automated ? {
            queueId: "completion-1",
            automation: { kind: "background_task_completion" as const, sourceId: "exec:test" },
          } : {}),
        };

        handleEvent(event, state, daemon);
        expect(state.scrollOffset).toBe(scrollOffset);
        handleEvent(event, state, daemon);
        expect(state.scrollOffset).toBe(scrollOffset);
        expect(state.messages).toHaveLength(1);
      });
    }
  }

  test("preserves automated-message provenance on a live user event", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";

    handleEvent({
      type: "user_message",
      convId: "conv-1",
      text: "scheduled work",
      startedAt: 2,
      queueId: "chrono:test:2",
      automation: { kind: "chrono_wake", sourceId: "chrono:test" },
    }, state, daemon);

    expect(state.messages.at(-1)?.metadata).toMatchObject({
      queueEntryId: "chrono:test:2",
      automation: { kind: "chrono_wake", sourceId: "chrono:test" },
    });
  });

  test("does not duplicate a queued user turn when canonical history wins the race", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    state.messages.push({
      role: "user",
      text: "join the call",
      metadata: {
        startedAt: 2,
        endedAt: 2,
        model: "gpt-5.5",
        tokens: 0,
        queueEntryId: "queue-call-1",
      },
    });
    state.queuedMessages.push({
      id: "queue-call-1",
      convId: "conv-1",
      text: "join the call",
      timing: "next-turn",
      createdAt: 1,
    });

    handleEvent({
      type: "user_message",
      convId: "conv-1",
      text: "join the call",
      startedAt: 2,
      queueId: "queue-call-1",
    }, state, daemon);

    expect(state.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(state.queuedMessages).toHaveLength(0);
  });

  test("does not duplicate a direct user turn when canonical history wins the race", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    state.messages.push({
      role: "user",
      text: "join the call",
      metadata: {
        startedAt: 2,
        endedAt: 2,
        model: "gpt-5.5",
        tokens: 0,
      },
    });

    handleEvent({
      type: "user_message",
      convId: "conv-1",
      text: "join the call",
      startedAt: 2,
    }, state, daemon);

    expect(state.messages).toHaveLength(1);
  });

  test("keeps direct repeated text with different client timestamps", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    state.messages.push({
      role: "user",
      text: "same text",
      metadata: { startedAt: 2, endedAt: 2, model: "gpt-5.5", tokens: 0 },
    });

    handleEvent({
      type: "user_message",
      convId: "conv-1",
      text: "same text",
      startedAt: 3,
    }, state, daemon);

    expect(state.messages).toHaveLength(2);
  });

  test("keeps repeated queued text when the stable identities differ", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    state.messages.push({
      role: "user",
      text: "again",
      metadata: {
        startedAt: 1,
        endedAt: 1,
        model: "gpt-5.5",
        tokens: 0,
        queueEntryId: "queue-1",
      },
    });

    handleEvent({
      type: "user_message",
      convId: "conv-1",
      text: "again",
      startedAt: 2,
      queueId: "queue-2",
    }, state, daemon);

    expect(state.messages.filter(message => message.role === "user")).toHaveLength(2);
    expect(state.messages[1]?.metadata?.queueEntryId).toBe("queue-2");
  });

  test("heartbeat offsets do not invalidate locally committed completion blocks", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: {}, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
    ];
    state.pendingAI = {
      role: "assistant",
      blocks: structuredClone(completedPrefix),
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };
    handleEvent({ type: "user_message", convId: "conv-1", text: "next", startedAt: 2 }, state, daemon);

    handleEvent({
      type: "streaming_started",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      snapshotKind: "heartbeat",
      startedAt: 1,
      blocks: [],
      blockOffset: completedPrefix.length,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(0);

    handleEvent({ type: "text_chunk", convId: "conv-1", text: "foo" }, state, daemon);
    handleEvent({ type: "system_message", convId: "conv-1", text: "notice", color: "warning" }, state, daemon);
    handleEvent({ type: "text_chunk", convId: "conv-1", text: "bar" }, state, daemon);
    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "foobar" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);

    expect(state.messages.flatMap((message) => message.role === "assistant" ? message.blocks : [])).toEqual([
      ...completedPrefix,
      { type: "text", text: "foobar" },
    ]);
  });

  test("late-join completion honors the active-turn block offset from the daemon", () => {
    const state = createInitialState();
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "thinking" as const, text: "checking" },
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: { command: "pwd" }, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "", output: "", isError: false },
    ];

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [
        { type: "ai", blocks: completedPrefix, metadata: null },
        { type: "user", text: "also check tests" },
      ],
      pendingAI: {
        blocks: [{ type: "text", text: "done" }],
        blockOffset: completedPrefix.length,
        metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(3);

    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "done" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);

    expect(state.messages.flatMap((message) => message.role === "assistant" ? message.blocks : [])).toEqual([
      ...completedPrefix,
      { type: "text", text: "done" },
    ]);
  });

  test("legacy reload derives a completion offset from locally committed blocks", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: {}, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
    ];
    state.pendingAI = {
      role: "assistant",
      blocks: structuredClone(completedPrefix),
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };
    handleEvent({ type: "user_message", convId: "conv-1", text: "next", startedAt: 2 }, state, daemon);
    handleEvent({ type: "text_chunk", convId: "conv-1", text: "done" }, state, daemon);

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [
        { type: "ai", blocks: completedPrefix, metadata: null },
        { type: "user", text: "next" },
      ],
      pendingAI: {
        blocks: [{ type: "text", text: "done" }],
        metadata: state.pendingAI!.metadata,
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(completedPrefix.length);

    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "done" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);
    expect(state.messages.flatMap((message) => message.role === "assistant" ? message.blocks : [])).toEqual([
      ...completedPrefix,
      { type: "text", text: "done" },
    ]);
  });

  test("message_complete does not duplicate a prefix committed around an injected user message", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "thinking" as const, text: "checking" },
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: { command: "pwd" }, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
    ];
    state.pendingAI = {
      role: "assistant",
      blocks: structuredClone(completedPrefix),
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "user_message",
      convId: "conv-1",
      text: "also check tests",
      startedAt: 2,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(0);
    expect(state.pendingAIPartialCommittedBlocks).toEqual(completedPrefix);

    handleEvent({
      type: "text_chunk",
      convId: "conv-1",
      text: "done",
    }, state, daemon);
    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "done" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);

    expect(state.messages).toEqual([
      { role: "assistant", blocks: completedPrefix, metadata: null },
      {
        role: "user",
        text: "also check tests",
        images: undefined,
        metadata: { startedAt: 2, endedAt: 2, model: "gpt-5.5", tokens: 0 },
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "done" }],
        metadata: { startedAt: 1, endedAt: 3, model: "gpt-5.5", tokens: 10, workTimerStartedAt: 2 },
      },
    ]);
    expect(state.pendingAI).toBeNull();
    expect(state.pendingAIBlockOffset).toBe(0);
  });

  test("message_complete keeps adjacent goal-continuation assistant messages separate", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    state.messages.push({
      role: "assistant",
      blocks: [{ type: "text", text: "Initial progress" }],
      metadata: { startedAt: 0, endedAt: 1_000, model: "gpt-5.5", tokens: 10 },
    });
    state.pendingAI = {
      role: "assistant",
      blocks: [{ type: "text", text: "Final result" }],
      metadata: { startedAt: 3_600_000, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [{ type: "text", text: "Final result" }],
      endedAt: 7_200_000,
      tokens: 25,
    }, state, daemon);

    expect(state.messages).toEqual([
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Initial progress" }],
        metadata: { startedAt: 0, endedAt: 1_000, model: "gpt-5.5", tokens: 10 },
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Final result" }],
        metadata: { startedAt: 3_600_000, endedAt: 7_200_000, model: "gpt-5.5", tokens: 25 },
      },
    ]);
    expect(state.pendingAI).toBeNull();
  });
});

describe("conversation_updated", () => {
  test("ignores a null summary from a malformed daemon event", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.sidebar.conversations = [summary()];

    expect(() => {
      handleEvent({ type: "conversation_updated", summary: null } as never, state, daemon);
    }).not.toThrow();

    expect(state.sidebar.conversations).toEqual([summary()]);
  });

  test("applies an authoritative unread completion summary immediately", () => {
    const state = createInitialState();
    state.sidebar.conversations = [summary({ id: "queued-chain", streaming: true, unread: true })];

    handleEvent({
      type: "conversation_updated",
      summary: summary({ id: "queued-chain", streaming: false, unread: true }),
    }, state, daemon);

    expect(state.sidebar.conversations.find(conversation => conversation.id === "queued-chain"))
      .toMatchObject({ streaming: false, unread: true });
  });
});
