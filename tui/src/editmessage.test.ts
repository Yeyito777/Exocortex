import { describe, expect, test } from "bun:test";
import {
  applyOptimisticEditMessageUnwind,
  classifyPendingEditMessageUnwindEvent,
  confirmEditMessage,
  editMessageItemIndexAtMouse,
  openEditMessageModal,
} from "./editmessage";
import { createPendingAI, type UserMessage } from "./messages";
import { createInitialState } from "./state";

describe("edit message modal", () => {
  test("uses the absolute user index of a paged history window", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyStartUserIndex = 12;
    state.messages = [{ role: "user", text: "loaded later turn", metadata: null }];

    openEditMessageModal(state);

    expect(state.editMessagePrompt?.items[0]?.userMessageIndex).toBe(12);
  });

  test("Ctrl-W can edit a local pending voice message before a conversation exists", () => {
    const state = createInitialState();
    state.convId = null;
    const message: UserMessage = {
      role: "user",
      text: "⠋ Transcribing…",
      metadata: null,
    };
    state.messages.push(message);
    state.voiceMessage = { message, phase: "transcribing", frameIndex: 0 };

    openEditMessageModal(state);

    expect(state.editMessagePrompt?.items).toHaveLength(1);
    expect(state.editMessagePrompt?.items[0]).toMatchObject({
      text: "⠋ Transcribing…",
      isQueued: false,
      message,
    });
  });

  test("Ctrl-W includes a submitted voice echo even if it is not in canonical messages", () => {
    const state = createInitialState();
    state.convId = "conv-voice";
    const message: UserMessage = {
      role: "user",
      text: "draft ⠙ Transcribing…",
      metadata: null,
    };
    state.voiceMessage = { message, phase: "transcribing", frameIndex: 1 };

    openEditMessageModal(state);

    expect(state.editMessagePrompt?.items).toHaveLength(1);
    expect(state.editMessagePrompt?.items[0]).toMatchObject({
      text: "draft ⠙ Transcribing…",
      isQueued: false,
      message,
    });
  });

  test("Ctrl-W canonicalizes stale pending voice echo objects to the live voice message", () => {
    const state = createInitialState();
    state.convId = "conv-voice";
    const liveMessage: UserMessage = {
      role: "user",
      text: "draft ⠙ Transcribing…",
      metadata: { startedAt: 42, endedAt: null, tokens: 0, model: state.model },
    };
    const staleEcho: UserMessage = {
      role: "user",
      text: "draft ⠋ Transcribing…",
      metadata: { startedAt: 42, endedAt: null, tokens: 0, model: state.model },
    };
    state.messages.push(staleEcho);
    state.voiceMessage = { message: liveMessage, phase: "transcribing", frameIndex: 1 };

    openEditMessageModal(state);

    expect(state.editMessagePrompt?.items).toHaveLength(1);
    expect(state.editMessagePrompt?.items[0]?.message).toBe(liveMessage);
    expect(state.editMessagePrompt?.items[0]?.sourceMessage).toBe(staleEcho);
    expect(state.editMessagePrompt?.items[0]?.text).toBe(liveMessage.text);
  });

  test("Ctrl-W does not duplicate a queued pending voice echo", () => {
    const state = createInitialState();
    state.convId = "conv-voice";
    const message: UserMessage = {
      role: "user",
      text: "queued ⠹ Transcribing…",
      metadata: null,
    };
    const queuedMessage = {
      convId: state.convId,
      text: message.text,
      timing: "message-end" as const,
    };
    state.voiceMessage = { message, phase: "transcribing", frameIndex: 2 };
    state.queuedMessages.push(queuedMessage);

    openEditMessageModal(state);

    expect(state.editMessagePrompt?.items).toHaveLength(1);
    expect(state.editMessagePrompt?.items[0]).toMatchObject({
      text: "queued ⠹ Transcribing…",
      isQueued: true,
      queuedMessage,
    });
  });

  test("Ctrl-W includes queued new-conversation messages in draft chats", () => {
    const state = createInitialState();
    const queuedMessage = {
      convId: "reserved-conv",
      text: "start this later",
      timing: "message-end" as const,
      source: "global-idle" as const,
      target: "new-conversation" as const,
    };
    state.pendingQueuedDraftConvId = "reserved-conv";
    state.queuedMessages.push(queuedMessage);

    openEditMessageModal(state);

    expect(state.editMessagePrompt?.items).toHaveLength(1);
    expect(state.editMessagePrompt?.items[0]).toMatchObject({
      text: "start this later",
      isQueued: true,
      queuedMessage,
    });
  });

  test("Ctrl-W does not include queued pending-conversation messages in unrelated blank drafts", () => {
    const state = createInitialState();
    state.queuedMessages.push({
      convId: "pending-conv",
      text: "belongs elsewhere",
      timing: "message-end",
      source: "global-idle",
      target: "new-conversation",
    });

    openEditMessageModal(state);

    expect(state.editMessagePrompt).toBeNull();
  });

  test("mouse hit testing selects visible Ctrl-W edit items", () => {
    const state = createInitialState();
    state.convId = "conv-click";
    state.cols = 100;
    state.layout.chatCol = 1;
    state.layout.sepAbove = 20;
    state.layout.messageAreaHeight = 17;
    state.messages.push(
      { role: "user", text: "first", metadata: null },
      { role: "user", text: "second", metadata: null },
      { role: "user", text: "third", metadata: null },
    );

    openEditMessageModal(state);

    expect(editMessageItemIndexAtMouse(state, 50, 16)).toBe(0);
    expect(editMessageItemIndexAtMouse(state, 50, 17)).toBe(1);
    expect(editMessageItemIndexAtMouse(state, 50, 18)).toBe(2);
    expect(editMessageItemIndexAtMouse(state, 50, 15)).toBeNull();
  });

  test("hides users represented by the latest compaction while preserving daemon indices", () => {
    const state = createInitialState();
    state.messages.push(
      {
        role: "user",
        text: "locked before checkpoint",
        metadata: null,
        contextCheckpoint: { contextTokens: 300_000, editable: false },
      },
      { role: "assistant", blocks: [], metadata: null },
      {
        role: "user",
        text: "editable tail",
        metadata: null,
        contextCheckpoint: { contextTokens: 42_123, editable: true },
      },
    );

    openEditMessageModal(state);

    expect(state.editMessagePrompt?.items).toHaveLength(1);
    expect(state.editMessagePrompt?.items[0]).toMatchObject({
      text: "editable tail",
      userMessageIndex: 1,
    });
    expect(confirmEditMessage(state)).toEqual({
      action: "edit_sent",
      text: "editable tail",
      userMessageIndex: 1,
    });
    expect(state.contextTokens).toBe(42_123);
  });

  test("optimistically removes the selected sent message and active tail", () => {
    const state = createInitialState();
    state.convId = "conv-optimistic";
    state.messages = [
      { role: "system_instructions", text: "Keep this", metadata: null },
      { role: "user", text: "first", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "first answer" }], metadata: null },
      { role: "user", text: "edit me", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "old answer" }], metadata: null },
    ];
    state.pendingAI = createPendingAI(123, state.model);
    state.pendingAI.blocks.push({ type: "text", text: "still streaming" });
    state.streamingTailMessages.push({ role: "system", text: "old tail", metadata: null });
    state.historyTotalEntries = 4;
    state.historyLoadingOlder = true;
    state.historyLoadingStartedAt = 100;
    state.historyLoadingRequestId = "old-page";
    state.scrollOffset = 20;
    state.lastStreamSeqByConv[state.convId] = 9;

    expect(applyOptimisticEditMessageUnwind(state, 1)).toBe(true);

    expect(state.messages.map((message) => message.role)).toEqual([
      "system_instructions",
      "user",
      "assistant",
    ]);
    expect(state.pendingAI).toBeNull();
    expect(state.streamingTailMessages).toEqual([]);
    expect(state.historyTotalEntries).toBe(2);
    expect(state.historyLoadingOlder).toBe(false);
    expect(state.historyLoadingStartedAt).toBeNull();
    expect(state.historyLoadingRequestId).toBeNull();
    expect(state.scrollOffset).toBe(0);
    expect(state.lastStreamSeqByConv[state.convId]).toBeUndefined();
  });

  test("uses absolute user indices for an optimistic paged-history unwind", () => {
    const state = createInitialState();
    state.historyStartIndex = 20;
    state.historyStartUserIndex = 10;
    state.historyTotalEntries = 24;
    state.historyHasOlder = true;
    state.messages = [
      { role: "user", text: "user ten", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "answer ten" }], metadata: null },
      { role: "user", text: "user eleven", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "answer eleven" }], metadata: null },
    ];

    expect(applyOptimisticEditMessageUnwind(state, 11)).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.historyTotalEntries).toBe(22);
    expect(state.historyHasOlder).toBe(true);
  });

  test("suppresses doomed stream events until the matching unwind snapshot", () => {
    const pending = { convId: "conv-1", reqId: "unwind-1" };

    expect(classifyPendingEditMessageUnwindEvent(pending, {
      type: "system_message",
      convId: "conv-1",
      text: "✗ Interrupted",
    })).toBe("ignore");
    expect(classifyPendingEditMessageUnwindEvent(pending, {
      type: "history_updated",
      convId: "conv-1",
      entries: [],
      contextTokens: null,
      toolOutputsIncluded: false,
    })).toBe("ignore");
    expect(classifyPendingEditMessageUnwindEvent(pending, {
      type: "conversation_loaded",
      reqId: "another-load",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [],
      contextTokens: null,
      toolOutputsIncluded: false,
    })).toBe("ignore");
    expect(classifyPendingEditMessageUnwindEvent(pending, {
      type: "conversation_loaded",
      reqId: "unwind-1",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [],
      contextTokens: null,
      toolOutputsIncluded: false,
    })).toBe("complete");
    expect(classifyPendingEditMessageUnwindEvent(pending, {
      type: "error",
      reqId: "unwind-1",
      convId: "conv-1",
      message: "Cannot unwind conversation conv-1",
    })).toBe("failed");
    expect(classifyPendingEditMessageUnwindEvent(pending, {
      type: "system_message",
      convId: "conv-2",
      text: "unrelated",
    })).toBe("unrelated");
  });
});
