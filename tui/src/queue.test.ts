import { describe, expect, test } from "bun:test";
import { createPendingAI, type ImageAttachment } from "./messages";
import { openQueuePrompt, confirmQueueMessage, cancelQueuePrompt } from "./queue";
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
      convId: "conv-1",
      text: "caption",
      timing: "message-end",
      images: [img],
    });
    expect(state.pendingImages).toEqual([]);
    expect(state.queuePrompt).toBeNull();
    expect(state.queuedMessages).toEqual([
      { convId: "conv-1", text: "caption", timing: "message-end", images: [img] },
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
