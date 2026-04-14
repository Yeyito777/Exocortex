import { describe, expect, test } from "bun:test";
import { applyVoicePlaceholder, chooseLinuxRecorderCommand, insertVoiceTranscript, voicePlaceholderText, type VoicePromptState } from "./voice";

describe("voice prompt helpers", () => {
  test("renders the requested spinner frames for recording and transcription", () => {
    const recording: VoicePromptState = { phase: "recording", frameIndex: 0, insertionPos: 0 };
    const transcribing: VoicePromptState = { phase: "transcribing", frameIndex: 9, insertionPos: 0 };

    expect(voicePlaceholderText(recording)).toBe("⠋ Listening…");
    expect(voicePlaceholderText(transcribing)).toBe("⠏ Transcribing…");
  });

  test("injects the placeholder inline at the insertion point", () => {
    const voice: VoicePromptState = { phase: "recording", frameIndex: 1, insertionPos: 5 };
    expect(applyVoicePlaceholder("hello world", voice)).toBe("hello⠙ Listening… world");
  });

  test("inserts the final transcript back into the prompt", () => {
    expect(insertVoiceTranscript("hello", 5, 5, "world", " ")).toEqual({
      buffer: "hello world",
      cursorPos: 11,
    });
  });

  test("uses pw-record with a wav container when available", () => {
    const available = new Set(["pw-record", "arecord", "ffmpeg"]);
    const cmd = chooseLinuxRecorderCommand((name) => available.has(name), "/tmp/input.wav");
    expect(cmd).toEqual({
      command: "pw-record",
      args: ["--rate", "16000", "--channels", "1", "--format", "s16", "--container", "wav", "/tmp/input.wav"],
    });
  });

  test("falls back to arecord before ffmpeg on Linux", () => {
    const available = new Set(["arecord", "ffmpeg"]);
    const cmd = chooseLinuxRecorderCommand((name) => available.has(name), "/tmp/input.wav");
    expect(cmd).toEqual({
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", "/tmp/input.wav"],
    });
  });
});
