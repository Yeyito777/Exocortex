import { describe, expect, test } from "bun:test";
import { createPendingAI, type ImageAttachment } from "./messages";
import {
  clearAllQueuedMessagesForConversation,
  confirmQueueMessage,
  enqueueGlobalIdleMessage,
  isGlobalIdleQueuedMessage,
  openQueuePrompt,
  queueTimingLabel,
  removeLocalQueueEntry,
  cancelQueuePrompt,
} from "./queue";
import { createInitialState } from "./state";

function makeImage(): ImageAttachment {
  return {
    mediaType: "image/png",
    base64: "i-am-base64",
    sizeBytes: 1234,
  };
}

describe("queue prompt image handling", () => {
  test("keeps pending images visible while the queue prompt is open", () => {
    const state = createInitialState();
    const img = makeImage();

    state.pendingImages = [img];
    state.inputBuffer = "caption";
    state.cursorPos = state.inputBuffer.length;

    openQueuePrompt(state, "caption");

    expect(state.pendingImages).toEqual([img]);
    expect(state.queuePrompt).toEqual({
      text: "caption",
      selection: "message-end",
      images: [img],
    });
    expect(state.queuePrompt?.images).not.toBe(state.pendingImages);
  });

  test("clears pending images when the message is actually queued", () => {
    const state = createInitialState();
    const img = makeImage();

    state.convId = "conv-1";
    state.pendingAI = createPendingAI(Date.now(), state.model);
    state.pendingImages = [img];

    openQueuePrompt(state, "caption");
    const result = confirmQueueMessage(state);

    expect(result).toEqual({
      action: "queue",
      queueId: expect.any(String),
      convId: "conv-1",
      text: "caption",
      timing: "message-end",
      images: [img],
    });
    expect(state.pendingImages).toEqual([]);
    expect(state.queuePrompt).toBeNull();
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ id: expect.any(String), convId: "conv-1", text: "caption", timing: "message-end", images: [img], source: "daemon" }),
    ]);
  });

  test("cancel keeps pending images in the prompt", () => {
    const state = createInitialState();
    const img = makeImage();

    state.pendingImages = [img];
    openQueuePrompt(state, "caption");

    cancelQueuePrompt(state);

    expect(state.pendingImages).toEqual([img]);
    expect(state.queuePrompt).toBeNull();
    expect(state.inputBuffer).toBe("caption");
    expect(state.cursorPos).toBe("caption".length);
  });

  test("cancel restores macro text without expanding it", () => {
    const state = createInitialState();

    openQueuePrompt(state, "/go please");
    cancelQueuePrompt(state);

    expect(state.queuePrompt).toBeNull();
    expect(state.inputBuffer).toBe("/go please");
    expect(state.cursorPos).toBe("/go please".length);
  });

  test("confirm expands macros only when queueing the message", () => {
    const state = createInitialState();

    state.convId = "conv-1";
    state.pendingAI = createPendingAI(Date.now(), state.model);

    openQueuePrompt(state, "/go please");
    const result = confirmQueueMessage(state);

    expect(result).toEqual({
      action: "queue",
      queueId: expect.any(String),
      convId: "conv-1",
      text: "Go ahead and implement that please",
      timing: "message-end",
      images: undefined,
    });
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        convId: "conv-1",
        text: "Go ahead and implement that please",
        timing: "message-end",
        images: undefined,
        source: "daemon",
      }),
    ]);
  });

  test("send-direct confirm clears pending images after streaming has already ended", () => {
    const state = createInitialState();
    const img = makeImage();

    state.convId = "conv-1";
    state.pendingImages = [img];
    openQueuePrompt(state, "caption");

    const result = confirmQueueMessage(state);

    expect(result).toEqual({
      action: "send_direct",
      text: "caption",
      images: [img],
    });
    expect(state.pendingImages).toEqual([]);
    expect(state.queuePrompt).toBeNull();
  });
});

describe("global idle /queue optimistic display", () => {
  test("creates a stable optimistic global-idle shadow", () => {
    const state = createInitialState();

    const queued = enqueueGlobalIdleMessage(state, "conv-1", "later");

    expect(isGlobalIdleQueuedMessage(queued)).toBe(true);
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ id: expect.any(String), convId: "conv-1", text: "later", timing: "message-end", source: "global-idle" }),
    ]);
  });

  test("captures draft settings for queued new conversations", () => {
    const state = createInitialState();

    const queued = enqueueGlobalIdleMessage(state, "reserved-conv", "start later", undefined, {
      target: "new-conversation",
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: true,
      folderId: "folder-1",
    });

    expect(queued).toEqual(expect.objectContaining({
      id: expect.any(String),
      convId: "reserved-conv",
      text: "start later",
      timing: "message-end",
      source: "global-idle",
      target: "new-conversation",
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: true,
      folderId: "folder-1",
    }));
  });

  test("stores conversation wait targets for the daemon command", () => {
    const state = createInitialState();

    const queued = enqueueGlobalIdleMessage(state, "conv-1", "later", undefined, {
      waitTarget: { type: "conversation", convId: "dependency", label: "Build" },
    });

    expect(queued).toEqual(expect.objectContaining({
      id: expect.any(String),
      convId: "conv-1",
      text: "later",
      timing: "message-end",
      source: "global-idle",
      waitTarget: { type: "conversation", convId: "dependency", label: "Build" },
    }));
    expect(queueTimingLabel(queued)).toBe("queued: after Build");
  });

  test("daemon user_message cleanup does not remove a same-text global idle entry", () => {
    const state = createInitialState();
    state.queuedMessages.push({ convId: "conv-1", text: "same", timing: "next-turn" });
    const global = enqueueGlobalIdleMessage(state, "conv-1", "same");

    removeLocalQueueEntry(state, "conv-1", "same");

    expect(state.queuedMessages).toEqual([global]);
  });

  test("conversation deletion clears global idle queue entries too", () => {
    const state = createInitialState();
    enqueueGlobalIdleMessage(state, "conv-1", "global");
    enqueueGlobalIdleMessage(state, "conv-2", "keep");

    clearAllQueuedMessagesForConversation(state, "conv-1");

    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ id: expect.any(String), convId: "conv-2", text: "keep", timing: "message-end", source: "global-idle" }),
    ]);
  });
});
