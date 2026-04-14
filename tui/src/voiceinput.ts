/**
 * Hold-to-talk prompt controller.
 *
 * Keeps voice-specific state transitions out of main.ts so the TUI event loop
 * stays readable. Owns the recording/transcription lifecycle, inline spinner,
 * and transcript insertion back into the prompt buffer.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import { pushSystemMessage } from "./state";
import { theme } from "./theme";
import { pushUndo } from "./undo";
import { VoiceRecorder, VOICE_SPINNER_FRAMES, insertVoiceTranscript, type RecordedVoiceClip } from "./voice";

const VOICE_RECORDING_REPEAT_INITIAL_GRACE_MS = 1000;
const VOICE_RECORDING_REPEAT_IDLE_TIMEOUT_MS = 250;
const VOICE_SPINNER_INTERVAL_MS = 80;
const VOICE_MIN_RECORDING_MS = 1000;

interface VoiceRecorderLike {
  stop(): Promise<RecordedVoiceClip>;
  abort(): void;
}

interface VoiceTranscribeClient {
  transcribeAudio(
    audioBase64: string,
    mimeType: string,
    onSuccess: (text: string) => void,
    onError?: (message: string) => void,
  ): void;
}

interface VoiceSession {
  animationTimer: ReturnType<typeof setInterval> | null;
  recorder: VoiceRecorderLike | null;
  recordingStartedAt: number;
  lastSpaceRepeatAt: number;
  insertionPos: number;
  prefixText: string;
}

export interface VoiceInputController {
  handleKey(key: KeyEvent): boolean;
  isBlockingMouse(): boolean;
  cleanup(): void;
}

interface VoiceInputDeps {
  startRecorder?: () => VoiceRecorderLike;
  now?: () => number;
}

export function createVoiceInputController(
  state: RenderState,
  daemon: VoiceTranscribeClient,
  scheduleRender: () => void,
  deps: VoiceInputDeps = {},
): VoiceInputController {
  const startRecorder = deps.startRecorder ?? (() => VoiceRecorder.start());
  const now = deps.now ?? (() => Date.now());
  const session: VoiceSession = {
    animationTimer: null,
    recorder: null,
    recordingStartedAt: 0,
    lastSpaceRepeatAt: 0,
    insertionPos: 0,
    prefixText: "",
  };

  function isVoicePromptFocused(): boolean {
    return state.panelFocus === "chat"
      && state.chatFocus === "prompt"
      && state.vim.mode === "normal"
      && !state.queuePrompt
      && !state.editMessagePrompt
      && !state.search?.barOpen;
  }

  function isVoicePassthroughKey(key: KeyEvent): boolean {
    return key.type === "ctrl-c";
  }

  function stopVoiceAnimation(): void {
    if (!session.animationTimer) return;
    clearInterval(session.animationTimer);
    session.animationTimer = null;
  }

  function resetVoiceOverlay(): void {
    state.voicePrompt = null;
    stopVoiceAnimation();
    session.insertionPos = 0;
    session.prefixText = "";
    session.recordingStartedAt = 0;
    session.lastSpaceRepeatAt = 0;
  }

  function deriveVoicePrefixText(insertionPos: number): string {
    if (insertionPos <= 0) return "";
    const prevChar = state.inputBuffer[insertionPos - 1];
    return /\s/.test(prevChar) ? "" : " ";
  }

  function maybeStopVoiceRecordingFromIdle(): void {
    if (!session.recorder || state.voicePrompt?.phase !== "recording") return;
    const currentTime = now();
    if (currentTime - session.recordingStartedAt < VOICE_RECORDING_REPEAT_INITIAL_GRACE_MS) return;
    if (currentTime - session.lastSpaceRepeatAt < VOICE_RECORDING_REPEAT_IDLE_TIMEOUT_MS) return;
    void stopVoiceRecordingAndTranscribe();
  }

  function startVoiceAnimation(): void {
    if (session.animationTimer) return;
    session.animationTimer = setInterval(() => {
      if (!state.voicePrompt) {
        stopVoiceAnimation();
        return;
      }
      state.voicePrompt.frameIndex = (state.voicePrompt.frameIndex + 1) % VOICE_SPINNER_FRAMES.length;
      maybeStopVoiceRecordingFromIdle();
      scheduleRender();
    }, VOICE_SPINNER_INTERVAL_MS);
  }

  function showVoiceError(prefix: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    resetVoiceOverlay();
    pushSystemMessage(state, `✗ ${prefix}: ${message}`, theme.error);
    scheduleRender();
  }

  function showVoiceErrorMessage(message: string): void {
    resetVoiceOverlay();
    pushSystemMessage(state, `✗ ${message}`, theme.error);
    scheduleRender();
  }

  async function startVoiceRecording(insertionPos: number): Promise<void> {
    if (session.recorder || state.voicePrompt?.phase === "transcribing") return;

    try {
      session.recorder = startRecorder();
    } catch (err) {
      showVoiceError("Voice capture failed", err);
      return;
    }

    session.insertionPos = insertionPos;
    session.prefixText = deriveVoicePrefixText(insertionPos);
    session.recordingStartedAt = now();
    session.lastSpaceRepeatAt = session.recordingStartedAt;
    state.autocomplete = null;
    state.voicePrompt = {
      phase: "recording",
      frameIndex: 0,
      insertionPos,
    };
    startVoiceAnimation();
    scheduleRender();
  }

  function applyTranscript(text: string, insertionPos: number, prefixText: string): void {
    const prevBuffer = state.inputBuffer;
    const prevCursor = state.cursorPos;
    resetVoiceOverlay();
    pushUndo(state.undo, prevBuffer, prevCursor);
    const next = insertVoiceTranscript(prevBuffer, prevCursor, insertionPos, text, prefixText);
    state.inputBuffer = next.buffer;
    state.cursorPos = next.cursorPos;
    state.autocomplete = null;
    scheduleRender();
  }

  async function stopVoiceRecordingAndTranscribe(): Promise<void> {
    const recorder = session.recorder;
    if (!recorder) return;
    session.recorder = null;

    const insertionPos = session.insertionPos;
    const prefixText = session.prefixText;
    const recordingDurationMs = now() - session.recordingStartedAt;

    state.voicePrompt = {
      phase: "transcribing",
      frameIndex: 0,
      insertionPos,
    };
    startVoiceAnimation();
    scheduleRender();

    let clip: RecordedVoiceClip;
    try {
      clip = await recorder.stop();
    } catch (err) {
      showVoiceError("Voice capture failed", err);
      return;
    }

    if (recordingDurationMs < VOICE_MIN_RECORDING_MS) {
      resetVoiceOverlay();
      scheduleRender();
      return;
    }

    try {
      daemon.transcribeAudio(
        clip.bytes.toString("base64"),
        clip.mimeType,
        (text) => applyTranscript(text, insertionPos, prefixText),
        (message) => {
          showVoiceErrorMessage(message);
        },
      );
    } catch (err) {
      showVoiceError("Voice transcription failed", err);
    }
  }

  function cleanup(): void {
    if (session.recorder) {
      session.recorder.abort();
      session.recorder = null;
    }
    resetVoiceOverlay();
  }

  function handleKey(key: KeyEvent): boolean {
    if (state.voicePrompt?.phase === "transcribing") {
      return !isVoicePassthroughKey(key);
    }

    if (session.recorder) {
      if (key.type === "char" && key.char === " ") {
        session.lastSpaceRepeatAt = now();
        return true;
      }
      if (isVoicePassthroughKey(key)) return false;
      void stopVoiceRecordingAndTranscribe();
      return true;
    }

    if (!isVoicePromptFocused()) return false;
    if (key.type !== "char" || key.char !== " ") return false;

    void startVoiceRecording(state.cursorPos);
    return true;
  }

  function isBlockingMouse(): boolean {
    return !!session.recorder || state.voicePrompt?.phase === "transcribing";
  }

  return {
    handleKey,
    isBlockingMouse,
    cleanup,
  };
}
