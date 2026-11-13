import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** undefined: not looked up yet; null: this Mac has no built-in microphone right now. */
let darwinBackupMicrophone: string | null | undefined;
let darwinBackupMicrophoneLookup = false;

/**
 * Look up the Mac's built-in microphone in the background so a recording can
 * capture it next to the default input (see VoiceRecorder). Takes ~0.7 s, so
 * it runs at startup and again before a recording that still has no answer.
 */
export function prepareVoiceRecorder(): void {
  if (process.platform !== "darwin" || process.env.EXOCORTEX_VOICE_AVFOUNDATION_DEVICE) return;
  if (darwinBackupMicrophone || darwinBackupMicrophoneLookup) return;
  darwinBackupMicrophoneLookup = true;
  try {
    execFile("system_profiler", ["SPAudioDataType", "-json"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      darwinBackupMicrophoneLookup = false;
      darwinBackupMicrophone = err ? null : builtInMicrophoneName(String(stdout));
    });
  } catch {
    darwinBackupMicrophoneLookup = false;
  }
}

const BACKUP_FILE_NAME = "backup.wav";

interface VoiceRecorderDeps {
  platform?: NodeJS.Platform;
  hasCommand?: (command: string) => boolean;
  spawnRecorder?: (command: string, args: string[]) => ChildProcess;
  /** macOS: a second microphone recorded alongside the default input; null for none. */
  backupMicrophone?: string | null;
  note?: (message: string) => void;
}

/** One recorder process writing one WAV file. */
class RecorderProcess {
  private readonly exitPromise: Promise<void>;
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

export class VoiceRecorder {
  private finished = false;

  private constructor(
    private readonly primary: RecorderProcess,
    /**
     * macOS only: the built-in microphone, recorded at the same time. A
     * Bluetooth headset that another device was just using (AirPods playing
     * from an iPhone) can hand the default input over without ever starting
     * its microphone link, and that whole recording is zeros; the words are
     * then taken from this one instead of being lost.
     */
    private readonly backup: RecorderProcess | null,
    private readonly tmpDir: string,
    private readonly platform: NodeJS.Platform,
    private readonly note: (message: string) => void,
  ) {}

  static start(deps: VoiceRecorderDeps = {}): VoiceRecorder {
    const platform = deps.platform ?? process.platform;
    const hasCommand = deps.hasCommand ?? commandExists;
    const spawnRecorder = deps.spawnRecorder
      ?? ((command: string, args: string[]) => spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }));
    const tmpDir = mkdtempSync(join(tmpdir(), "exocortex-voice-"));
    const filePath = join(tmpDir, "input.wav");
    const recorder = chooseRecorderCommand(platform, hasCommand, filePath);
    if (!recorder) {
      cleanupPath(tmpDir);
      throw new Error(recorderDependencyMessage(platform));
    }
    const primary = new RecorderProcess(spawnRecorder(recorder.command, recorder.args), filePath);

    let backup: RecorderProcess | null = null;
    if (platform === "darwin") {
      let microphone = deps.backupMicrophone;
      if (microphone === undefined) {
        // An explicitly chosen device is recorded alone.
        prepareVoiceRecorder();
        microphone = process.env.EXOCORTEX_VOICE_AVFOUNDATION_DEVICE ? null : darwinBackupMicrophone;
      }
      const backupPath = join(tmpDir, BACKUP_FILE_NAME);
      const command = microphone ? chooseDarwinRecorderCommand(hasCommand, backupPath, `none:${microphone}`) : null;
      if (command) {
        try {
          backup = new RecorderProcess(spawnRecorder(command.command, command.args), backupPath);
        } catch {
          // The default input is still being recorded.
        }
      }
    }
    return new VoiceRecorder(primary, backup, tmpDir, platform, deps.note ?? (() => {}));
  }

  async stop(): Promise<RecordedVoiceClip> {
    if (!this.finished) {
      this.finished = true;
      await Promise.all([this.primary.stop(), this.backup?.stop()]);
    }

    try {
      const bytes = this.primary.read();
      const backupBytes = this.backup?.read() ?? null;
      if (this.backup && !backupBytes) {
        this.note(`voice: the built-in microphone was not recorded: ${this.backup.errorMessage() || "no audio file"}`);
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
