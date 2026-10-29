import { describe, expect, test } from "bun:test";
import { applyVoicePlaceholder, chooseDarwinRecorderCommand, chooseLinuxRecorderCommand, chooseRecorderCommand, getRenderedVoicePrompt, insertVoiceTranscript, isDigitallySilentWav, recorderErrorMessage, voicePlaceholderText, type VoicePromptState } from "./voice";

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

  test("computes the rendered cursor position for an inline placeholder", () => {
    const voice: VoicePromptState = { phase: "transcribing", frameIndex: 0, insertionPos: 5 };
    expect(getRenderedVoicePrompt("hello", 5, voice)).toEqual({
      buffer: "hello⠋ Transcribing…",
      cursorPos: "hello⠋ Transcribing…".length,
    });
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

  test("uses ffmpeg AVFoundation on macOS", () => {
    const cmd = chooseDarwinRecorderCommand((name) => name === "ffmpeg", "/tmp/input.wav");
    expect(cmd).toEqual({
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "avfoundation",
        "-i",
        "none:default",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        "/tmp/input.wav",
      ],
    });
  });

  test("dispatches recorder selection by platform", () => {
    expect(chooseRecorderCommand("darwin", (name) => name === "ffmpeg", "/tmp/input.wav")?.args).toContain("avfoundation");
    expect(chooseRecorderCommand("linux", (name) => name === "pw-record", "/tmp/input.wav")?.command).toBe("pw-record");
    expect(chooseRecorderCommand("win32", () => true, "/tmp/input.wav")).toBeNull();
  });

  test("hides irrelevant macOS Continuity Camera warnings from audio capture errors", () => {
    const stderr = [
      "2026-08-03 09:55:50.392 ffmpeg[34575:5711156] WARNING: Add NSCameraUseContinuityCameraDeviceType to your Info.plist to use AVCaptureDeviceTypeContinuityCamera.",
      "2026-08-03 09:55:50.595 ffmpeg[34575:5711156] WARNING: AVCaptureDeviceTypeExternal is deprecated for Continuity Cameras. Please use AVCaptureDeviceTypeContinuityCamera and add NSCameraUseContinuityCameraDeviceType to your Info.plist.",
      "Error opening input: Permission denied",
    ].join("\n");

    expect(recorderErrorMessage(stderr)).toBe("Error opening input: Permission denied");
  });

  test("recognizes a capture that is entirely digital silence", () => {
    const chunk = (id: string, body: Buffer, size = body.length) => {
      const header = Buffer.alloc(8);
      header.write(id, 0, "ascii");
      header.writeUInt32LE(size, 4);
      return Buffer.concat([header, body, Buffer.alloc(body.length & 1)]);
    };
    const fmt = (format: number, bits: number) => {
      const body = Buffer.alloc(16);
      body.writeUInt16LE(format, 0);
      body.writeUInt16LE(1, 2);
      body.writeUInt32LE(16000, 4);
      body.writeUInt32LE(16000 * bits / 8, 8);
      body.writeUInt16LE(bits / 8, 12);
      body.writeUInt16LE(bits, 14);
      return chunk("fmt ", body);
    };
    const wav = (chunks: Buffer[]) => {
      const riff = Buffer.alloc(12);
      riff.write("RIFF", 0, "ascii");
      riff.write("WAVE", 8, "ascii");
      return Buffer.concat([riff, ...chunks]);
    };
    const samples = (values: number[]) => {
      const body = Buffer.alloc(values.length * 2);
      values.forEach((value, i) => body.writeInt16LE(value, i * 2));
      return body;
    };
    const silence = samples(new Array(1600).fill(0));
    const quiet = samples([...new Array(1599).fill(0), -1]);

    expect(isDigitallySilentWav(wav([fmt(1, 16), chunk("data", silence)]))).toBe(true);
    expect(isDigitallySilentWav(wav([fmt(1, 16), chunk("data", quiet)]))).toBe(false);
    // ffmpeg writes a LIST chunk before the samples; a recorder stopped by a signal may leave a placeholder size.
    expect(isDigitallySilentWav(wav([fmt(1, 16), chunk("LIST", Buffer.from("INFOISFT")), chunk("data", silence, 0xffffffff)]))).toBe(true);
    expect(isDigitallySilentWav(wav([fmt(0xfffe, 16), chunk("data", silence)]))).toBe(true);
    // Only 16-bit PCM is judged; anything else is passed on to transcription.
    expect(isDigitallySilentWav(wav([fmt(3, 32), chunk("data", silence)]))).toBe(false);
    expect(isDigitallySilentWav(Buffer.from("not a wav file at all"))).toBe(false);
  });
});
