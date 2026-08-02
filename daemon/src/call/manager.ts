import { randomUUID } from "node:crypto";
import type { RealtimeCallAdapter, RealtimeCallState } from "../protocol";
import type { ConnectedClient, DaemonServer } from "../server";
import type { ApiContentBlock, ApiMessage, Conversation } from "../messages";
import * as convStore from "../conversations";
import { buildConversationApiContext } from "../context-compaction";
import { getCurrentAccountScope, getVerifiedSession } from "../providers/openai/auth";
import { broadcastConversationHistoryUpdated, broadcastConversationUpdated } from "../conversation-events";
import { log } from "../log";
import { ChatGptRealtimeTransport, type NativeRealtimeTransport } from "./transport";
import { REALTIME_MODEL, type RealtimeInitialItem, type RealtimeSidebandEvent } from "./protocol";
import { effectiveRealtimeVoice, saveRealtimeVoice } from "@exocortex/shared/config";
import { isRealtimeVoice, type RealtimeVoice } from "@exocortex/shared/realtime";

const MAX_INITIAL_ITEMS = 64;
const MAX_INITIAL_ITEM_CHARS = 8_000;
const MAX_INITIAL_TOTAL_CHARS = 28_000;

const REALTIME_PROMPT = [
  "You are Exo, the realtime voice interface for this Exocortex conversation.",
  "Use the supplied conversation history and conversation instructions.",
  "Answer short self-contained questions directly, leading with the answer and skipping preambles.",
  "Handle conversational acknowledgements and social dialogue yourself.",
  "For actions, fresh research, detailed recall, or anything where completeness matters, create a client delegation to the owning Exocortex agent.",
  "When a request mixes conversation with backend work, delegate only the backend work and continue the conversational portion yourself.",
  "While backend work is pending, continue the conversation normally; do not claim to be checking, waiting, loading, or making progress unless the application provides an actual progress update.",
  "Never mention the delegation or claim success before it returns.",
].join(" ");

/** Frameless Bidi does not always report usage, so keep live metadata useful. */
export function estimateRealtimeTokens(text: string): number {
  const bytes = Buffer.byteLength(text.trim(), "utf8");
  return bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / 4));
}

function transcriptKey(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
}

interface TranscriptWord {
  key: string;
  start: number;
  end: number;
}

function transcriptWords(text: string): TranscriptWord[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(match => ({
    key: match[0]!.toLocaleLowerCase(),
    start: match.index!,
    end: match.index! + match[0]!.length,
  }));
}

function removeTranscriptWordSpan(text: string, words: TranscriptWord[], start: number, count: number): string {
  const first = words[start];
  const last = words[start + count - 1];
  if (!first || !last) return text;
  const before = text.slice(0, first.start).trimEnd();
  const after = text.slice(last.end).replace(/^[\s,.;:!?…—-]+/u, "").trimStart();
  return [before, after].filter(Boolean).join(" ");
}

/**
 * Frameless may split one physical utterance when it starts speaking during a
 * pause, then include the already-finalized words again in the barge-in turn.
 * Strip only a substantial replay at the edge of that immediately-following
 * interrupted turn; ordinary repeated phrases in later turns remain intact.
 */
export function stripRepeatedInterruptedTranscript(previous: string, current: string): string {
  const previousWords = transcriptWords(previous);
  const currentWords = transcriptWords(current);
  const minimumReplayWords = 4;
  if (previousWords.length < minimumReplayWords || currentWords.length < minimumReplayWords) return current;

  const sameWords = (currentStart: number, previousStart: number, count: number): boolean => {
    for (let offset = 0; offset < count; offset++) {
      if (currentWords[currentStart + offset]?.key !== previousWords[previousStart + offset]?.key) return false;
    }
    return true;
  };

  // A complete provider replay can prefix a correction or follow a short
  // barge-in preamble. Do not remove matching text from the middle of a turn.
  if (currentWords.length >= previousWords.length) {
    if (sameWords(0, 0, previousWords.length)) {
      return removeTranscriptWordSpan(current, currentWords, 0, previousWords.length);
    }
    const suffixStart = currentWords.length - previousWords.length;
    if (sameWords(suffixStart, 0, previousWords.length)) {
      return removeTranscriptWordSpan(current, currentWords, suffixStart, previousWords.length);
    }
  }

  // While the replay is still streaming, hide a substantial prefix of the old
  // utterance when it appears at the end of a new preamble.
  const maxPartial = Math.min(previousWords.length - 1, currentWords.length - 1);
  for (let count = maxPartial; count >= minimumReplayWords; count--) {
    const suffixStart = currentWords.length - count;
    if (sameWords(suffixStart, 0, count)) {
      return removeTranscriptWordSpan(current, currentWords, suffixStart, count);
    }
  }
  return current;
}

/**
 * Frameless Bidi normally supplies a complete turn.done transcript, but an
 * interrupted turn can contain only the suffix that follows already-emitted
 * transcript deltas. Preserve either representation without duplicating a
 * complete snapshot that overlaps the live accumulator.
 */
export function mergeCompletedTranscript(accumulated: string, done: string): string {
  if (!accumulated) return done;
  if (!done) return accumulated;
  if (done.startsWith(accumulated)) return done;
  if (accumulated.startsWith(done)) return accumulated;
  if (transcriptKey(accumulated) === transcriptKey(done)) {
    return accumulated.length >= done.length ? accumulated : done;
  }

  const maxOverlap = Math.min(accumulated.length, done.length);
  for (let length = maxOverlap; length > 0; length--) {
    if (accumulated.endsWith(done.slice(0, length))) {
      return accumulated + done.slice(length);
    }
  }
  return accumulated + done;
}

function contentText(content: string | ApiContentBlock[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((block): block is Extract<ApiContentBlock, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

function boundedText(text: string, maxChars = MAX_INITIAL_ITEM_CHARS): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n[earlier content truncated]";
  if (maxChars <= suffix.length) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

/** Build the complete, bounded text context supplied when Frameless Bidi starts. */
export function buildRealtimeInitialItems(
  conv: Conversation,
  effectiveInstructions: string | null,
  accountScope?: string,
): RealtimeInitialItem[] {
  const instructionText = effectiveInstructions?.trim();
  const developer = instructionText
    ? { role: "developer" as const, text: boundedText(instructionText) }
    : null;
  const replay = buildConversationApiContext(conv, accountScope).messages;
  const candidates: RealtimeInitialItem[] = replay.flatMap((message: ApiMessage) => {
    const text = contentText(message.content);
    return text ? [{ role: message.role, text: boundedText(text) }] : [];
  });

  let remainingChars = MAX_INITIAL_TOTAL_CHARS - (developer?.text.length ?? 0);
  const maxReplayItems = MAX_INITIAL_ITEMS - (developer ? 1 : 0);
  const selected: RealtimeInitialItem[] = [];
  for (let index = candidates.length - 1; index >= 0 && selected.length < maxReplayItems; index--) {
    if (remainingChars <= 0) break;
    const candidate = candidates[index]!;
    const text = boundedText(candidate.text, Math.min(MAX_INITIAL_ITEM_CHARS, remainingChars));
    if (!text) continue;
    selected.push({ ...candidate, text });
    remainingChars -= text.length;
  }
  selected.reverse();
  return developer ? [developer, ...selected] : selected;
}

export interface RealtimeCallManagerDependencies {
  createTransport?: (onEvent: (event: RealtimeSidebandEvent) => void | Promise<void>) => NativeRealtimeTransport;
  ensureAuthenticated?: () => Promise<void>;
  getConversation?: typeof convStore.get;
  getEffectiveInstructions?: typeof convStore.getEffectiveSystemInstructions;
  getAccountScope?: () => string | null;
  persistTranscript?: typeof convStore.appendRealtimeTranscript;
  persistStatus?: typeof convStore.appendRealtimeCallStatus;
  getVoice?: () => RealtimeVoice;
  saveVoice?: (voice: RealtimeVoice) => void;
  delegate?: (convId: string, delegation: {
    callId: string;
    adapter: RealtimeCallAdapter;
    originalUserUtterance: string;
    backendTask: string;
  }, signal: AbortSignal) => Promise<
    | { status: "completed"; text: string }
    | { status: "cancelled" }
  >;
}

interface TranscriptAccumulator {
  text: string;
  finalKey: string | null;
  startedAt: number | null;
}

interface ActiveCall {
  convId: string;
  callId: string;
  adapter: RealtimeCallAdapter;
  state: RealtimeCallState;
  transport: NativeRealtimeTransport;
  initialItems: RealtimeInitialItem[];
  voice: RealtimeVoice;
  handoffInFlight: boolean;
  handoffAbortController: AbortController | null;
  transcript: Record<"user" | "assistant", TranscriptAccumulator>;
  userTranscriptFinal: boolean;
  /** A delegation can be followed by a duplicate user turn.done for the same speech. */
  pendingHandoffUserKey: string | null;
  lastFinalUserTranscript: string | null;
  /** Prior user speech that Frameless may replay after interrupting its response. */
  interruptedUserReplay: string | null;
  assistantResponseStartedAt: number | null;
}

function persistedCallSource(call: ActiveCall) {
  return {
    callId: call.callId,
    adapterType: call.adapter.type,
    adapterId: call.adapter.id,
    ...(call.adapter.label ? { sourceLabel: call.adapter.label } : {}),
    ...(call.adapter.accountAlias ? { accountAlias: call.adapter.accountAlias } : {}),
    ...(call.adapter.channelId ? { channelId: call.adapter.channelId } : {}),
  };
}

const DEFAULT_TUI_ADAPTER: RealtimeCallAdapter = { type: "tui", id: "local" };

function callAdapterKey(adapter: RealtimeCallAdapter): string {
  if (adapter.type !== "tui" && adapter.type !== "discord") {
    throw new Error(`Unsupported realtime call adapter type: ${String(adapter.type)}.`);
  }
  const id = adapter.id.trim();
  if (!id) throw new Error("Realtime call adapter ID is required.");
  if (adapter.type === "discord") {
    if (!adapter.accountAlias?.trim()) throw new Error("Discord call adapters require an account alias.");
    if (!adapter.channelId?.trim()) throw new Error("Discord call adapters require a channel ID.");
  }
  return `${adapter.type}:${id}`;
}

/** Owns independent restart-unsafe Bidi sessions for platform media adapters. */
export class RealtimeCallManager {
  private readonly calls = new Map<string, ActiveCall>();
  private readonly callByAdapter = new Map<string, string>();
  private readonly startingByAdapter = new Map<string, Promise<ActiveCall>>();
  private readonly delegationTailByConversation = new Map<string, Promise<void>>();
  private readonly getConversation: typeof convStore.get;
  private readonly getEffectiveInstructions: typeof convStore.getEffectiveSystemInstructions;
  private readonly getAccountScope: () => string | null;
  private readonly persistTranscript: typeof convStore.appendRealtimeTranscript;
  private readonly persistStatus: typeof convStore.appendRealtimeCallStatus;
  private readonly getVoice: () => RealtimeVoice;
  private readonly saveVoice: (voice: RealtimeVoice) => void;
  private readonly delegate?: RealtimeCallManagerDependencies["delegate"];
  private readonly ensureAuthenticated: NonNullable<RealtimeCallManagerDependencies["ensureAuthenticated"]>;
  private readonly createTransport: NonNullable<RealtimeCallManagerDependencies["createTransport"]>;

  constructor(
    private readonly server: DaemonServer,
    dependencies: RealtimeCallManagerDependencies = {},
  ) {
    this.getConversation = dependencies.getConversation ?? convStore.get;
    this.getEffectiveInstructions = dependencies.getEffectiveInstructions ?? convStore.getEffectiveSystemInstructions;
    this.getAccountScope = dependencies.getAccountScope ?? getCurrentAccountScope;
    this.persistTranscript = dependencies.persistTranscript ?? convStore.appendRealtimeTranscript;
    this.persistStatus = dependencies.persistStatus ?? convStore.appendRealtimeCallStatus;
    this.getVoice = dependencies.getVoice ?? effectiveRealtimeVoice;
    this.saveVoice = dependencies.saveVoice ?? saveRealtimeVoice;
    this.delegate = dependencies.delegate;
    this.ensureAuthenticated = dependencies.ensureAuthenticated ?? (async () => { await getVerifiedSession(); });
    this.createTransport = dependencies.createTransport
      ?? (onEvent => new ChatGptRealtimeTransport({ onEvent }));
  }

  hasActiveCall(): boolean {
    return this.calls.size > 0 || this.startingByAdapter.size > 0;
  }

  async start(
    convId: string,
    requestedVoice?: RealtimeVoice,
    requestedAdapter: RealtimeCallAdapter = DEFAULT_TUI_ADAPTER,
  ): Promise<{ callId: string; state: RealtimeCallState }> {
    if (requestedVoice !== undefined && !isRealtimeVoice(requestedVoice)) {
      throw new Error(`Unsupported realtime voice: ${String(requestedVoice)}.`);
    }
    const adapter = { ...requestedAdapter, id: requestedAdapter.id.trim() };
    const adapterKey = callAdapterKey(adapter);
    const existingCallId = this.callByAdapter.get(adapterKey);
    const existing = existingCallId ? this.calls.get(existingCallId) : undefined;
    if (existing?.convId === convId) {
      if (requestedVoice && requestedVoice !== existing.voice) {
        throw new Error(`This call is already using ${existing.voice}; hang up before changing voices.`);
      }
      this.emitState(existing);
      return { callId: existing.callId, state: existing.state };
    }
    if (existing) throw new Error(`The ${adapter.type} media adapter is already attached to another realtime call.`);
    const existingStart = this.startingByAdapter.get(adapterKey);
    if (existingStart) {
      const starting = await existingStart;
      if (starting.convId !== convId) throw new Error(`The ${adapter.type} media adapter is already starting another realtime call.`);
      return { callId: starting.callId, state: starting.state };
    }

    const conv = this.getConversation(convId);
    if (!conv) throw new Error("Conversation not found.");
    if (conv.provider !== "openai") throw new Error("Realtime calls require an OpenAI conversation with ChatGPT authentication.");

    const callId = randomUUID();
    const voice = requestedVoice ?? this.getVoice();
    const transport = this.createTransport(event => this.handleEvent(callId, event));
    const start = (async () => {
      const provisional: ActiveCall = {
        convId,
        callId,
        adapter,
        state: "starting",
        transport,
        initialItems: [],
        voice,
        handoffInFlight: false,
        handoffAbortController: null,
        transcript: {
          user: { text: "", finalKey: null, startedAt: null },
          assistant: { text: "", finalKey: null, startedAt: null },
        },
        userTranscriptFinal: false,
        pendingHandoffUserKey: null,
        lastFinalUserTranscript: null,
        interruptedUserReplay: null,
        assistantResponseStartedAt: null,
      };
      this.calls.set(callId, provisional);
      this.callByAdapter.set(adapterKey, callId);
      this.emitState(provisional, "Preparing ChatGPT Bidi…");
      try {
        await this.ensureAuthenticated();
        if (this.calls.get(callId) !== provisional || provisional.state === "stopping" || provisional.state === "closed") {
          throw new Error("Realtime call was stopped while starting.");
        }
        const freshConv = this.getConversation(convId);
        if (!freshConv) throw new Error("Conversation was deleted while the call was starting.");
        provisional.initialItems = buildRealtimeInitialItems(
          freshConv,
          this.getEffectiveInstructions(convId),
          this.getAccountScope() ?? undefined,
        );
        if (requestedVoice) this.saveVoice(requestedVoice);
        provisional.state = "waiting_for_media";
        this.emitState(provisional, "Bidi is ready; waiting for the client microphone/speaker connection.");
        return provisional;
      } catch (error) {
        const interrupted = this.calls.get(callId) !== provisional
          || provisional.state === "stopping"
          || provisional.state === "closed";
        if (!interrupted) {
          provisional.state = "error";
          this.emitState(provisional, error instanceof Error ? error.message : String(error));
          this.removeCall(provisional);
          await transport.stop();
        }
        throw error;
      }
    })();
    this.startingByAdapter.set(adapterKey, start);
    try {
      const active = await start;
      return { callId: active.callId, state: active.state };
    } finally {
      if (this.startingByAdapter.get(adapterKey) === start) this.startingByAdapter.delete(adapterKey);
    }
  }

  async attachMedia(
    client: ConnectedClient,
    convId: string,
    callId: string,
    offerSdp: string,
    reqId?: string,
  ): Promise<void> {
    const call = this.requireCall(convId, callId);
    if (!offerSdp.trim()) throw new Error("A WebRTC offer SDP is required.");
    if (call.state !== "waiting_for_media") {
      throw new Error(call.state === "connecting" || call.state === "live"
        ? "The realtime call already has a media adapter."
        : `The realtime call cannot attach media while ${call.state}.`);
    }
    call.state = "connecting";
    this.emitState(call, "Connecting media to ChatGPT Bidi…");
    try {
      const result = await call.transport.start({
        offerSdp,
        initialItems: call.initialItems,
        prompt: REALTIME_PROMPT,
        sessionId: call.callId,
        threadId: call.convId,
        voice: call.voice,
      });
      this.server.sendTo(client, {
        type: "call_sdp_answer",
        reqId,
        convId: call.convId,
        callId: call.callId,
        adapter: call.adapter,
        sdp: result.answerSdp,
      });
      call.state = "live";
      this.persistCallStatus(call, "Realtime call started.");
      this.emitState(call);
    } catch (error) {
      call.state = "error";
      this.emitState(call, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop(convId: string, callId?: string): Promise<void> {
    await this.stopCall(convId, callId, true);
  }

  /**
   * End a call from the delegated agent that is currently fulfilling the
   * user's hangup request. Unlike an external /hangup, this must not abort the
   * very turn executing the hangup tool.
   */
  async stopFromAgent(convId: string, callId?: string): Promise<void> {
    await this.stopCall(convId, callId, false);
  }

  private async stopCall(convId: string, callId: string | undefined, abortHandoff: boolean): Promise<void> {
    const call = this.resolveCall(convId, callId);
    if (call.state === "stopping" || call.state === "closed") return;
    call.state = "stopping";
    this.emitState(call, "Stopping realtime call…");
    if (abortHandoff) call.handoffAbortController?.abort("realtime call ended");
    try {
      await call.transport.stop();
    } finally {
      this.flushTranscriptBuffers(call);
      call.state = "closed";
      this.persistCallStatus(call, "Realtime call ended.");
      this.emitState(call);
      this.removeCall(call);
    }
  }

  async stopAll(): Promise<void> {
    const calls = [...this.calls.values()];
    await Promise.all(calls.map(call => this.stop(call.convId, call.callId).catch(error => {
      log("warn", `realtime call: shutdown cleanup failed for ${call.callId}: ${error instanceof Error ? error.message : String(error)}`);
    })));
  }

  private requireCall(convId: string, callId: string): ActiveCall {
    const call = this.calls.get(callId);
    if (!call || call.convId !== convId) {
      throw new Error("No matching realtime call is active.");
    }
    return call;
  }

  private resolveCall(convId: string, callId?: string): ActiveCall {
    if (callId) return this.requireCall(convId, callId);
    const matches = [...this.calls.values()].filter(call => call.convId === convId);
    if (matches.length === 0) throw new Error("No matching realtime call is active.");
    if (matches.length > 1) throw new Error("Multiple realtime calls are active for this conversation; specify a call ID.");
    return matches[0]!;
  }

  private removeCall(call: ActiveCall): void {
    if (this.calls.get(call.callId) === call) this.calls.delete(call.callId);
    const key = callAdapterKey(call.adapter);
    if (this.callByAdapter.get(key) === call.callId) this.callByAdapter.delete(key);
  }

  private emitState(call: ActiveCall, message?: string): void {
    this.server.sendToSubscribers(call.convId, {
      type: "call_state",
      convId: call.convId,
      callId: call.callId,
      adapter: call.adapter,
      state: call.state,
      ...(message ? { message } : {}),
    });
  }

  private async handleEvent(callId: string, event: RealtimeSidebandEvent): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;
    switch (event.type) {
      case "started":
        break;
      case "transcript_delta": {
        const accumulator = call.transcript[event.role];
        if (event.role === "user" && call.pendingHandoffUserKey) {
          const candidateText = accumulator.text + event.text;
          const candidateKey = transcriptKey(candidateText);
          // Frameless Bidi may publish the handoff's input transcript again as
          // input_transcript.added/turn.done after delegation.created. Suppress
          // that duplicate representation instead of treating it as the next
          // user boundary and prematurely committing the spoken preamble.
          if (candidateKey && call.pendingHandoffUserKey.startsWith(candidateKey)) {
            accumulator.text = candidateText;
            accumulator.startedAt ??= Date.now();
            break;
          }
          call.pendingHandoffUserKey = null;
        }
        if (!accumulator.text) {
          accumulator.finalKey = null;
          accumulator.startedAt = event.role === "assistant"
            ? call.assistantResponseStartedAt ?? Date.now()
            : Date.now();
        }
        accumulator.text += event.text;
        if (event.role === "user") {
          this.finalizeInterruptedAssistant(call);
          call.userTranscriptFinal = false;
        }
        const projectedText = event.role === "user" && call.interruptedUserReplay
          ? stripRepeatedInterruptedTranscript(call.interruptedUserReplay, accumulator.text)
          : accumulator.text;
        this.server.sendToSubscribers(call.convId, {
          type: "call_transcript",
          convId: call.convId,
          callId: call.callId,
          adapter: call.adapter,
          role: event.role,
          text: projectedText,
          final: false,
          startedAt: accumulator.startedAt ?? Date.now(),
          endedAt: null,
          model: REALTIME_MODEL,
          tokens: estimateRealtimeTokens(projectedText),
        });
        break;
      }
      case "transcript_done": {
        if (event.role === "user" && call.pendingHandoffUserKey) {
          const duplicateHandoffInput = transcriptKey(event.text) === call.pendingHandoffUserKey;
          call.pendingHandoffUserKey = null;
          if (duplicateHandoffInput) {
            call.transcript.user.text = "";
            call.transcript.user.startedAt = null;
            call.userTranscriptFinal = true;
            break;
          }
        }
        if (event.role === "user") this.finalizeInterruptedAssistant(call);
        this.finalizeTranscript(
          call,
          event.role,
          mergeCompletedTranscript(call.transcript[event.role].text, event.text),
          event.tokens,
        );
        call.userTranscriptFinal = event.role === "user";
        break;
      }
      case "handoff": {
        const backendTask = event.text.trim();
        if (!backendTask) break;
        this.finalizeInterruptedAssistant(call);
        // Prefer the independently transcribed speech as the visible/canonical
        // utterance. Frameless is allowed to put a distilled backend task in the
        // delegation item; only fall back to that text when no transcript event
        // was available at all.
        if (call.transcript.user.text.trim()) {
          this.finalizeTranscript(call, "user", call.transcript.user.text);
        } else if (!call.userTranscriptFinal || !call.lastFinalUserTranscript) {
          this.finalizeTranscript(call, "user", backendTask);
        }
        call.userTranscriptFinal = true;
        const originalUserUtterance = call.lastFinalUserTranscript ?? backendTask;
        call.pendingHandoffUserKey = transcriptKey(originalUserUtterance);
        void this.handleHandoff(call, event.handoffId, {
          callId: call.callId,
          adapter: call.adapter,
          originalUserUtterance,
          backendTask,
        });
        break;
      }
      case "error":
        call.state = "error";
        this.emitState(call, event.message);
        break;
      case "closed":
        if (call.state === "stopping" || call.state === "closed") return;
        call.state = "closed";
        await call.transport.stop();
        this.flushTranscriptBuffers(call);
        this.persistCallStatus(call, event.reason
          ? `Realtime call ended: ${event.reason}`
          : "Realtime call ended.");
        this.emitState(call);
        this.removeCall(call);
        break;
    }
  }

  private finalizeTranscript(
    call: ActiveCall,
    role: "user" | "assistant",
    text: string,
    providerTokens?: number,
  ): void {
    const accumulator = call.transcript[role];
    let normalized = text.trim();
    if (role === "user" && call.interruptedUserReplay) {
      normalized = stripRepeatedInterruptedTranscript(call.interruptedUserReplay, normalized).trim();
      call.interruptedUserReplay = null;
    }
    const key = transcriptKey(normalized);
    const endedAt = Date.now();
    const startedAt = accumulator.startedAt
      ?? (role === "assistant" ? call.assistantResponseStartedAt : null)
      ?? endedAt;
    const tokens = providerTokens ?? estimateRealtimeTokens(normalized);
    accumulator.text = "";
    accumulator.startedAt = null;
    if (!normalized) {
      this.server.sendToSubscribers(call.convId, {
        type: "call_transcript",
        convId: call.convId,
        callId: call.callId,
        adapter: call.adapter,
        role,
        text: "",
        final: true,
        startedAt,
        endedAt,
        model: REALTIME_MODEL,
        tokens: 0,
      });
      return;
    }
    if (accumulator.finalKey === key) return;
    accumulator.finalKey = key;
    this.server.sendToSubscribers(call.convId, {
      type: "call_transcript",
      convId: call.convId,
      callId: call.callId,
      adapter: call.adapter,
      role,
      text: normalized,
      final: true,
      startedAt,
      endedAt,
      model: REALTIME_MODEL,
      tokens,
    });
    if (this.persistTranscript(call.convId, role, normalized, startedAt, {
      endedAt,
      ...persistedCallSource(call),
      ...(role === "assistant" ? { model: REALTIME_MODEL, tokens } : {}),
    })) {
      broadcastConversationHistoryUpdated(this.server, call.convId);
      broadcastConversationUpdated(this.server, call.convId);
    }
    if (role === "user") {
      call.lastFinalUserTranscript = normalized;
      call.assistantResponseStartedAt = endedAt;
    }
  }

  private finalizeInterruptedAssistant(call: ActiveCall): void {
    if (!call.userTranscriptFinal || !call.transcript.assistant.text.trim()) return;
    call.interruptedUserReplay = call.lastFinalUserTranscript;
    this.finalizeTranscript(call, "assistant", call.transcript.assistant.text);
  }

  private persistCallStatus(call: ActiveCall, text: string): void {
    if (!this.persistStatus(call.convId, text, Date.now(), persistedCallSource(call))) return;
    broadcastConversationHistoryUpdated(this.server, call.convId);
    broadcastConversationUpdated(this.server, call.convId);
  }

  private flushTranscriptBuffers(call: ActiveCall): void {
    this.finalizeTranscript(call, "user", call.transcript.user.text);
    this.finalizeTranscript(call, "assistant", call.transcript.assistant.text);
    call.userTranscriptFinal = false;
    call.pendingHandoffUserKey = null;
    call.interruptedUserReplay = null;
  }

  private async handleHandoff(
    call: ActiveCall,
    handoffId: string,
    delegation: {
      callId: string;
      adapter: RealtimeCallAdapter;
      originalUserUtterance: string;
      backendTask: string;
    },
  ): Promise<void> {
    if (!this.delegate || call.handoffInFlight || this.calls.get(call.callId) !== call) return;
    const abortController = new AbortController();
    call.handoffInFlight = true;
    call.handoffAbortController = abortController;
    call.state = "delegating";
    // Delegation is an implementation detail of an otherwise continuous voice
    // reply. Publish the state transition for adapters, but do not inject a
    // visible lifecycle notice into conversation history.
    this.emitState(call);
    const previous = this.delegationTailByConversation.get(call.convId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (abortController.signal.aborted || this.calls.get(call.callId) !== call) return;
      try {
        const result = await this.delegate!(call.convId, delegation, abortController.signal);
        if (this.calls.get(call.callId) === call && call.state === "delegating") {
          if (result.status === "completed") {
            const text = result.text.trim();
            if (text) await call.transport.appendHandoff(handoffId, text);
          } else {
            await call.transport.appendHandoff(handoffId, "The delegated request was canceled.");
          }
        }
      } catch (error) {
        log("warn", `realtime call: handoff failed for ${call.convId}: ${error instanceof Error ? error.message : String(error)}`);
        if (this.calls.get(call.callId) === call) {
          await call.transport.appendHandoff(handoffId, "I couldn't complete that delegated request.").catch(() => {});
        }
      }
    });
    this.delegationTailByConversation.set(call.convId, task);
    try {
      await task;
    } finally {
      if (this.delegationTailByConversation.get(call.convId) === task) {
        this.delegationTailByConversation.delete(call.convId);
      }
      call.handoffInFlight = false;
      if (call.handoffAbortController === abortController) call.handoffAbortController = null;
      if (this.calls.get(call.callId) === call && call.state === "delegating") {
        call.state = "live";
        this.emitState(call);
      }
    }
  }
}
