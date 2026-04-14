import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { createVoiceInputController } from "./voiceinput";

describe("voice input controller", () => {
  test("only arms hold-to-talk in prompt normal mode", () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";

    let recorderStarts = 0;
    const controller = createVoiceInputController(
      state,
      { transcribeAudio() {} },
      () => {},
      {
        startRecorder: () => {
          recorderStarts++;
          return {
            stop: async () => ({ bytes: Buffer.from([1]), mimeType: "audio/wav" }),
            abort() {},
          };
        },
      },
    );

    try {
      expect(controller.handleKey({ type: "char", char: " " })).toBe(false);
      expect(recorderStarts).toBe(0);
      expect(state.voicePrompt).toBeNull();
    } finally {
      controller.cleanup();
    }
  });

  test("records then inserts the transcript back into the prompt", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "hey";
    state.cursorPos = 3;

    let clock = 1_000;
    let transcribeCalls = 0;
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
          transcribeCalls++;
          onSuccess("there");
        },
      },
      () => {},
      {
        startRecorder: () => ({
          stop: async () => ({ bytes: Buffer.from([1, 2, 3]), mimeType: "audio/wav" }),
          abort() {},
        }),
        now: () => clock,
      },
    );

    try {
      expect(controller.handleKey({ type: "char", char: " " })).toBe(true);
      expect(state.voicePrompt?.phase).toBe("recording");

      clock += 1_500;
      expect(controller.handleKey({ type: "char", char: "x" })).toBe(true);
      await Promise.resolve();

      expect(transcribeCalls).toBe(1);
      expect(state.inputBuffer).toBe("hey there");
      expect(state.cursorPos).toBe("hey there".length);
      expect(state.voicePrompt).toBeNull();
    } finally {
      controller.cleanup();
    }
  });

  test("drops recordings that are too short to be useful", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";

    let clock = 5_000;
    let transcribeCalls = 0;
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio() {
          transcribeCalls++;
        },
      },
      () => {},
      {
        startRecorder: () => ({
          stop: async () => ({ bytes: Buffer.from([1]), mimeType: "audio/wav" }),
          abort() {},
        }),
        now: () => clock,
      },
    );

    try {
      expect(controller.handleKey({ type: "char", char: " " })).toBe(true);
      clock += 500;
      expect(controller.handleKey({ type: "escape" })).toBe(true);
      await Promise.resolve();

      expect(transcribeCalls).toBe(0);
      expect(state.inputBuffer).toBe("");
      expect(state.voicePrompt).toBeNull();
    } finally {
      controller.cleanup();
    }
  });
});
