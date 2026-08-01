import {
  REALTIME_TRANSCRIPT_KIND,
  type AIMessage,
  type Message,
  type UserMessage,
} from "../messages";
import type { Event } from "../protocol";
import type { RenderState } from "../state";
import { commitPendingAISegment } from "./pending-ai";

type TranscriptEvent = Extract<Event, { type: "call_transcript" }>;

function normalizedTranscript(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function isCanonicalDraft(message: Message, draft: UserMessage | AIMessage): boolean {
  if (message.role !== draft.role) return false;
  if (message.metadata?.kind !== REALTIME_TRANSCRIPT_KIND) return false;
  if (message.metadata?.startedAt !== draft.metadata?.startedAt) return false;
  // A backend handoff promotes the finalized user transcript in place into a
  // structured delegation request. Its stable timestamp is the identity; text
  // equality applies only to ordinary transcripts and assistant projections.
  if (message.role === "user") return true;
  if (draft.role !== "assistant") return false;
  const messageText = message.blocks
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("");
  const draftText = draft.blocks
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("");
  return normalizedTranscript(messageText) === normalizedTranscript(draftText);
}

export function clearCallTranscriptDrafts(state: RenderState): void {
  state.callUserDraft = null;
  state.callAssistantDraft = null;
}

/**
 * Remove a finalized live projection only after its exact durable replacement
 * is present. Keeping unmatched projections across history refreshes prevents a
 * GPT-Live response from blinking out while the preceding user transcript is
 * being persisted.
 */
export function reconcileCallTranscriptDrafts(state: RenderState): void {
  const userDraft = state.callUserDraft;
  if (userDraft?.final && state.messages.some(message => isCanonicalDraft(message, userDraft.message))) {
    state.callUserDraft = null;
  }
  const assistantDraft = state.callAssistantDraft;
  if (assistantDraft?.final && state.messages.some(message => isCanonicalDraft(message, assistantDraft.message))) {
    state.callAssistantDraft = null;
  }
}

function handleUserTranscript(event: TranscriptEvent, state: RenderState): void {
  // A final empty projection explicitly discards a provider-replayed barge-in
  // turn. It must clear the optimistic draft without creating a blank bubble.
  if (event.final && !event.text.trim()) {
    state.callUserDraft = null;
    return;
  }
  if (event.final && state.pendingAI) {
    // A spoken turn can arrive while the delegated parent agent is streaming.
    // Split its completed visual prefix before inserting the transcript, exactly
    // like an ordinary inline user_message. The following history refresh then
    // replaces that prefix canonically while pendingAI contains only new blocks;
    // retaining the unsplit pending message would render the whole agent turn a
    // second time below the interjected speech.
    const finalized = commitPendingAISegment(state);
    if (finalized) state.messages.push(finalized);
  }

  let draft = state.callUserDraft;
  if (draft && (draft.callId !== event.callId || (draft.final && !event.final))) draft = null;

  if (!draft) {
    const message: UserMessage = {
      role: "user",
      text: event.text,
      metadata: {
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        model: event.model,
        tokens: event.tokens,
        kind: REALTIME_TRANSCRIPT_KIND,
      },
    };
    state.callUserDraft = { callId: event.callId, message, final: event.final };
    return;
  }

  draft.message.text = event.text;
  draft.message.metadata = {
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    model: event.model,
    tokens: event.tokens,
    kind: REALTIME_TRANSCRIPT_KIND,
  };
  draft.final = event.final;
}

function handleAssistantTranscript(event: TranscriptEvent, state: RenderState): void {
  // Finalization may run again during hangup after the completed assistant turn
  // has already been persisted. The daemon emits an empty final projection to
  // retire any optimistic UI draft; treating it as a new message would render a
  // metadata-only phantom turn after "Realtime call ended."
  if (event.final && !event.text.trim()) {
    state.callAssistantDraft = null;
    return;
  }

  let draft = state.callAssistantDraft;
  if (draft && (draft.callId !== event.callId || (draft.final && !event.final))) draft = null;

  if (!draft) {
    const message: AIMessage = {
      role: "assistant",
      blocks: [{ type: "text", text: event.text }],
      metadata: {
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        model: event.model,
        tokens: event.tokens,
        kind: REALTIME_TRANSCRIPT_KIND,
      },
    };
    state.callAssistantDraft = { callId: event.callId, message, final: event.final };
    return;
  }

  const textBlock = draft.message.blocks.find(block => block.type === "text");
  if (textBlock?.type === "text") textBlock.text = event.text;
  else draft.message.blocks.push({ type: "text", text: event.text });
  draft.message.metadata = {
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    model: event.model,
    tokens: event.tokens,
    kind: REALTIME_TRANSCRIPT_KIND,
  };
  draft.final = event.final;
}

export function handleCallTranscript(event: TranscriptEvent, state: RenderState): void {
  const projectedCallId = state.callUserDraft?.callId ?? state.callAssistantDraft?.callId;
  if (projectedCallId && projectedCallId !== event.callId) clearCallTranscriptDrafts(state);
  if (event.role === "user") handleUserTranscript(event, state);
  else handleAssistantTranscript(event, state);
}
