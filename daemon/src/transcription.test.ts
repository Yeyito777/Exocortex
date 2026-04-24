import { describe, expect, test } from "bun:test";
import { DEFAULT_AUDIO_MIME_TYPE, inferAudioMimeType, transcribeAudioBytes } from "./transcription";

describe("audio transcription surface", () => {
  test("infers audio MIME types from common extensions", () => {
    expect(inferAudioMimeType("/tmp/clip.wav")).toBe("audio/wav");
    expect(inferAudioMimeType("/tmp/clip.MP3")).toBe("audio/mpeg");
    expect(inferAudioMimeType("/tmp/clip.m4a")).toBe("audio/mp4");
    expect(inferAudioMimeType("/tmp/clip.webm")).toBe("audio/webm");
    expect(inferAudioMimeType("/tmp/clip.unknown")).toBeNull();
  });

  test("rejects empty byte payloads before calling the provider", async () => {
    await expect(transcribeAudioBytes(new Uint8Array(), { mimeType: DEFAULT_AUDIO_MIME_TYPE })).rejects.toThrow("Audio file is empty");
  });
});
