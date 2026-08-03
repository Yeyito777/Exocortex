import { describe, expect, test } from "bun:test";

// The realtime helper runs under Node, so its platform command selector is CJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { captureSpec, playbackSpec } = require("./call-media-platform.cjs") as {
  captureSpec(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): { command: string; args: string[] };
  playbackSpec(sampleRate: number, channels: number, platform?: NodeJS.Platform): { command: string; args: string[] };
};

describe("realtime call media platform commands", () => {
  test("keeps PulseAudio capture and playback on Linux", () => {
    expect(captureSpec("linux")).toEqual({
      command: "parec",
      args: ["--record", "--raw", "--format=s16le", "--rate=48000", "--channels=1", "--latency-msec=20"],
    });
    expect(playbackSpec(24_000, 1, "linux")).toEqual({
      command: "pacat",
      args: ["--playback", "--raw", "--format=s16le", "--rate=24000", "--channels=1", "--latency-msec=20"],
    });
  });

  test("uses AVFoundation capture and ffplay playback on macOS", () => {
    expect(captureSpec("darwin", {})).toEqual({
      command: "ffmpeg",
      args: [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "avfoundation", "-i", "none:default",
        "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1",
      ],
    });
    expect(playbackSpec(48_000, 2, "darwin")).toEqual({
      command: "ffplay",
      args: [
        "-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit",
        "-f", "s16le", "-ar", "48000", "-ch_layout", "stereo", "-i", "pipe:0",
      ],
    });
  });

  test("honors the configured macOS input device", () => {
    expect(captureSpec("darwin", { EXOCORTEX_CALL_AVFOUNDATION_DEVICE: "none:MacBook Pro Microphone" }).args)
      .toContain("none:MacBook Pro Microphone");
  });
});
