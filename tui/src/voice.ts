import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultInputTransport, isBluetoothTransport } from "./macaudio";

export type VoicePromptPhase = "recording" | "transcribing";

export interface VoiceSpinnerState {
  phase: VoicePromptPhase;
  frameIndex: number;
}

export interface VoicePromptState extends VoiceSpinnerState {
  id?: number;
  insertionPos: number;
  prefixText?: string;
  suffixText?: string;
  completedText?: string;
}

export interface VoiceChatMessageState extends VoiceSpinnerState {
  /** The local user message currently standing in for a submitted transcription. */
  message: import("./messages").UserMessage;
}

export interface RecordedVoiceClip {
  bytes: Buffer;
  mimeType: string;
}

interface RecorderCommand {
  command: string;
  args: string[];
}

export const VOICE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function voicePlaceholderText(voice: VoiceSpinnerState): string {
  const frame = VOICE_SPINNER_FRAMES[voice.frameIndex % VOICE_SPINNER_FRAMES.length];
  return voice.phase === "recording"
    ? `${frame} Listening…`
    : `${frame} Transcribing…`;
}

export function voicePromptInsertionText(voice: VoicePromptState, includeSuffix = true): string {
  return `${voice.prefixText ?? ""}${voicePlaceholderText(voice)}${includeSuffix ? voice.suffixText ?? "" : ""}`;
}

export function voicePromptSubmittedText(voice: VoicePromptState, includeSuffix = true): string {
  const suffixText = includeSuffix ? voice.suffixText ?? "" : "";
  if (voice.completedText !== undefined) {
    const normalized = voice.completedText.trim();
    return normalized ? `${voice.prefixText ?? ""}${normalized}${suffixText}` : "";
  }
  return `${voice.prefixText ?? ""}${voicePlaceholderText(voice)}${suffixText}`;
}

function normalizeVoicePrompts(voice: VoicePromptState | VoicePromptState[] | null): VoicePromptState[] {
  if (!voice) return [];
  return Array.isArray(voice) ? voice : [voice];
}

export function sortVoicePromptJobs(voice: VoicePromptState | VoicePromptState[] | null): VoicePromptState[] {
  return normalizeVoicePrompts(voice)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.insertionPos - b.item.insertionPos || (a.item.id ?? a.index) - (b.item.id ?? b.index))
    .map(({ item }) => item);
}

/**
 * Jobs at the same insertion point render as a run. Only the final job in that
 * run owns the suffix separator, so adjacent jobs become "one two" instead of
 * "one  two" while still separating from following prompt text.
 */
export function includeVoicePromptSuffix(jobs: VoicePromptState[], index: number): boolean {
  return jobs[index + 1]?.insertionPos !== jobs[index]?.insertionPos;
}

export function applyVoicePlaceholder(
  buffer: string,
  voice: VoicePromptState | VoicePromptState[] | null,
): string {
  const voices = sortVoicePromptJobs(voice);
  if (voices.length === 0) return buffer;
  let rendered = "";
  let cursor = 0;
  for (let i = 0; i < voices.length; i++) {
    const item = voices[i]!;
    const includeSuffix = includeVoicePromptSuffix(voices, i);
    const insertionPos = Math.max(0, Math.min(buffer.length, item.insertionPos));
    rendered += buffer.slice(cursor, insertionPos) + voicePromptInsertionText(item, includeSuffix);
    cursor = insertionPos;
  }
  return rendered + buffer.slice(cursor);
}

export function getRenderedVoicePrompt(
  buffer: string,
  cursorPos: number,
  voice: VoicePromptState | VoicePromptState[] | null,
): { buffer: string; cursorPos: number } {
  const voices = sortVoicePromptJobs(voice);
  if (voices.length === 0) return { buffer, cursorPos };
  const renderedBuffer = applyVoicePlaceholder(buffer, voices);
  const cursorShift = voices.reduce((shift, item, index) => {
    if (cursorPos < item.insertionPos) return shift;
    return shift + voicePromptInsertionText(item, includeVoicePromptSuffix(voices, index)).length;
  }, 0);
  return {
    buffer: renderedBuffer,
    cursorPos: cursorPos + cursorShift,
  };
}

export function getVoicePromptRanges(
  buffer: string,
  voice: VoicePromptState | VoicePromptState[] | null,
): Array<{ start: number; end: number }> {
  const voices = sortVoicePromptJobs(voice);
  const ranges: Array<{ start: number; end: number }> = [];
  let renderedOffset = 0;
  let cursor = 0;
  for (let i = 0; i < voices.length; i++) {
    const item = voices[i]!;
    const insertionPos = Math.max(0, Math.min(buffer.length, item.insertionPos));
    renderedOffset += insertionPos - cursor;
    const placeholderLength = voicePromptInsertionText(item, includeVoicePromptSuffix(voices, i)).length;
    ranges.push({ start: renderedOffset, end: renderedOffset + placeholderLength });
    renderedOffset += placeholderLength;
    cursor = insertionPos;
  }
  return ranges;
}

export function renderSubmittedVoicePrompt(
  buffer: string,
  voice: VoicePromptState | VoicePromptState[] | null,
): string {
  const voices = sortVoicePromptJobs(voice);
  if (voices.length === 0) return buffer.trim();
  let rendered = "";
  let cursor = 0;
  for (let i = 0; i < voices.length; i++) {
    const item = voices[i]!;
    const insertionPos = Math.max(0, Math.min(buffer.length, item.insertionPos));
    rendered += buffer.slice(cursor, insertionPos) + voicePromptSubmittedText(item, includeVoicePromptSuffix(voices, i));
    cursor = insertionPos;
  }
  return (rendered + buffer.slice(cursor)).trim();
}

export function insertVoiceTranscriptPreservingCursor(
  buffer: string,
  cursorPos: number,
  insertionPos: number,
  transcript: string,
  prefixText = "",
  suffixText = "",
): { buffer: string; cursorPos: number } {
  const normalized = transcript.trim();
  if (!normalized) return { buffer, cursorPos };
  const inserted = `${prefixText}${normalized}${suffixText}`;
  return {
    buffer: buffer.slice(0, insertionPos) + inserted + buffer.slice(insertionPos),
    cursorPos: cursorPos < insertionPos ? cursorPos : cursorPos + inserted.length,
  };
}

export function insertVoiceTranscript(
  buffer: string,
  cursorPos: number,
  insertionPos: number,
  transcript: string,
  prefixText = "",
  suffixText = "",
): { buffer: string; cursorPos: number } {
  const normalized = transcript.trim();
  if (!normalized) return { buffer, cursorPos };
  const inserted = `${prefixText}${normalized}${suffixText}`;
  return {
    buffer: buffer.slice(0, insertionPos) + inserted + buffer.slice(insertionPos),
    cursorPos: insertionPos + inserted.length,
  };
}

export function chooseLinuxRecorderCommand(
  hasCommand: (command: string) => boolean,
  outputPath: string,
): RecorderCommand | null {
  if (hasCommand("pw-record")) {
    return {
      command: "pw-record",
      args: ["--rate", "16000", "--channels", "1", "--format", "s16", "--container", "wav", outputPath],
    };
  }
  if (hasCommand("arecord")) {
    return {
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", outputPath],
    };
  }
  if (hasCommand("ffmpeg")) {
    return {
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "pulse",
        "-i",
        "default",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-y",
        outputPath,
      ],
    };
  }
  return null;
}

export function chooseDarwinRecorderCommand(
  hasCommand: (command: string) => boolean,
  outputPath: string,
  device = process.env.EXOCORTEX_VOICE_AVFOUNDATION_DEVICE || "none:default",
): RecorderCommand | null {
  if (!hasCommand("ffmpeg")) return null;
  return {
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "avfoundation",
      "-i",
      device,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-y",
      outputPath,
    ],
  };
}

export function chooseRecorderCommand(
  platform: NodeJS.Platform,
  hasCommand: (command: string) => boolean,
  outputPath: string,
): RecorderCommand | null {
  if (platform === "linux") return chooseLinuxRecorderCommand(hasCommand, outputPath);
  if (platform === "darwin") return chooseDarwinRecorderCommand(hasCommand, outputPath);
  return null;
}

function recorderDependencyMessage(platform: NodeJS.Platform): string {
  if (platform === "linux") return "Voice input requires pw-record, arecord, or ffmpeg to be installed.";
  if (platform === "darwin") return "Voice input on macOS requires ffmpeg to be installed.";
  return `Voice input is currently only implemented for Linux and macOS (got ${platform}).`;
}

function commandExists(command: string): boolean {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which(command) !== null;
  }
  return false;
}

function cleanupPath(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
}

const MACOS_CONTINUITY_CAMERA_WARNING = /^(?:\d{4}-\d{2}-\d{2} [^ ]+ )?ffmpeg\[\d+:\d+\] WARNING: (?:Add NSCameraUseContinuityCameraDeviceType to your Info\.plist to use AVCaptureDeviceTypeContinuityCamera\.|AVCaptureDeviceTypeExternal is deprecated for Continuity Cameras\. Please use AVCaptureDeviceTypeContinuityCamera and add NSCameraUseContinuityCameraDeviceType to your Info\.plist\.)$/;

/** Remove AVFoundation camera diagnostics that ffmpeg emits during audio-only capture. */
export function recorderErrorMessage(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter(line => !MACOS_CONTINUITY_CAMERA_WARNING.test(line.trim()))
    .join("\n")
    .trim();
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * True when a 16-bit PCM WAV holds no sound at all: every sample is exactly
 * zero. A live microphone always has a noise floor; an input that delivers
 * none (e.g. a Bluetooth headset whose mic link never started) records this.
 */
export function isDigitallySilentWav(wav: Buffer): boolean {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return false;
  let pcm16 = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      const format = wav.readUInt16LE(body);
      pcm16 = (format === WAVE_FORMAT_PCM || format === WAVE_FORMAT_EXTENSIBLE) && wav.readUInt16LE(body + 14) === 16;
    } else if (id === "data") {
      if (!pcm16) return false;
      // A recorder stopped by a signal may leave a placeholder size; the samples run to the end of the file.
      for (let i = body; i + 1 < wav.length; i += 2) {
        if (wav.readInt16LE(i) !== 0) return false;
      }
      return true;
    }
    offset = body + size + (size & 1);
  }
  return false;
}

function silentCaptureMessage(platform: NodeJS.Platform): string {
  const device = platform === "darwin" ? "the input device in System Settings › Sound › Input" : "the input device";
  return `the microphone recorded only silence; check ${device} (a Bluetooth headset's mic can stay silent until it is reconnected)`;
}

/**
 * The built-in microphone's device name in `system_profiler SPAudioDataType
 * -json` output, or null when the Mac has none (lid closed, a Mac without one).
 */
export function builtInMicrophoneName(profilerJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profilerJson);
  } catch {
    return null;
  }
  const groups = (parsed as { SPAudioDataType?: unknown } | null)?.SPAudioDataType;
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    const items = (group as { _items?: unknown } | null)?._items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const device = item as Record<string, unknown> | null;
      const name = device?._name;
      if (device?.coreaudio_device_transport !== "coreaudio_device_type_builtin") continue;
      if (typeof device.coreaudio_device_input !== "number" || device.coreaudio_device_input < 1) continue;
      // AVFoundation input specs are "video:audio"; a name with a colon cannot be passed.
      if (typeof name === "string" && name && !name.includes(":")) return name;
    }
  }
  return null;
}

/** What is known about the Mac's built-in microphone. */
export interface BuiltInMicrophone {
  /** undefined: not looked up yet; null: this Mac has none right now (lid closed). */
  name: string | null | undefined;
  looking: boolean;
  /** Recordings in a row that it failed to open; after two it is left alone. */
  failures: number;
}

const BUILT_IN_MICROPHONE_MAX_FAILURES = 2;
const builtInMicrophone: BuiltInMicrophone = { name: undefined, looking: false, failures: 0 };
let coreAudioWarmed = false;

/**
 * Look up the Mac's built-in microphone in the background so a recording can
 * use it (see VoiceRecorder). Takes ~0.7 s, so it runs at startup and again
 * before a recording that still has no answer. Also loads CoreAudio ahead of
 * the first recording.
 */
export function prepareVoiceRecorder(): void {
  if (process.platform !== "darwin" || process.env.EXOCORTEX_VOICE_AVFOUNDATION_DEVICE) return;
  if (!coreAudioWarmed) {
    coreAudioWarmed = true;
    setTimeout(() => { defaultInputTransport(); }, 500).unref?.();
  }
  if (builtInMicrophone.name || builtInMicrophone.looking) return;
  builtInMicrophone.looking = true;
  try {
    execFile("system_profiler", ["SPAudioDataType", "-json"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      builtInMicrophone.looking = false;
      builtInMicrophone.name = err ? null : builtInMicrophoneName(String(stdout));
    });
  } catch {
    builtInMicrophone.looking = false;
  }
}

/** It could not be opened (lid just closed, a stale name): look it up again before the next recording. */
function builtInMicrophoneFailed(microphone: BuiltInMicrophone): void {
  microphone.failures++;
  microphone.name = undefined;
}

interface VoiceRecorderDeps {
  platform?: NodeJS.Platform;
  hasCommand?: (command: string) => boolean;
  spawnRecorder?: (command: string, args: string[]) => ChildProcess;
  /** macOS: the built-in microphone, in place of the one looked up for this process. */
  builtInMicrophone?: BuiltInMicrophone;
  /** macOS: the default input device's CoreAudio transport type ("blue", "bltn", …). */
  defaultInputTransport?: () => string | null;
  note?: (message: string) => void;
}

/** One recorder process writing one WAV file. */
class RecorderProcess {
  /** Resolves when the recorder process is gone, however it ended. */
  readonly exitPromise: Promise<void>;
  private stderr = "";

  constructor(private readonly child: ChildProcess, readonly filePath: string) {
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderr = (this.stderr + text).slice(-4000);
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.once("error", () => resolve());
    });
  }

  /** Ask the recorder to finish its file, escalating if it does not exit. */
  async stop(): Promise<void> {
    this.child.kill("SIGINT");
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          this.child.kill("SIGTERM");
          resolve();
        }, 2000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await Promise.race([
        this.exitPromise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            this.child.kill("SIGKILL");
            resolve();
          }, 1000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    await this.exitPromise;
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  errorMessage(): string {
    return recorderErrorMessage(this.stderr);
  }

  /** The recorded file, or null when the recorder left none. */
  read(): Buffer | null {
    return existsSync(this.filePath) ? readFileSync(this.filePath) : null;
  }
}

function hasSound(bytes: Buffer | null): boolean {
  return !!bytes && bytes.length > 0 && !isDigitallySilentWav(bytes);
}

type SpawnRecorder = (command: string, args: string[]) => ChildProcess;

/**
 * Records one hold-to-talk clip.
 *
 * Linux, and macOS with a wired, USB or built-in default input: the default
 * input device. On a Mac with a built-in microphone that one is recorded too
 * and used when the default input's recording is all zeros or missing.
 *
 * macOS with a Bluetooth default input (AirPods): the built-in microphone
 * alone. Opening a headset's microphone pulls the headset over from whatever
 * device is playing to it, drops its playback to call quality, loses the
 * first ~0.5 s while the microphone link comes up, and right after such a
 * handover can record nothing but zeros.
 */
export class VoiceRecorder {
  private finished = false;
  /** The built-in microphone is being recorded in place of a Bluetooth default input. */
  private insteadOfBluetooth = false;
  private backupMicrophone: BuiltInMicrophone | null = null;

  private constructor(
    private primary: RecorderProcess,
    /** The built-in microphone, recorded next to a default input that is not Bluetooth. */
    private readonly backup: RecorderProcess | null,
    private readonly tmpDir: string,
    private readonly platform: NodeJS.Platform,
    private readonly note: (message: string) => void,
  ) {}

  static start(deps: VoiceRecorderDeps = {}): VoiceRecorder {
    const platform = deps.platform ?? process.platform;
    const hasCommand = deps.hasCommand ?? commandExists;
    const spawnRecorder: SpawnRecorder = deps.spawnRecorder
      ?? ((command, args) => spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }));
    const note = deps.note ?? (() => {});
    const tmpDir = mkdtempSync(join(tmpdir(), "exocortex-voice-"));
    const filePath = join(tmpDir, "input.wav");
    const command = chooseRecorderCommand(platform, hasCommand, filePath);
    if (!command) {
      cleanupPath(tmpDir);
      throw new Error(recorderDependencyMessage(platform));
    }
    const record = (recorder: RecorderCommand, path: string) => new RecorderProcess(spawnRecorder(recorder.command, recorder.args), path);

    // An explicitly chosen device is recorded alone.
    if (platform !== "darwin" || process.env.EXOCORTEX_VOICE_AVFOUNDATION_DEVICE) {
      return new VoiceRecorder(record(command, filePath), null, tmpDir, platform, note);
    }

    if (!deps.builtInMicrophone) prepareVoiceRecorder();
    const microphone = deps.builtInMicrophone ?? builtInMicrophone;
    const builtInPath = join(tmpDir, "built-in.wav");
    const builtInCommand = microphone.name && microphone.failures < BUILT_IN_MICROPHONE_MAX_FAILURES
      ? chooseDarwinRecorderCommand(hasCommand, builtInPath, `none:${microphone.name}`)
      : null;

    if (builtInCommand && isBluetoothTransport((deps.defaultInputTransport ?? defaultInputTransport)())) {
      note("voice: the default input is a Bluetooth device; recording the built-in microphone instead");
      const builtIn = record(builtInCommand, builtInPath);
      const recorder = new VoiceRecorder(builtIn, null, tmpDir, platform, note);
      recorder.insteadOfBluetooth = true;
      void builtIn.exitPromise.then(() => {
        if (recorder.finished) {
          if (builtIn.read()) microphone.failures = 0;
          return;
        }
        // It could not be opened: record the default input for the rest of this hold.
        builtInMicrophoneFailed(microphone);
        note(`voice: the built-in microphone could not be recorded (${builtIn.errorMessage() || "recorder exited"}); recording the default input`);
        recorder.insteadOfBluetooth = false;
        try {
          recorder.primary = record(command, filePath);
        } catch {
          // stop() reports the built-in recorder's error.
        }
      });
      return recorder;
    }

    let backup: RecorderProcess | null = null;
    if (builtInCommand) {
      try {
        backup = record(builtInCommand, builtInPath);
      } catch {
        // The default input is still being recorded.
      }
    }
    const recorder = new VoiceRecorder(record(command, filePath), backup, tmpDir, platform, note);
    recorder.backupMicrophone = microphone;
    return recorder;
  }

  async stop(): Promise<RecordedVoiceClip> {
    if (!this.finished) {
      this.finished = true;
      await Promise.all([this.primary.stop(), this.backup?.stop()]);
    }

    try {
      const bytes = this.primary.read();
      const backupBytes = this.backup?.read() ?? null;
      if (this.backup && this.backupMicrophone) {
        if (backupBytes) {
          this.backupMicrophone.failures = 0;
        } else {
          builtInMicrophoneFailed(this.backupMicrophone);
          this.note(`voice: the built-in microphone was not recorded: ${this.backup.errorMessage() || "no audio file"}`);
        }
      }
      if (bytes && hasSound(bytes)) return { bytes, mimeType: "audio/wav" };
      if (backupBytes && hasSound(backupBytes)) {
        this.note(`voice: the default input ${bytes?.length ? "recorded only silence" : "recorded nothing"}; used the built-in microphone's recording`);
        return { bytes: backupBytes, mimeType: "audio/wav" };
      }
      const stderr = this.primary.errorMessage();
      if (!bytes) {
        throw new Error(stderr || "no audio file was captured; check microphone access and hold Space while speaking");
      }
      if (bytes.length === 0) {
        throw new Error(stderr || "captured audio file was empty; check microphone access and hold Space while speaking");
      }
      if (this.insteadOfBluetooth) {
        this.note("voice: the built-in microphone recorded only silence");
        throw new Error(stderr || "the built-in microphone recorded only silence (it is used while the input device is a Bluetooth headset)");
      }
      this.note("voice: the default input recorded only silence");
      throw new Error(stderr || silentCaptureMessage(this.platform));
    } finally {
      cleanupPath(this.tmpDir);
    }
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.primary.kill();
    this.backup?.kill();
    cleanupPath(this.tmpDir);
  }
}
