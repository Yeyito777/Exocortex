import { describe, expect, test } from "bun:test";
import { openEditMessageModal } from "./editmessage";
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
});
