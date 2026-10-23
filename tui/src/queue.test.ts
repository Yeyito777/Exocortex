import { describe, expect, test } from "bun:test";
import { createPendingAI, type ImageAttachment } from "./messages";
import {
  clearAllQueuedMessagesForConversation,
  confirmQueueMessage,
  enqueueGlobalIdleMessage,
  enqueueQueuedCommand,
  handleQueuePromptKey,
  isGlobalIdleQueuedMessage,
  openQueuePrompt,
  queueTimingLabel,
  removeLocalQueueEntry,
  cancelQueuePrompt,
  type QueuedCommandActions,
} from "./queue";
import type { KeyEvent } from "./input";
import { createInitialState } from "./state";
import { renderQueuePromptOverlay } from "./overlays";

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
      selection: "next-turn",
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
      timing: "next-turn",
      images: [img],
    });
    expect(state.pendingImages).toEqual([]);
    expect(state.queuePrompt).toBeNull();
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ id: expect.any(String), convId: "conv-1", text: "caption", timing: "next-turn", images: [img], source: "daemon" }),
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
      timing: "next-turn",
      images: undefined,
    });
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        convId: "conv-1",
        text: "Go ahead and implement that please",
        timing: "next-turn",
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

describe("queue prompt timing options", () => {
  test("offers next turn instead of steer now where the provider takes the message in at a tool boundary", () => {
    const prompt = { text: "use staging", selection: "next-turn" as const };
    expect(renderQueuePromptOverlay(prompt, 80, 1, 20).payload).toContain("steer now");
    const claude = renderQueuePromptOverlay(prompt, 80, 1, 20, false).payload;
    expect(claude).toContain("next turn");
    expect(claude).not.toContain("steer now");
  });
});

describe("queue prompt option order", () => {
  const press = (state: ReturnType<typeof createInitialState>, key: KeyEvent) => handleQueuePromptKey(key, state);
  const ch = (char: string) => ({ type: "char", char }) as KeyEvent;

  test("next turn / steer now is listed first and selected when the prompt opens", () => {
    const state = createInitialState();
    openQueuePrompt(state, "hi");
    expect(state.queuePrompt?.selection).toBe("next-turn");
    for (const steers of [true, false]) {
      const payload = renderQueuePromptOverlay(state.queuePrompt!, 80, 1, 20, steers).payload;
      const first = payload.indexOf(steers ? "steer now" : "next turn");
      const second = payload.indexOf("message end");
      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(second);
      expect(payload.indexOf("▸")).toBeLessThan(first);
      expect(payload.indexOf("▸")).toBeGreaterThan(payload.indexOf("hi"));
    }
  });

  test("Enter on the freshly opened prompt queues for next turn", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.pendingAI = createPendingAI(Date.now(), state.model);
    openQueuePrompt(state, "hi");
    expect(press(state, { type: "enter" } as KeyEvent)).toEqual({ type: "confirm" });
    expect(confirmQueueMessage(state)).toMatchObject({ action: "queue", timing: "next-turn" });
  });

  test("up/k/h/left pick the top option, down/j/l/right the bottom, tab toggles", () => {
    const state = createInitialState();
    openQueuePrompt(state, "hi");
    const sel = () => state.queuePrompt!.selection;
    for (const key of [{ type: "down" }, ch("j"), ch("l"), { type: "right" }] as KeyEvent[]) {
      state.queuePrompt!.selection = "next-turn";
      press(state, key);
      expect(sel()).toBe("message-end");
    }
    for (const key of [{ type: "up" }, ch("k"), ch("h"), { type: "left" }] as KeyEvent[]) {
      state.queuePrompt!.selection = "message-end";
      press(state, key);
      expect(sel()).toBe("next-turn");
    }
    press(state, { type: "tab" } as KeyEvent);
    expect(sel()).toBe("message-end");
    press(state, { type: "tab" } as KeyEvent);
    expect(sel()).toBe("next-turn");
  });
});

describe("global idle /queue optimistic display", () => {
  test("queues registered commands without knowing their individual names", () => {
    const state = createInitialState();
    state.convId = "conv-command";
    state.inputBuffer = "/compact /queue Build";
    state.cursorPos = state.inputBuffer.length;
    const calls: unknown[][] = [];
    const daemon: QueuedCommandActions = {
      queueMessage(...args) {
        calls.push(args);
      },
    };
    const waitTarget = { type: "conversation", convId: "dependency", label: "Build" } as const;

    const ok = enqueueQueuedCommand(
      state,
      daemon,
      { name: "/compact", text: "/compact" },
      waitTarget,
    );

    expect(ok).toBe(true);
    expect(state.queuedMessages).toEqual([expect.objectContaining({
      id: expect.any(String),
      convId: "conv-command",
      text: "/compact",
      command: { name: "/compact" },
      source: "global-idle",
      target: "conversation",
      waitTarget,
    })]);
    expect(calls).toEqual([[
      "conv-command",
      "/compact",
      "message-end",
      undefined,
      {
        queueId: state.queuedMessages[0].id,
        command: { name: "/compact" },
        source: "global-idle",
        target: "conversation",
        waitTarget,
      },
    ]]);
    expect(state.inputBuffer).toBe("");
  });

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

  test("labels timed entries with the wall-clock time they send at", () => {
    const state = createInitialState();
    const createdAt = new Date(2026, 9, 9, 13, 0, 0).getTime();
    const short = enqueueGlobalIdleMessage(state, "conv-1", "soon", undefined, {
      waitTarget: { type: "delay", delayMs: 90_000, label: "90s" },
    });
    short.createdAt = createdAt;
    const long = enqueueGlobalIdleMessage(state, "conv-1", "tomorrow", undefined, {
      waitTarget: { type: "delay", delayMs: 12 * 3_600_000, label: "12h" },
    });
    long.createdAt = createdAt;

    expect(queueTimingLabel(short, createdAt)).toBe("queued: at 13:01:30");
    expect(queueTimingLabel(long, createdAt)).toBe("queued: at Oct 10 01:00");
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
