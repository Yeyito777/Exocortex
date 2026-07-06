/**
 * Hold-to-talk prompt controller.
 *
 * Keeps voice-specific state transitions out of main.ts so the TUI event loop
 * stays readable. Owns the recording/transcription lifecycle, inline spinner,
 * and transcript insertion back into the prompt buffer.
 */

import type { KeyEvent } from "./input";
import type { QueuedMessage, RenderState } from "./state";
import { focusPrompt, pushSystemMessage } from "./state";
import { theme } from "./theme";
import { pushUndo } from "./undo";
import {
  VoiceRecorder,
  VOICE_SPINNER_FRAMES,
  insertVoiceTranscriptPreservingCursor,
  renderSubmittedVoicePrompt,
  sortVoicePromptJobs,
  type RecordedVoiceClip,
  type VoicePromptState,
} from "./voice";
import type { EffortLevel, ImageAttachment, ModelId, ProviderId, UserMessage } from "./messages";
import type { QueueTiming } from "./protocol";
import { removePendingVoiceEchoes } from "./pendingvoice";
import {
  deriveVoicePrefixText,
  deriveVoiceSuffixText,
  resolveVoiceInsertionPos,
} from "./voiceposition";
import { expandMacros } from "./macros";

const VOICE_RECORDING_REPEAT_INITIAL_GRACE_MS = 1000;
const VOICE_RECORDING_REPEAT_IDLE_TIMEOUT_MS = 250;
const VOICE_SPINNER_INTERVAL_MS = 80;
const VOICE_MIN_RECORDING_MS = 500;

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

export interface SubmittedVoiceTranscription {
  message: UserMessage;
  queuedMessage?: { convId: string; text: string; timing: QueueTiming; images?: ImageAttachment[] };
  startedAt: number;
  images?: ImageAttachment[];
  convId: string | null;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  folderId: string | null;
  wasStreaming: boolean;
}

export interface SubmitVoiceTranscriptionOptions {
  queueTiming?: QueueTiming;
}

interface SubmittedVoiceSession {
  submission: SubmittedVoiceTranscription;
  buffer: string;
  jobs: VoicePromptState[];
}

interface VoiceSession {
  animationTimer: ReturnType<typeof setInterval> | null;
  recorder: VoiceRecorderLike | null;
  submitted: SubmittedVoiceSession | null;
  nextPromptJobId: number;
  recordingJobId: number | null;
  recordingStartedAt: number;
  lastSpaceRepeatAt: number;
  insertionPos: number;
  prefixText: string;
  suffixText: string;
}

export interface VoiceInputController {
  handleKey(key: KeyEvent): boolean;
  submitActiveTranscription(options?: SubmitVoiceTranscriptionOptions): boolean;
  recallSubmittedTranscription(target: UserMessage | QueuedMessage | null | undefined, fallbackText?: string): SubmittedVoiceTranscription | null;
  syncPromptEdit(previousBuffer: string): void;
  isBlockingMouse(): boolean;
  cleanup(): void;
}

interface VoiceInputDeps {
  startRecorder?: () => VoiceRecorderLike;
  now?: () => number;
  submitPendingTranscription?: (placeholderText: string, options?: SubmitVoiceTranscriptionOptions) => SubmittedVoiceTranscription | null;
  completePendingTranscription?: (submission: SubmittedVoiceTranscription, finalText: string) => void;
  failPendingTranscription?: (submission: SubmittedVoiceTranscription, message: string) => void;
  recallPendingTranscription?: (submission: SubmittedVoiceTranscription) => void;
  shouldQueuePendingTranscription?: () => boolean;
  openPendingTranscriptionQueuePrompt?: (previewText: string) => void;
  invalidateHistory?: () => void;
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
    submitted: null,
    nextPromptJobId: 1,
    recordingJobId: null,
    recordingStartedAt: 0,
    lastSpaceRepeatAt: 0,
    insertionPos: 0,
    prefixText: "",
    suffixText: "",
  };

  function isVoicePromptContext(): boolean {
    return state.panelFocus === "chat"
      && state.chatFocus === "prompt"
      && !state.queuePrompt
      && !state.editMessagePrompt
      && !state.search?.barOpen;
  }

  function isVoicePromptFocused(): boolean {
    return isVoicePromptContext() && state.vim.mode === "normal";
  }

  function isVoicePassthroughKey(key: KeyEvent): boolean {
    return key.type === "ctrl-c" || key.type === "ctrl-a" || key.type === "ctrl-r";
  }

  function stopVoiceAnimation(): void {
    if (!session.animationTimer) return;
    clearInterval(session.animationTimer);
    session.animationTimer = null;
  }

  function resetVoiceOverlay(): void {
    state.voicePrompt = null;
    state.voicePromptJobs = [];
    if (session.submitted) state.voiceMessage = null;
    stopVoiceAnimation();
    session.submitted = null;
    session.insertionPos = 0;
    session.prefixText = "";
    session.suffixText = "";
    session.recordingStartedAt = 0;
    session.recordingJobId = null;
    session.lastSpaceRepeatAt = 0;
  }

  function promptSpacingJobs(): VoicePromptState[] {
    return [...state.voicePromptJobs, ...(state.voicePrompt ? [state.voicePrompt] : [])];
  }

  function voicePrefixText(insertionPos: number, jobId?: number): string {
    return deriveVoicePrefixText(state.inputBuffer, insertionPos, promptSpacingJobs(), jobId);
  }

  function voiceSuffixText(insertionPos: number): string {
    return deriveVoiceSuffixText(state.inputBuffer, insertionPos);
  }

  function refreshVoiceSpacingAt(insertionPos: number): void {
    for (const voice of promptSpacingJobs()) {
      if (voice.insertionPos !== insertionPos) continue;
      voice.prefixText = voicePrefixText(voice.insertionPos, voice.id);
      voice.suffixText = voiceSuffixText(voice.insertionPos);
      if (state.voicePrompt === voice) {
        session.prefixText = voice.prefixText;
        session.suffixText = voice.suffixText;
      }
    }
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
      const hasSubmittedJobs = !!session.submitted?.jobs.some(job => job.completedText === undefined);
      if (!state.voicePrompt && state.voicePromptJobs.length === 0 && !state.voiceMessage && !hasSubmittedJobs) {
        stopVoiceAnimation();
        return;
      }
      if (state.voicePrompt) {
        state.voicePrompt.frameIndex = (state.voicePrompt.frameIndex + 1) % VOICE_SPINNER_FRAMES.length;
      }
      for (const job of state.voicePromptJobs) {
        job.frameIndex = (job.frameIndex + 1) % VOICE_SPINNER_FRAMES.length;
      }
      if (state.voiceMessage) {
        state.voiceMessage.frameIndex = (state.voiceMessage.frameIndex + 1) % VOICE_SPINNER_FRAMES.length;
      }
      updateSubmittedPlaceholderText();
      maybeStopVoiceRecordingFromIdle();
      scheduleRender();
    }, VOICE_SPINNER_INTERVAL_MS);
  }

  function failSubmittedTranscription(message: string): void {
    const submitted = session.submitted;
    if (!submitted) return;
    deps.failPendingTranscription?.(submitted.submission, message);
    resetVoiceOverlay();
    scheduleRender();
  }

  function updateSubmittedMessageText(): void {
    if (!session.submitted) return;
    const text = renderSubmittedPreview(
      session.submitted.buffer,
      session.submitted.jobs,
    );
    session.submitted.submission.message.text = text;
    if (session.submitted.submission.queuedMessage) {
      session.submitted.submission.queuedMessage.text = text;
    }
    deps.invalidateHistory?.();
  }

  function maybeCompleteSubmittedTranscription(): void {
    const submitted = session.submitted;
    if (!submitted || submitted.jobs.some(job => job.completedText === undefined)) return;
    const finalText = renderSubmittedVoicePrompt(submitted.buffer, submitted.jobs);
    deps.completePendingTranscription?.(submitted.submission, finalText);
    resetVoiceOverlay();
    scheduleRender();
  }

  function renderSubmittedPreview(buffer: string, jobs: VoicePromptState[]): string {
    return expandMacros(renderSubmittedVoicePrompt(buffer, jobs));
  }

  function activeTranscriptionPreviewText(): string {
    const frameIndex = state.voicePrompt?.frameIndex ?? 0;
    const activeJob: VoicePromptState | null = state.voicePrompt
      ? {
        ...state.voicePrompt,
        phase: "transcribing",
        frameIndex,
        insertionPos: session.insertionPos,
        prefixText: session.prefixText,
        suffixText: session.suffixText,
      }
      : null;
    const jobs = [
      ...state.voicePromptJobs,
      ...(activeJob ? [activeJob] : []),
    ].map(job => ({ ...job }));
    return renderSubmittedPreview(state.inputBuffer, jobs);
  }

  function applySubmittedJobTranscript(jobId: number | null, text: string): void {
    const submitted = session.submitted;
    if (!submitted || jobId === null) return;
    const job = submitted.jobs.find(item => item.id === jobId);
    if (!job) return;
    job.completedText = text;
    updateSubmittedMessageText();
    maybeCompleteSubmittedTranscription();
    scheduleRender();
  }

  function applyTranscriptionResult(jobId: number | null, text: string): void {
    if (jobId === null) return;
    const submitted = session.submitted;
    if (submitted?.jobs.some(item => item.id === jobId)) {
      applySubmittedJobTranscript(jobId, text);
      return;
    }
    applyPromptTranscript(jobId, text);
  }

  function failSubmittedJob(jobId: number | null, message: string): void {
    const submitted = session.submitted;
    if (!submitted || jobId === null) return;
    const job = submitted.jobs.find(item => item.id === jobId);
    if (!job) return;
    job.completedText = "";
    updateSubmittedMessageText();
    if (submitted.jobs.every(item => item.completedText !== undefined)) {
      maybeCompleteSubmittedTranscription();
    } else {
      scheduleRender();
    }
    pushSystemMessage(state, `✗ ${message}`, theme.error);
  }

  function failTranscriptionJob(jobId: number | null, message: string): void {
    if (jobId === null) return;
    const submitted = session.submitted;
    if (submitted?.jobs.some(item => item.id === jobId)) {
      failSubmittedJob(jobId, message);
      return;
    }
    failPromptJob(jobId, message);
  }

  function removePromptJob(jobId: number): VoicePromptState | null {
    const job = state.voicePromptJobs.find(item => item.id === jobId) ?? null;
    if (!job) return null;
    state.voicePromptJobs = state.voicePromptJobs.filter(item => item.id !== jobId);
    return job;
  }

  function sortedPromptJobs(): VoicePromptState[] {
    return sortVoicePromptJobs(state.voicePromptJobs);
  }

  function shiftPromptJobsAfter(insertionPos: number, delta: number): void {
    if (delta === 0) return;
    for (const job of state.voicePromptJobs) {
      if (job.insertionPos >= insertionPos) job.insertionPos += delta;
    }
    if (state.voicePrompt && state.voicePrompt.insertionPos >= insertionPos) {
      state.voicePrompt.insertionPos += delta;
      session.insertionPos = state.voicePrompt.insertionPos;
    }
  }

  function flushCompletedPromptJobs(): void {
    let flushed = false;

    while (true) {
      const job = sortedPromptJobs().find(candidate => {
        if (candidate.completedText === undefined) return false;
        return !state.voicePromptJobs.some(other =>
          other.completedText === undefined
          && other.insertionPos === candidate.insertionPos
          && (other.id ?? 0) < (candidate.id ?? 0));
      });
      if (!job?.id) break;

      removePromptJob(job.id);
      const normalized = job.completedText?.trim() ?? "";
      if (!normalized) {
        refreshVoiceSpacingAt(job.insertionPos);
        flushed = true;
        continue;
      }

      const prevBuffer = state.inputBuffer;
      const prevCursor = state.cursorPos;
      pushUndo(state.undo, prevBuffer, prevCursor);
      const hasLaterJobAtSameInsertion = state.voicePromptJobs.some(other =>
        other.id !== job.id
        && other.insertionPos === job.insertionPos
        && (other.id ?? 0) > (job.id ?? 0)
      );
      const suffixText = hasLaterJobAtSameInsertion ? "" : job.suffixText ?? "";
      const next = insertVoiceTranscriptPreservingCursor(prevBuffer, prevCursor, job.insertionPos, normalized, job.prefixText ?? "", suffixText);
      state.inputBuffer = next.buffer;
      state.cursorPos = next.cursorPos;
      shiftPromptJobsAfter(job.insertionPos, next.buffer.length - prevBuffer.length);
      state.autocomplete = null;
      flushed = true;
    }

    if (flushed) scheduleRender();
  }

  function applyPromptTranscript(jobId: number, text: string): void {
    const job = state.voicePromptJobs.find(item => item.id === jobId);
    if (!job) {
      applySubmittedJobTranscript(jobId, text);
      return;
    }
    job.completedText = text;
    flushCompletedPromptJobs();
  }

  function failPromptJob(jobId: number, message: string): void {
    const removed = removePromptJob(jobId);
    if (!removed && session.submitted) {
      failSubmittedJob(jobId, message);
      return;
    }
    pushSystemMessage(state, `✗ ${message}`, theme.error);
    scheduleRender();
  }

  function deleteVoicePromptBeforeCursor(): boolean {
    const jobsAtCursor = sortVoicePromptJobs(state.voicePromptJobs)
      .filter(job => job.insertionPos === state.cursorPos);
    const job = jobsAtCursor.at(-1);
    if (!job?.id) return false;

    removePromptJob(job.id);
    refreshVoiceSpacingAt(job.insertionPos);
    scheduleRender();
    return true;
  }

  function updateSubmittedPlaceholderText(): void {
    if (!session.submitted) return;
    let changed = false;
    for (const job of session.submitted.jobs) {
      if (job.completedText === undefined) {
        job.frameIndex = (job.frameIndex + 1) % VOICE_SPINNER_FRAMES.length;
        changed = true;
      }
    }
    if (changed) updateSubmittedMessageText();
  }

  function showVoiceError(prefix: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (session.submitted) {
      failSubmittedTranscription(`${prefix}: ${message}`);
      return;
    }
    resetVoiceOverlay();
    pushSystemMessage(state, `✗ ${prefix}: ${message}`, theme.error);
    scheduleRender();
  }

  async function startVoiceRecording(insertionPos: number): Promise<void> {
    if (session.recorder || session.submitted || state.voiceMessage) return;

    try {
      session.recorder = startRecorder();
    } catch (err) {
      showVoiceError("Voice capture failed", err);
      return;
    }

    session.insertionPos = insertionPos;
    const jobId = session.nextPromptJobId++;
    session.prefixText = voicePrefixText(insertionPos, jobId);
    session.suffixText = voiceSuffixText(insertionPos);
    session.recordingStartedAt = now();
    session.lastSpaceRepeatAt = session.recordingStartedAt;
    state.autocomplete = null;
    session.recordingJobId = jobId;
    state.voicePrompt = {
      id: jobId,
      phase: "recording",
      frameIndex: 0,
      insertionPos,
      prefixText: session.prefixText,
      suffixText: session.suffixText,
    };
    startVoiceAnimation();
    scheduleRender();
  }

  function enterTranscribingPhase(insertionPos: number): number | null {
    if (session.submitted) {
      state.voicePrompt = null;
      if (state.voiceMessage) {
        state.voiceMessage.phase = "transcribing";
        state.voiceMessage.frameIndex = 0;
        updateSubmittedPlaceholderText();
      }
      startVoiceAnimation();
      scheduleRender();
      return null;
    } else {
      const job: VoicePromptState = {
        id: state.voicePrompt?.id ?? session.nextPromptJobId++,
        phase: "transcribing",
        frameIndex: 0,
        insertionPos,
        prefixText: session.prefixText,
        suffixText: session.suffixText,
      };
      state.voicePrompt = null;
      state.voicePromptJobs.push(job);
      state.cursorPos = insertionPos;
      state.panelFocus = "chat";
      state.chatFocus = "prompt";
      state.autocomplete = null;
      startVoiceAnimation();
      scheduleRender();
      return job.id ?? null;
    }
  }

  function submitActiveTranscription(options: SubmitVoiceTranscriptionOptions = {}): boolean {
    if (session.submitted || !deps.submitPendingTranscription) return false;
    if (!state.voicePrompt && state.voicePromptJobs.length === 0) return false;

    const buffer = state.inputBuffer;
    const insertionPos = session.insertionPos;
    const prefixText = session.prefixText;
    const suffixText = session.suffixText;
    const frameIndex = state.voicePrompt?.frameIndex ?? 0;
    const activeJob: VoicePromptState | null = state.voicePrompt
      ? { ...state.voicePrompt, phase: "transcribing", frameIndex, insertionPos, prefixText, suffixText }
      : null;
    const jobs = [
      ...state.voicePromptJobs,
      ...(activeJob ? [activeJob] : []),
    ].map(job => ({ ...job }));
    const pendingText = renderSubmittedPreview(buffer, jobs);
    const submission = deps.submitPendingTranscription(pendingText, options);
    if (!submission) return false;

    session.submitted = { submission, buffer, jobs };
    state.autocomplete = null;
    state.voicePrompt = null;
    state.voicePromptJobs = [];
    if (!state.voiceMessage || state.voiceMessage.message !== submission.message) {
      state.voiceMessage = { message: submission.message, phase: "transcribing", frameIndex };
    } else {
      state.voiceMessage.phase = "transcribing";
      state.voiceMessage.frameIndex = frameIndex;
    }
    updateSubmittedPlaceholderText();
    startVoiceAnimation();
    scheduleRender();
    return true;
  }

  function recallSubmittedTranscription(target: UserMessage | QueuedMessage | null | undefined, fallbackText?: string): SubmittedVoiceTranscription | null {
    const submitted = session.submitted;
    if (!submitted) return null;
    const submittedMessage = submitted.submission.message;
    const submittedQueued = submitted.submission.queuedMessage;
    const targetText = fallbackText ?? target?.text;
    const targetStartedAt = "metadata" in (target ?? {})
      ? (target as UserMessage).metadata?.startedAt
      : undefined;
    const bothLookLikePendingVoice = !!targetText?.includes("Transcribing…") && submittedMessage.text.includes("Transcribing…");
    const matchesMessage = submittedMessage === target
      || (targetStartedAt !== undefined && targetStartedAt === submitted.submission.startedAt)
      || (targetText !== undefined && targetText === submittedMessage.text)
      || bothLookLikePendingVoice;
    const matchesQueued = !!submittedQueued && (
      submittedQueued === target
      || (targetText !== undefined && targetText === submittedQueued.text)
    );
    if (!matchesMessage && !matchesQueued) return null;

    const targetMessage = target && "role" in target ? target : null;
    const targetQueuedMessage = target && "convId" in target ? target : null;

    state.inputBuffer = submitted.buffer;
    state.cursorPos = submitted.buffer.length;
    state.pendingImages = submitted.submission.images ? [...submitted.submission.images] : [];
    state.voicePrompt = null;
    state.voicePromptJobs = submitted.jobs.map(job => ({ ...job }));
    state.voiceMessage = null;
    state.autocomplete = null;
    session.submitted = null;
    removePendingVoiceEchoes(state, submitted.submission, {
      message: targetMessage,
      queuedMessage: targetQueuedMessage,
    });
    deps.recallPendingTranscription?.(submitted.submission);
    deps.invalidateHistory?.();
    focusPrompt(state);
    flushCompletedPromptJobs();
    if (state.voicePromptJobs.length > 0) {
      startVoiceAnimation();
    } else {
      stopVoiceAnimation();
    }
    scheduleRender();
    return submitted.submission;
  }

  async function stopVoiceRecordingAndTranscribe(): Promise<void> {
    const recorder = session.recorder;
    if (!recorder) return;
    session.recorder = null;

    const insertionPos = session.insertionPos;
    const recordingDurationMs = now() - session.recordingStartedAt;
    const recordingJobId = session.recordingJobId;

    const promptJobId = enterTranscribingPhase(insertionPos);

    let clip: RecordedVoiceClip;
    try {
      clip = await recorder.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (session.submitted) {
        failSubmittedTranscription(`Voice capture failed: ${message}`);
      } else if (promptJobId !== null) {
        failPromptJob(promptJobId, `Voice capture failed: ${message}`);
      } else {
        showVoiceError("Voice capture failed", err);
      }
      return;
    }

    if (recordingDurationMs < VOICE_MIN_RECORDING_MS) {
      if (session.submitted) {
        applySubmittedJobTranscript(recordingJobId, "");
        return;
      }
      if (promptJobId !== null) removePromptJob(promptJobId);
      scheduleRender();
      return;
    }

    try {
      daemon.transcribeAudio(
        clip.bytes.toString("base64"),
        clip.mimeType,
        (text) => {
          applyTranscriptionResult(recordingJobId ?? promptJobId, text);
        },
        (message) => {
          failTranscriptionJob(recordingJobId ?? promptJobId, message);
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (session.submitted) {
        showVoiceError("Voice transcription failed", err);
      } else if (promptJobId !== null) {
        failPromptJob(promptJobId, `Voice transcription failed: ${message}`);
      }
    }
  }

  function cleanup(): void {
    if (session.recorder) {
      session.recorder.abort();
      session.recorder = null;
    }
    resetVoiceOverlay();
  }

  function syncPromptEdit(previousBuffer: string): void {
    const voices = [...state.voicePromptJobs, ...(state.voicePrompt?.phase === "transcribing" ? [state.voicePrompt] : [])];
    if (voices.length === 0) return;
    const nextBuffer = state.inputBuffer;
    if (previousBuffer === nextBuffer) return;

    let prefix = 0;
    const minLength = Math.min(previousBuffer.length, nextBuffer.length);
    while (prefix < minLength && previousBuffer[prefix] === nextBuffer[prefix]) prefix++;

    let suffix = 0;
    while (
      suffix < previousBuffer.length - prefix
      && suffix < nextBuffer.length - prefix
      && previousBuffer[previousBuffer.length - 1 - suffix] === nextBuffer[nextBuffer.length - 1 - suffix]
    ) {
      suffix++;
    }

    const oldEditStart = prefix;
    const oldEditEnd = previousBuffer.length - suffix;
    const oldEditLength = oldEditEnd - oldEditStart;
    const newEditLength = nextBuffer.length - prefix - suffix;

    for (const voice of voices) {
      if (oldEditStart > voice.insertionPos) continue;
      if (oldEditStart === voice.insertionPos) {
        voice.suffixText = voiceSuffixText(voice.insertionPos);
        if (state.voicePrompt === voice) session.suffixText = voice.suffixText;
        continue;
      }
      if (oldEditEnd <= voice.insertionPos) {
        voice.insertionPos += newEditLength - oldEditLength;
      } else {
        voice.insertionPos = oldEditStart + newEditLength;
      }
      voice.insertionPos = Math.max(0, Math.min(nextBuffer.length, voice.insertionPos));
      voice.prefixText = voicePrefixText(voice.insertionPos, voice.id);
      voice.suffixText = voiceSuffixText(voice.insertionPos);
      if (state.voicePrompt === voice) {
        session.insertionPos = voice.insertionPos;
        session.prefixText = voice.prefixText;
        session.suffixText = voice.suffixText;
      }
    }
  }

  function handleKey(key: KeyEvent): boolean {
    // The main key dispatcher ignores release events, but voice input runs first
    // so it can see the space release that ends hold-to-talk recording.  Do not
    // let other key releases act as fresh commands: after Ctrl-W recalls a
    // still-transcribing job to the prompt, a terminal-reported Enter release can
    // otherwise immediately submit it back into chat history, producing the
    // visible prompt→history flicker.
    if (key.event === "release" && !(session.recorder && key.type === "char" && key.char === " ")) {
      return false;
    }

    if (session.recorder) {
      if (key.type === "char" && key.char === " ") {
        if (key.event === "release") {
          void stopVoiceRecordingAndTranscribe();
          return true;
        }
        session.lastSpaceRepeatAt = now();
        return true;
      }
      if (isVoicePassthroughKey(key)) return false;
      if (key.type === "enter") {
        submitActiveTranscription(
          deps.shouldQueuePendingTranscription?.()
            ? { queueTiming: "message-end" }
            : undefined,
        );
        void stopVoiceRecordingAndTranscribe();
        return true;
      }
      void stopVoiceRecordingAndTranscribe();
      return true;
    }

    if (key.type === "enter" && state.voicePromptJobs.length > 0 && isVoicePromptContext()) {
      if (deps.shouldQueuePendingTranscription?.() && deps.openPendingTranscriptionQueuePrompt) {
        state.autocomplete = null;
        deps.openPendingTranscriptionQueuePrompt(activeTranscriptionPreviewText());
        scheduleRender();
        return true;
      }
      return submitActiveTranscription();
    }

    if (key.type === "backspace" && state.voicePromptJobs.length > 0 && isVoicePromptContext()) {
      if (deleteVoicePromptBeforeCursor()) return true;
    }

    if (!isVoicePromptFocused()) return false;
    if (key.type !== "char" || key.char !== " ") return false;
    if (key.event === "release") return true;

    void startVoiceRecording(resolveVoiceInsertionPos(state.inputBuffer, state.cursorPos));
    return true;
  }

  function isBlockingMouse(): boolean {
    return !!session.recorder;
  }

  return {
    handleKey,
    submitActiveTranscription,
    recallSubmittedTranscription,
    syncPromptEdit,
    isBlockingMouse,
    cleanup,
  };
}
