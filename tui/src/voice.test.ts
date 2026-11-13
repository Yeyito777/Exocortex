import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVoicePlaceholder, builtInMicrophoneName, chooseDarwinRecorderCommand, chooseLinuxRecorderCommand, chooseRecorderCommand, getRenderedVoicePrompt, insertVoiceTranscript, isDigitallySilentWav, recorderErrorMessage, VoiceRecorder, voicePlaceholderText, type VoicePromptState } from "./voice";

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

/** A 16 kHz mono 16-bit WAV holding these samples. */
function wavFile(samples: number[]): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length * 2, 40);
  const body = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => body.writeInt16LE(value, i * 2));
  return Buffer.concat([header, body]);
}

describe("voice recorder", () => {
  const SILENCE = wavFile(new Array(1600).fill(0));
  const HEADSET = wavFile([0, 12, -40, 300, -7]);
  const BUILT_IN = wavFile([5, -9, 120, -300, 44]);
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A stand-in for ffmpeg: each microphone "records" the file given for it
   * (none: that device fails to open), then runs until it is signalled.
   */
  function fakeMac(devices: { default?: Buffer; builtIn?: Buffer }) {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-voice-test-"));
    dirs.push(dir);
    if (devices.default) writeFileSync(join(dir, "default.wav"), devices.default);
    if (devices.builtIn) writeFileSync(join(dir, "MacBook Pro Microphone.wav"), devices.builtIn);
    const script = join(dir, "ffmpeg");
    writeFileSync(script, `#!/usr/bin/env bash
trap 'exit 0' INT TERM
dir="$(dirname "$0")"
out="\${@: -1}"
device=""
while [ $# -gt 1 ]; do
  if [ "$1" = "-i" ]; then device="\${2#none:}"; fi
  shift
done
echo "$device" >> "$dir/opened"
if ! cp "$dir/$device.wav" "$out" 2>/dev/null; then
  echo "Error opening input: Input/output error" >&2
  echo "$device" >> "$dir/settled"
  exit 1
fi
echo "$device" >> "$dir/settled"
while true; do sleep 0.02; done
`);
    chmodSync(script, 0o755);
    const lines = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean) : [];
    const notes: string[] = [];
    const outputs: string[] = [];
    const start = (backupMicrophone: string | null) => VoiceRecorder.start({
      platform: "darwin",
      hasCommand: command => command === "ffmpeg",
      spawnRecorder: (_command, args) => {
        outputs.push(args.at(-1)!);
        return spawn(script, args, { stdio: ["ignore", "ignore", "pipe"] });
      },
      backupMicrophone,
      note: message => notes.push(message),
    });
    /** Every started recorder has either written its file or failed. */
    const settled = async () => {
      const deadline = Date.now() + 5000;
      while (lines("settled").length < outputs.length) {
        if (Date.now() > deadline) throw new Error("fake recorder did not start");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    return { start, settled, notes, outputs, opened: () => lines("opened").sort() };
  }

  test("uses the built-in microphone's recording when the default input recorded only zeros", async () => {
    const mac = fakeMac({ default: SILENCE, builtIn: BUILT_IN });
    const recorder = mac.start("MacBook Pro Microphone");
    await mac.settled();
    const clip = await recorder.stop();

    expect(mac.opened()).toEqual(["MacBook Pro Microphone", "default"]);
    expect(clip.bytes.equals(BUILT_IN)).toBe(true);
    expect(clip.mimeType).toBe("audio/wav");
    expect(mac.notes).toEqual(["voice: the default input recorded only silence; used the built-in microphone's recording"]);
    expect(existsSync(mac.outputs[0]!)).toBe(false);
    expect(existsSync(mac.outputs[1]!)).toBe(false);
  });

  test("keeps the default input's recording whenever it has sound", async () => {
    const mac = fakeMac({ default: HEADSET, builtIn: BUILT_IN });
    const recorder = mac.start("MacBook Pro Microphone");
    await mac.settled();
    const clip = await recorder.stop();

    expect(clip.bytes.equals(HEADSET)).toBe(true);
    expect(mac.notes).toEqual([]);
  });

  test("a built-in microphone that fails to open leaves the default input's recording untouched", async () => {
    const mac = fakeMac({ default: HEADSET });
    const recorder = mac.start("MacBook Pro Microphone");
    await mac.settled();
    const clip = await recorder.stop();

    expect(mac.opened()).toEqual(["MacBook Pro Microphone", "default"]);
    expect(clip.bytes.equals(HEADSET)).toBe(true);
    expect(mac.notes).toEqual(["voice: the built-in microphone was not recorded: Error opening input: Input/output error"]);
  });

  test("uses the built-in microphone when the default input cannot be opened", async () => {
    const mac = fakeMac({ builtIn: BUILT_IN });
    const recorder = mac.start("MacBook Pro Microphone");
    await mac.settled();
    const clip = await recorder.stop();

    expect(clip.bytes.equals(BUILT_IN)).toBe(true);
    expect(mac.notes).toEqual(["voice: the default input recorded nothing; used the built-in microphone's recording"]);
  });

  test("reports silence when every microphone recorded only zeros", async () => {
    const mac = fakeMac({ default: SILENCE, builtIn: SILENCE });
    const recorder = mac.start("MacBook Pro Microphone");
    await mac.settled();

    await expect(recorder.stop()).rejects.toThrow("the microphone recorded only silence");
    expect(mac.notes).toEqual(["voice: the default input recorded only silence"]);
  });

  test("records only the default input on a Mac without a built-in microphone", async () => {
    const mac = fakeMac({ default: SILENCE, builtIn: BUILT_IN });
    const recorder = mac.start(null);
    await mac.settled();

    await expect(recorder.stop()).rejects.toThrow("the microphone recorded only silence");
    expect(mac.opened()).toEqual(["default"]);
  });

  test("reports the default input's own error when nothing was recorded", async () => {
    const mac = fakeMac({});
    const recorder = mac.start("MacBook Pro Microphone");
    await mac.settled();

    await expect(recorder.stop()).rejects.toThrow("Error opening input: Input/output error");
  });

  test("aborting stops every microphone and removes the recordings", async () => {
    const mac = fakeMac({ default: HEADSET, builtIn: BUILT_IN });
    const recorder = mac.start("MacBook Pro Microphone");
    await mac.settled();
    recorder.abort();

    expect(existsSync(mac.outputs[0]!)).toBe(false);
    expect(existsSync(mac.outputs[1]!)).toBe(false);
  });

  test("finds the built-in microphone among the Mac's audio devices", () => {
    const profile = (items: unknown[]) => JSON.stringify({ SPAudioDataType: [{ _name: "coreaudio_device", _items: items }] });
    const airpodsIn = { _name: "Aurelio’s AirPods Max", coreaudio_default_audio_input_device: "spaudio_yes", coreaudio_device_input: 1, coreaudio_device_transport: "coreaudio_device_type_bluetooth" };
    const speakers = { _name: "MacBook Pro Speakers", coreaudio_device_output: 2, coreaudio_device_transport: "coreaudio_device_type_builtin" };
    const builtIn = { _name: "MacBook Pro Microphone", coreaudio_device_input: 1, coreaudio_device_transport: "coreaudio_device_type_builtin" };

    expect(builtInMicrophoneName(profile([airpodsIn, speakers, builtIn]))).toBe("MacBook Pro Microphone");
    // Lid closed: the built-in microphone is not listed.
    expect(builtInMicrophoneName(profile([airpodsIn, speakers]))).toBeNull();
    expect(builtInMicrophoneName(profile([{ ...builtIn, _name: "Odd: name" }]))).toBeNull();
    expect(builtInMicrophoneName("{}")).toBeNull();
    expect(builtInMicrophoneName("system_profiler: not json")).toBeNull();
  });

  test("records the named microphone through AVFoundation", () => {
    const cmd = chooseDarwinRecorderCommand(() => true, "/tmp/backup.wav", "none:MacBook Pro Microphone");
    expect(cmd?.args.slice(4, 8)).toEqual(["-f", "avfoundation", "-i", "none:MacBook Pro Microphone"]);
    expect(cmd?.args.at(-1)).toBe("/tmp/backup.wav");
  });
});
