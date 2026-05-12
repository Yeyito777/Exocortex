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
import { VoiceRecorder, VOICE_SPINNER_FRAMES, getRenderedVoicePrompt, insertVoiceTranscriptPreservingCursor, voicePlaceholderText, type RecordedVoiceClip, type VoicePromptState } from "./voice";
import type { EffortLevel, ImageAttachment, ModelId, ProviderId, UserMessage } from "./messages";
import { graphemeAt, nextGraphemeEnd } from "./graphemes";

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

interface SubmittedVoiceSession {
  submission: SubmittedVoiceTranscription;
  buffer: string;
  cursorPos: number;
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
  syncPromptEdit(previousBuffer: string): void;
  isBlockingMouse(): boolean;
  cleanup(): void;
}

interface VoiceInputDeps {
  startRecorder?: () => VoiceRecorderLike;
  now?: () => number;
  submitPendingTranscription?: (placeholderText: string) => SubmittedVoiceTranscription | null;
  completePendingTranscription?: (submission: SubmittedVoiceTranscription, finalText: string) => void;
  failPendingTranscription?: (submission: SubmittedVoiceTranscription, message: string) => void;
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

  function isVoicePromptFocused(): boolean {
    return state.panelFocus === "chat"
      && state.chatFocus === "prompt"
      && state.vim.mode === "normal"
      && !state.queuePrompt
      && !state.editMessagePrompt
      && !state.search?.barOpen;
  }

  function isVoicePassthroughKey(key: KeyEvent): boolean {
    return key.type === "ctrl-c" || key.type === "ctrl-a";
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

  function hasEarlierVoiceJobAtInsertion(insertionPos: number, jobId?: number): boolean {
    const jobs = [...state.voicePromptJobs, ...(state.voicePrompt ? [state.voicePrompt] : [])];
    return jobs.some(job =>
      job.insertionPos === insertionPos
      && (jobId === undefined || (job.id ?? 0) < jobId)
    );
  }

  function deriveVoicePrefixText(insertionPos: number, jobId?: number): string {
    if (hasEarlierVoiceJobAtInsertion(insertionPos, jobId)) return " ";
    if (insertionPos <= 0) return "";
    const prevChar = state.inputBuffer[insertionPos - 1];
    return /\s/.test(prevChar) ? "" : " ";
  }

  function deriveVoiceSuffixText(insertionPos: number): string {
    if (insertionPos >= state.inputBuffer.length) return "";
    const nextChar = graphemeAt(state.inputBuffer, insertionPos);
    return nextChar && !/\s/.test(nextChar) ? " " : "";
  }

  function lineEndFrom(pos: number): number {
    const newline = state.inputBuffer.indexOf("\n", pos);
    return newline === -1 ? state.inputBuffer.length : newline;
  }

  function resolveVoiceInsertionPos(cursorPos: number): number {
    const buffer = state.inputBuffer;
    if (cursorPos < 0) return 0;
    if (cursorPos >= buffer.length) return buffer.length;

    const char = graphemeAt(buffer, cursorPos);
    const charEnd = nextGraphemeEnd(buffer, cursorPos);
    if (char && !/\s/.test(char) && charEnd === lineEndFrom(cursorPos)) {
      return charEnd;
    }
    return cursorPos;
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
      if (!state.voicePrompt && state.voicePromptJobs.length === 0 && !state.voiceMessage) {
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
        updateSubmittedPlaceholderText();
      }
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

  function sortVoiceJobs(jobs: VoicePromptState[]): VoicePromptState[] {
    return jobs
      .map((job, index) => ({ job, index }))
      .sort((a, b) => a.job.insertionPos - b.job.insertionPos || (a.job.id ?? a.index) - (b.job.id ?? b.index))
      .map(({ job }) => job);
  }

  function includeJobSuffix(jobs: VoicePromptState[], index: number): boolean {
    return jobs[index + 1]?.insertionPos !== jobs[index]?.insertionPos;
  }

  function submittedJobText(job: VoicePromptState, includeSuffix = true): string {
    const suffixText = includeSuffix ? job.suffixText ?? "" : "";
    if (job.completedText !== undefined) {
      const normalized = job.completedText.trim();
      return normalized ? `${job.prefixText ?? ""}${normalized}${suffixText}` : "";
    }
    return `${job.prefixText ?? ""}${voicePlaceholderText(job)}${suffixText}`;
  }

  function renderSubmittedVoiceText(submitted: SubmittedVoiceSession): string {
    const jobs = sortVoiceJobs(submitted.jobs);
    let rendered = "";
    let cursor = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      const insertionPos = Math.max(0, Math.min(submitted.buffer.length, job.insertionPos));
      rendered += submitted.buffer.slice(cursor, insertionPos) + submittedJobText(job, includeJobSuffix(jobs, i));
      cursor = insertionPos;
    }
    return (rendered + submitted.buffer.slice(cursor)).trim();
  }

  function updateSubmittedMessageText(): void {
    if (!session.submitted) return;
    session.submitted.submission.message.text = renderSubmittedVoiceText(session.submitted);
  }

  function maybeCompleteSubmittedTranscription(): void {
    const submitted = session.submitted;
    if (!submitted || submitted.jobs.some(job => job.completedText === undefined)) return;
    const finalText = renderSubmittedVoiceText(submitted);
    deps.completePendingTranscription?.(submitted.submission, finalText);
    resetVoiceOverlay();
    scheduleRender();
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

  function removePromptJob(jobId: number): VoicePromptState | null {
    const job = state.voicePromptJobs.find(item => item.id === jobId) ?? null;
    if (!job) return null;
    state.voicePromptJobs = state.voicePromptJobs.filter(item => item.id !== jobId);
    return job;
  }

  function sortedPromptJobs(): VoicePromptState[] {
    return state.voicePromptJobs
      .map((job, index) => ({ job, index }))
      .sort((a, b) => a.job.insertionPos - b.job.insertionPos || (a.job.id ?? a.index) - (b.job.id ?? b.index))
      .map(({ job }) => job);
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
        const nextSameInsertionJob = sortedPromptJobs().find(other => other.insertionPos === job.insertionPos);
        if (nextSameInsertionJob) {
          nextSameInsertionJob.prefixText = deriveVoicePrefixText(nextSameInsertionJob.insertionPos, nextSameInsertionJob.id);
        }
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

  function updateSubmittedPlaceholderText(): void {
    if (!session.submitted) return;
    for (const job of session.submitted.jobs) {
      if (job.completedText === undefined) {
        job.frameIndex = (job.frameIndex + 1) % VOICE_SPINNER_FRAMES.length;
      }
    }
    updateSubmittedMessageText();
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
    session.prefixText = deriveVoicePrefixText(insertionPos, jobId);
    session.suffixText = deriveVoiceSuffixText(insertionPos);
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

  function submitActiveTranscription(): boolean {
    if (session.submitted || !deps.submitPendingTranscription) return false;
    if (!state.voicePrompt && state.voicePromptJobs.length === 0) return false;

    const buffer = state.inputBuffer;
    const cursorPos = state.cursorPos;
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
    const pendingText = getRenderedVoicePrompt(buffer, cursorPos, jobs).buffer.trim();
    const submission = deps.submitPendingTranscription(pendingText);
    if (!submission) return false;

    session.submitted = { submission, buffer, cursorPos, jobs };
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
          if (session.submitted) {
            applySubmittedJobTranscript(recordingJobId, text);
          } else if (promptJobId !== null) {
            applyPromptTranscript(promptJobId, text);
          }
        },
        (message) => {
          if (session.submitted) {
            failSubmittedJob(recordingJobId, message);
          } else if (promptJobId !== null) {
            failPromptJob(promptJobId, message);
          }
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
      if (oldEditStart >= voice.insertionPos) continue;
      if (oldEditEnd <= voice.insertionPos) {
        voice.insertionPos += newEditLength - oldEditLength;
      } else {
        voice.insertionPos = oldEditStart + newEditLength;
      }
      voice.insertionPos = Math.max(0, Math.min(nextBuffer.length, voice.insertionPos));
      voice.prefixText = deriveVoicePrefixText(voice.insertionPos, voice.id);
      voice.suffixText = deriveVoiceSuffixText(voice.insertionPos);
      if (state.voicePrompt === voice) {
        session.insertionPos = voice.insertionPos;
        session.prefixText = voice.prefixText;
        session.suffixText = voice.suffixText;
      }
    }
  }

  function handleKey(key: KeyEvent): boolean {
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
        submitActiveTranscription();
        void stopVoiceRecordingAndTranscribe();
        return true;
      }
      void stopVoiceRecordingAndTranscribe();
      return true;
    }

    if (key.type === "enter" && state.voicePromptJobs.length > 0) {
      return submitActiveTranscription();
    }

    if (!isVoicePromptFocused()) return false;
    if (key.type !== "char" || key.char !== " ") return false;
    if (key.event === "release") return true;

    void startVoiceRecording(resolveVoiceInsertionPos(state.cursorPos));
    return true;
  }

  function isBlockingMouse(): boolean {
    return !!session.recorder;
  }

  return {
    handleKey,
    syncPromptEdit,
    isBlockingMouse,
    cleanup,
  };
}
