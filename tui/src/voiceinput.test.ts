import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { createVoiceInputController } from "./voiceinput";
import type { UserMessage } from "./messages";

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

  test("inserts after a non-space final line character with a leading separator", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "End of line";
    state.cursorPos = state.inputBuffer.length - 1;

    let clock = 2_000;
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
          onSuccess("transcription");
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
      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();

      expect(state.inputBuffer).toBe("End of line transcription");
    } finally {
      controller.cleanup();
    }
  });

  test("separates a transcript from surrounding non-space prompt text", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "helloworld";
    state.cursorPos = "hello".length;

    let clock = 2_500;
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
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
      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();

      expect(state.inputBuffer).toBe("hello there world");
    } finally {
      controller.cleanup();
    }
  });

  test("space release immediately switches from recording to transcribing", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";

    let clock = 30_000;
    let stopCalls = 0;
    const controller = createVoiceInputController(
      state,
      { transcribeAudio() {} },
      () => {},
      {
        startRecorder: () => ({
          stop: async () => {
            stopCalls++;
            return { bytes: Buffer.from([1, 2, 3]), mimeType: "audio/wav" };
          },
          abort() {},
        }),
        now: () => clock,
      },
    );

    try {
      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      expect(state.voicePrompt?.phase).toBe("recording");

      clock += 1_500;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);

      expect(state.voicePromptJobs[0]?.phase).toBe("transcribing");
      await Promise.resolve();
      expect(stopCalls).toBe(1);
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
      clock += 499;
      expect(controller.handleKey({ type: "escape" })).toBe(true);
      await Promise.resolve();

      expect(transcribeCalls).toBe(0);
      expect(state.inputBuffer).toBe("");
      expect(state.voicePrompt).toBeNull();
    } finally {
      controller.cleanup();
    }
  });

  test("enter submits an in-flight recording as a pending user message", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "hey";
    state.cursorPos = 3;

    let clock = 10_000;
    let transcriptSuccess: ((text: string) => void) | null = null;
    let completedText = "";
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
          transcriptSuccess = onSuccess;
        },
      },
      () => {},
      {
        startRecorder: () => ({
          stop: async () => ({ bytes: Buffer.from([1, 2, 3]), mimeType: "audio/wav" }),
          abort() {},
        }),
        now: () => clock,
        submitPendingTranscription: (placeholderText) => {
          const message: UserMessage = { role: "user", text: placeholderText, metadata: null };
          state.messages.push(message);
          return {
            message,
            startedAt: 123,
            convId: state.convId,
            provider: state.provider,
            model: state.model,
            effort: state.effort,
            fastMode: state.fastMode,
            folderId: state.sidebar.currentFolderId,
            wasStreaming: false,
          };
        },
        completePendingTranscription: (submission, finalText) => {
          completedText = finalText;
          submission.message.text = finalText;
          if (state.voiceMessage?.message === submission.message) state.voiceMessage = null;
        },
      },
    );

    try {
      expect(controller.handleKey({ type: "char", char: " " })).toBe(true);
      clock += 1_500;

      expect(controller.handleKey({ type: "enter" })).toBe(true);
      expect(state.voicePrompt).toBeNull();
      expect(state.voiceMessage?.phase).toBe("transcribing");
      expect(state.messages[0]?.role).toBe("user");
      expect((state.messages[0] as UserMessage).text).toContain("hey ");
      expect((state.messages[0] as UserMessage).text).toContain("Transcribing…");
      expect(state.inputBuffer).toBe("hey");

      await Promise.resolve();
      expect(transcriptSuccess).not.toBeNull();
      transcriptSuccess!("there");

      expect(completedText).toBe("hey there");
      expect((state.messages[0] as UserMessage).text).toBe("hey there");
      expect(state.voiceMessage).toBeNull();
    } finally {
      controller.cleanup();
    }
  });

  test("prompt stays editable while inline transcription is pending", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "say";
    state.cursorPos = 3;

    let clock = 20_000;
    let transcriptSuccess: ((text: string) => void) | null = null;
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
          transcriptSuccess = onSuccess;
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
      clock += 1_500;
      expect(controller.handleKey({ type: "escape" })).toBe(true);
      await Promise.resolve();

      expect(state.voicePromptJobs[0]?.phase).toBe("transcribing");
      const mode: string = state.vim.mode;
      expect(mode).toBe("normal");

      state.vim.mode = "insert";
      expect(controller.handleKey({ type: "char", char: "!" })).toBe(false);

      const previousBuffer = state.inputBuffer;
      state.inputBuffer = `${state.inputBuffer}!`;
      state.cursorPos = state.inputBuffer.length;
      controller.syncPromptEdit(previousBuffer);

      expect(transcriptSuccess).not.toBeNull();
      transcriptSuccess!("there");

      expect(state.inputBuffer).toBe("say there!");
      expect(state.cursorPos).toBe("say there!".length);
      expect(state.voicePrompt).toBeNull();
    } finally {
      controller.cleanup();
    }
  });

  test("supports multiple simultaneous prompt transcription jobs", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "say";
    state.cursorPos = 3;

    let clock = 40_000;
    const transcriptSuccesses: Array<(text: string) => void> = [];
    let recorderStarts = 0;
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
          transcriptSuccesses.push(onSuccess);
        },
      },
      () => {},
      {
        startRecorder: () => {
          recorderStarts++;
          return {
            stop: async () => ({ bytes: Buffer.from([recorderStarts]), mimeType: "audio/wav" }),
            abort() {},
          };
        },
        now: () => clock,
      },
    );

    try {
      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();
      expect(state.voicePromptJobs).toHaveLength(1);

      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      expect(state.voicePrompt?.phase).toBe("recording");
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();
      expect(state.voicePromptJobs).toHaveLength(2);
      expect(transcriptSuccesses).toHaveLength(2);

      transcriptSuccesses[1]!("two");
      expect(state.inputBuffer).toBe("say");
      expect(state.voicePromptJobs).toHaveLength(2);

      transcriptSuccesses[0]!("one");
      expect(state.inputBuffer).toBe("say one two");
      expect(state.voicePromptJobs).toHaveLength(0);
    } finally {
      controller.cleanup();
    }
  });

  test("separates adjacent prompt transcription jobs with no surrounding text", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";

    let clock = 45_000;
    const transcriptSuccesses: Array<(text: string) => void> = [];
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
          transcriptSuccesses.push(onSuccess);
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
      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();

      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      expect(state.voicePrompt?.prefixText).toBe(" ");
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();

      transcriptSuccesses[0]!("one");
      transcriptSuccesses[1]!("two");

      expect(state.inputBuffer).toBe("one two");
    } finally {
      controller.cleanup();
    }
  });

  test("enter moves multiple prompt transcription jobs into a pending chat message", async () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "say";
    state.cursorPos = 3;

    let clock = 50_000;
    const transcriptSuccesses: Array<(text: string) => void> = [];
    let completedText = "";
    const controller = createVoiceInputController(
      state,
      {
        transcribeAudio(_audioBase64, _mimeType, onSuccess) {
          transcriptSuccesses.push(onSuccess);
        },
      },
      () => {},
      {
        startRecorder: () => ({
          stop: async () => ({ bytes: Buffer.from([1, 2, 3]), mimeType: "audio/wav" }),
          abort() {},
        }),
        now: () => clock,
        submitPendingTranscription: (placeholderText) => {
          const message: UserMessage = { role: "user", text: placeholderText, metadata: null };
          state.messages.push(message);
          state.inputBuffer = "";
          state.cursorPos = 0;
          return {
            message,
            startedAt: 456,
            convId: state.convId,
            provider: state.provider,
            model: state.model,
            effort: state.effort,
            fastMode: state.fastMode,
            folderId: state.sidebar.currentFolderId,
            wasStreaming: false,
          };
        },
        completePendingTranscription: (submission, finalText) => {
          completedText = finalText;
          submission.message.text = finalText;
          if (state.voiceMessage?.message === submission.message) state.voiceMessage = null;
        },
      },
    );

    try {
      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();
      expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
      clock += 600;
      expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
      await Promise.resolve();

      expect(controller.handleKey({ type: "enter" })).toBe(true);
      expect(state.voicePromptJobs).toHaveLength(0);
      expect(state.messages[0]?.role).toBe("user");
      expect((state.messages[0] as UserMessage).text).toContain("Transcribing…");

      transcriptSuccesses[1]!("two");
      expect(completedText).toBe("");
      expect((state.messages[0] as UserMessage).text).toContain("Transcribing…");

      transcriptSuccesses[0]!("one");
      expect(completedText).toBe("say one two");
      expect((state.messages[0] as UserMessage).text).toBe("say one two");
    } finally {
      controller.cleanup();
    }
  });
});
