import { spawn, type ChildProcess } from "node:child_process";
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
      process.env.EXOCORTEX_VOICE_AVFOUNDATION_DEVICE || "none:default",
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

export class VoiceRecorder {
  private readonly child: ChildProcess;
  private readonly filePath: string;
  private readonly tmpDir: string;
  private readonly exitPromise: Promise<void>;
  private stderr = "";
  private finished = false;

  private constructor(child: ChildProcess, filePath: string, tmpDir: string) {
    this.child = child;
    this.filePath = filePath;
    this.tmpDir = tmpDir;
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderr = (this.stderr + text).slice(-4000);
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.once("error", () => resolve());
    });
  }

  static start(): VoiceRecorder {
    const tmpDir = mkdtempSync(join(tmpdir(), "exocortex-voice-"));
    const filePath = join(tmpDir, "input.wav");
    const recorder = chooseRecorderCommand(process.platform, commandExists, filePath);
    if (!recorder) {
      cleanupPath(tmpDir);
      throw new Error(recorderDependencyMessage(process.platform));
    }
    const child = spawn(recorder.command, recorder.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return new VoiceRecorder(child, filePath, tmpDir);
  }

  async stop(): Promise<RecordedVoiceClip> {
    if (!this.finished) {
      this.finished = true;
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

    try {
      if (!existsSync(this.filePath)) {
        throw new Error(this.stderr.trim() || "no audio file was captured");
      }
      const bytes = readFileSync(this.filePath);
      if (bytes.length === 0) {
        throw new Error(this.stderr.trim() || "captured audio file was empty");
      }
      return { bytes, mimeType: "audio/wav" };
    } finally {
      cleanupPath(this.tmpDir);
    }
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.child.kill("SIGKILL");
    cleanupPath(this.tmpDir);
  }
}
