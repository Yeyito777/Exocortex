import type { UserMessage } from "./messages";
import type { QueuedMessage, RenderState } from "./state";
import type { SubmittedVoiceTranscription } from "./voiceinput";

const TRANSCRIBING_TEXT = "Transcribing…";
const TRANSCRIBING_SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Transcribing…/g;

export function isPendingVoicePreviewText(text: string | null | undefined): boolean {
  return !!text?.includes(TRANSCRIBING_TEXT);
}

export function normalizePendingVoicePreviewText(text: string): string {
  return text.replace(TRANSCRIBING_SPINNER_RE, "⠿ Transcribing…");
}

export function pendingVoicePreviewTextsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!isPendingVoicePreviewText(a) || !isPendingVoicePreviewText(b)) return false;
  return normalizePendingVoicePreviewText(a!) === normalizePendingVoicePreviewText(b!);
}

export function messageMatchesPendingVoiceSubmission(
  message: UserMessage,
  submission: SubmittedVoiceTranscription,
  aliases: Iterable<UserMessage | null | undefined> = [],
): boolean {
  if (message === submission.message) return true;
  for (const alias of aliases) {
    if (alias && message === alias) return true;
  }

  const messageStartedAt = message.metadata?.startedAt;
  if (messageStartedAt !== undefined && messageStartedAt === submission.startedAt) return true;

  return pendingVoicePreviewTextsMatch(message.text, submission.message.text);
}

export function queuedMessageMatchesPendingVoiceSubmission(
  queuedMessage: QueuedMessage,
  submission: SubmittedVoiceTranscription,
  aliases: Iterable<QueuedMessage | null | undefined> = [],
): boolean {
  if (submission.queuedMessage && queuedMessage === submission.queuedMessage) return true;
  for (const alias of aliases) {
    if (alias && queuedMessage === alias) return true;
  }

  if (!submission.queuedMessage) return false;
  if (queuedMessage.convId !== submission.queuedMessage.convId) return false;
  return pendingVoicePreviewTextsMatch(queuedMessage.text, submission.queuedMessage.text);
}

export function pendingVoiceSubmissionsMatch(
  candidate: SubmittedVoiceTranscription,
  target: SubmittedVoiceTranscription,
): boolean {
  return candidate === target
    || candidate.message === target.message
    || candidate.startedAt === target.startedAt
    || pendingVoicePreviewTextsMatch(candidate.message.text, target.message.text);
}

export function editItemLooksLikePendingVoiceSubmission(
  item: {
    text: string;
    message?: UserMessage;
    sourceMessage?: UserMessage;
    queuedMessage?: QueuedMessage;
  },
  submission: SubmittedVoiceTranscription,
): boolean {
  if (item.message && messageMatchesPendingVoiceSubmission(item.message, submission, [item.sourceMessage])) return true;
  if (item.sourceMessage && messageMatchesPendingVoiceSubmission(item.sourceMessage, submission, [item.message])) return true;
  if (item.queuedMessage && queuedMessageMatchesPendingVoiceSubmission(item.queuedMessage, submission)) return true;
  return pendingVoicePreviewTextsMatch(item.text, submission.message.text)
    || (!!submission.queuedMessage && pendingVoicePreviewTextsMatch(item.text, submission.queuedMessage.text));
}

export function removePendingVoiceEchoes(
  state: RenderState,
  submission: SubmittedVoiceTranscription,
  aliases: {
    message?: UserMessage | null;
    sourceMessage?: UserMessage | null;
    queuedMessage?: QueuedMessage | null;
  } = {},
): void {
  const messageAliases = [aliases.message, aliases.sourceMessage];
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i];
    if (message?.role !== "user") continue;
    if (messageMatchesPendingVoiceSubmission(message, submission, messageAliases)) {
      state.messages.splice(i, 1);
    }
  }

  if (state.voiceMessage && messageMatchesPendingVoiceSubmission(state.voiceMessage.message, submission, messageAliases)) {
    state.voiceMessage = null;
  }

  const queuedAliases = [aliases.queuedMessage];
  for (let i = state.queuedMessages.length - 1; i >= 0; i--) {
    const queuedMessage = state.queuedMessages[i];
    if (queuedMessageMatchesPendingVoiceSubmission(queuedMessage, submission, queuedAliases)) {
      state.queuedMessages.splice(i, 1);
    }
  }
}
