import { describe, expect, test } from "bun:test";
import { createMessageMetadata, type UserMessage } from "./messages";
import { removePendingVoiceEchoes, pendingVoiceSubmissionsMatch } from "./pendingvoice";
import { createInitialState } from "./state";
import type { SubmittedVoiceTranscription } from "./voiceinput";

function submissionFor(state: ReturnType<typeof createInitialState>, message: UserMessage): SubmittedVoiceTranscription {
  return {
    message,
    startedAt: message.metadata?.startedAt ?? 42,
    convId: state.convId,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    folderId: state.sidebar.currentFolderId,
    wasStreaming: false,
  };
}

describe("pending voice helpers", () => {
  test("removes stale rendered echoes when Ctrl-W canonicalizes to the live voice message", () => {
    const state = createInitialState();
    state.convId = "conv-voice";
    const liveMessage: UserMessage = {
      role: "user",
      text: "draft ⠙ Transcribing…",
      metadata: createMessageMetadata(42, state.model),
    };
    const staleEcho: UserMessage = {
      role: "user",
      text: "draft ⠋ Transcribing…",
      metadata: createMessageMetadata(42, state.model),
    };
    const unrelated: UserMessage = {
      role: "user",
      text: "older message",
      metadata: createMessageMetadata(1, state.model, { endedAt: 1 }),
    };
    state.messages.push(unrelated, staleEcho);
    state.voiceMessage = { message: liveMessage, phase: "transcribing", frameIndex: 1 };

    removePendingVoiceEchoes(state, submissionFor(state, liveMessage), { sourceMessage: staleEcho });

    expect(state.messages).toEqual([unrelated]);
    expect(state.voiceMessage).toBeNull();
  });

  test("matches duplicate pending submissions by stable timestamp, not only object identity", () => {
    const state = createInitialState();
    const first: UserMessage = {
      role: "user",
      text: "⠋ Transcribing…",
      metadata: createMessageMetadata(99, state.model),
    };
    const second: UserMessage = {
      role: "user",
      text: "⠹ Transcribing…",
      metadata: createMessageMetadata(99, state.model),
    };

    expect(pendingVoiceSubmissionsMatch(submissionFor(state, first), submissionFor(state, second))).toBe(true);
  });
});
