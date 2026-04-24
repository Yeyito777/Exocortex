import { describe, expect, test } from "bun:test";
import { formatTranscribeAudioOutput } from "./transcribe-audio";

describe("transcribe_audio tool output", () => {
  test("returns the trimmed transcription text", () => {
    expect(formatTranscribeAudioOutput("  hello world\n")).toBe("hello world");
  });
});
