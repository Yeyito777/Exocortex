import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VoicePromptPhase = "recording" | "transcribing";

export interface VoicePromptState {
  phase: VoicePromptPhase;
  frameIndex: number;
  insertionPos: number;
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

export function voicePlaceholderText(voice: VoicePromptState): string {
  const frame = VOICE_SPINNER_FRAMES[voice.frameIndex % VOICE_SPINNER_FRAMES.length];
  return voice.phase === "recording"
    ? `${frame} Listening…`
    : `${frame} Transcribing…`;
}

export function applyVoicePlaceholder(
  buffer: string,
  voice: VoicePromptState | null,
): string {
  if (!voice) return buffer;
  const placeholder = voicePlaceholderText(voice);
  return buffer.slice(0, voice.insertionPos) + placeholder + buffer.slice(voice.insertionPos);
}

export function insertVoiceTranscript(
  buffer: string,
  cursorPos: number,
  insertionPos: number,
  transcript: string,
  prefixText = "",
): { buffer: string; cursorPos: number } {
  const normalized = transcript.trim();
  if (!normalized) return { buffer, cursorPos };
  const inserted = `${prefixText}${normalized}`;
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
    if (process.platform !== "linux") {
      throw new Error(`Voice input is currently only implemented for Linux (got ${process.platform}).`);
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "exocortex-voice-"));
    const filePath = join(tmpDir, "input.wav");
    const recorder = chooseLinuxRecorderCommand(commandExists, filePath);
    if (!recorder) {
      cleanupPath(tmpDir);
      throw new Error("Voice input requires pw-record, arecord, or ffmpeg to be installed.");
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
