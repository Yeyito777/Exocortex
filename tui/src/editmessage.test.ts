import { describe, expect, test } from "bun:test";
import { editMessageItemIndexAtMouse, openEditMessageModal } from "./editmessage";
import type { UserMessage } from "./messages";
import { createInitialState } from "./state";

describe("edit message modal", () => {
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
});
