import { randomUUID } from "node:crypto";
import type { RealtimeCallState } from "../protocol";
import type { ConnectedClient, DaemonServer } from "../server";
import type { ApiContentBlock, ApiMessage, Conversation } from "../messages";
import * as convStore from "../conversations";
import { buildConversationApiContext } from "../context-compaction";
import { getCurrentAccountScope, getVerifiedSession } from "../providers/openai/auth";
import { broadcastConversationHistoryUpdated, broadcastConversationUpdated } from "../conversation-events";
import { log } from "../log";
import { ChatGptRealtimeTransport, type NativeRealtimeTransport } from "./transport";
import { REALTIME_MODEL, type RealtimeInitialItem, type RealtimeSidebandEvent } from "./protocol";

const MAX_INITIAL_ITEMS = 64;
const MAX_INITIAL_ITEM_CHARS = 8_000;
const MAX_INITIAL_TOTAL_CHARS = 28_000;

const REALTIME_PROMPT = [
  "You are Exo, the realtime voice interface for this Exocortex conversation.",
  "Use the supplied conversation history and conversation instructions.",
  "Answer short self-contained questions directly, leading with the answer and skipping preambles.",
  "For actions, fresh research, detailed recall, multipart requests, or anything where completeness matters, create a client delegation to the owning Exocortex agent. Never mention the delegation or claim success before it returns.",
].join(" ");

/** Frameless Bidi does not always report usage, so keep live metadata useful. */
export function estimateRealtimeTokens(text: string): number {
  const bytes = Buffer.byteLength(text.trim(), "utf8");
  return bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / 4));
}

function transcriptKey(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
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
  delegate?: (convId: string, text: string) => Promise<string>;
}

interface TranscriptAccumulator {
  text: string;
  finalKey: string | null;
  startedAt: number | null;
}

interface ActiveCall {
  convId: string;
  callId: string;
  state: RealtimeCallState;
  transport: NativeRealtimeTransport;
  initialItems: RealtimeInitialItem[];
  handoffInFlight: boolean;
  transcript: Record<"user" | "assistant", TranscriptAccumulator>;
  userTranscriptFinal: boolean;
  /** A delegation can be followed by a duplicate user turn.done for the same speech. */
  pendingHandoffUserKey: string | null;
  assistantResponseStartedAt: number | null;
}

/** Owns the one restart-unsafe Bidi call allowed by this daemon process. */
export class RealtimeCallManager {
  private active: ActiveCall | null = null;
  private starting: Promise<ActiveCall> | null = null;
  private readonly getConversation: typeof convStore.get;
  private readonly getEffectiveInstructions: typeof convStore.getEffectiveSystemInstructions;
  private readonly getAccountScope: () => string | null;
  private readonly persistTranscript: typeof convStore.appendRealtimeTranscript;
  private readonly persistStatus: typeof convStore.appendRealtimeCallStatus;
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
    this.delegate = dependencies.delegate;
    this.ensureAuthenticated = dependencies.ensureAuthenticated ?? (async () => { await getVerifiedSession(); });
    this.createTransport = dependencies.createTransport
      ?? (onEvent => new ChatGptRealtimeTransport({ onEvent }));
  }

  hasActiveCall(): boolean {
    return this.active !== null || this.starting !== null;
  }

  async start(convId: string): Promise<{ callId: string; state: RealtimeCallState }> {
    const existing = this.active;
    if (existing?.convId === convId) {
      this.emitState(existing);
      return { callId: existing.callId, state: existing.state };
    }
    if (existing || this.starting) throw new Error("Another realtime call is already active.");

    const conv = this.getConversation(convId);
    if (!conv) throw new Error("Conversation not found.");
    if (conv.provider !== "openai") throw new Error("Realtime calls require an OpenAI conversation with ChatGPT authentication.");

    const callId = randomUUID();
    const transport = this.createTransport(event => this.handleEvent(event));
    const start = (async () => {
      const provisional: ActiveCall = {
        convId,
        callId,
        state: "starting",
        transport,
        initialItems: [],
        handoffInFlight: false,
        transcript: {
          user: { text: "", finalKey: null, startedAt: null },
          assistant: { text: "", finalKey: null, startedAt: null },
        },
        userTranscriptFinal: false,
        pendingHandoffUserKey: null,
        assistantResponseStartedAt: null,
      };
      this.active = provisional;
      this.emitState(provisional, "Preparing ChatGPT Bidi…");
      try {
        await this.ensureAuthenticated();
        if (this.active !== provisional || provisional.state === "stopping" || provisional.state === "closed") {
          throw new Error("Realtime call was stopped while starting.");
        }
        const freshConv = this.getConversation(convId);
        if (!freshConv) throw new Error("Conversation was deleted while the call was starting.");
        provisional.initialItems = buildRealtimeInitialItems(
          freshConv,
          this.getEffectiveInstructions(convId),
          this.getAccountScope() ?? undefined,
        );
        provisional.state = "waiting_for_media";
        this.emitState(provisional, "Bidi is ready; waiting for the client microphone/speaker connection.");
        return provisional;
      } catch (error) {
        const interrupted = this.active !== provisional
          || provisional.state === "stopping"
          || provisional.state === "closed";
        if (!interrupted) {
          provisional.state = "error";
          this.emitState(provisional, error instanceof Error ? error.message : String(error));
          if (this.active === provisional) this.active = null;
          await transport.stop();
        }
        throw error;
      }
    })();
    this.starting = start;
    try {
      const active = await start;
      return { callId: active.callId, state: active.state };
    } finally {
      if (this.starting === start) this.starting = null;
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
      });
      this.server.sendTo(client, {
        type: "call_sdp_answer",
        reqId,
        convId: call.convId,
        callId: call.callId,
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
    const call = this.active;
    if (!call || call.convId !== convId || (callId && call.callId !== callId)) {
      throw new Error("No matching realtime call is active.");
    }
    if (call.state === "stopping" || call.state === "closed") return;
    call.state = "stopping";
    this.emitState(call, "Stopping realtime call…");
    try {
      await call.transport.stop();
    } finally {
      this.flushTranscriptBuffers(call);
      call.state = "closed";
      this.persistCallStatus(call, "Realtime call ended.");
      this.emitState(call);
      if (this.active === call) this.active = null;
    }
  }

  async stopAll(): Promise<void> {
    const call = this.active;
    if (!call) return;
    await this.stop(call.convId, call.callId).catch(error => {
      log("warn", `realtime call: shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private requireCall(convId: string, callId: string): ActiveCall {
    const call = this.active;
    if (!call || call.convId !== convId || call.callId !== callId) {
      throw new Error("No matching realtime call is active.");
    }
    return call;
  }

  private emitState(call: ActiveCall, message?: string): void {
    this.server.sendToSubscribers(call.convId, {
      type: "call_state",
      convId: call.convId,
      callId: call.callId,
      state: call.state,
      ...(message ? { message } : {}),
    });
  }

  private async handleEvent(event: RealtimeSidebandEvent): Promise<void> {
    const call = this.active;
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
          if (call.userTranscriptFinal && call.transcript.assistant.text.trim()) {
            this.finalizeTranscript(call, "assistant", call.transcript.assistant.text);
          }
          call.userTranscriptFinal = false;
        }
        this.server.sendToSubscribers(call.convId, {
          type: "call_transcript",
          convId: call.convId,
          callId: call.callId,
          role: event.role,
          text: accumulator.text,
          final: false,
          startedAt: accumulator.startedAt ?? Date.now(),
          endedAt: null,
          model: REALTIME_MODEL,
          tokens: estimateRealtimeTokens(accumulator.text),
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
        if (event.role === "user" && call.userTranscriptFinal && call.transcript.assistant.text.trim()) {
          this.finalizeTranscript(call, "assistant", call.transcript.assistant.text);
        }
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
        const text = event.text.trim();
        if (!text) break;
        // Frameless Bidi can replace the user's turn.done with
        // delegation.created. Preserve the spoken request before routing it.
        this.finalizeTranscript(call, "user", text);
        call.userTranscriptFinal = true;
        call.pendingHandoffUserKey = transcriptKey(text);
        void this.handleHandoff(call, event.handoffId, text);
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
        if (this.active === call) this.active = null;
        break;
    }
  }

  private finalizeTranscript(
    call: ActiveCall,
    role: "user" | "assistant",
    text: string,
    providerTokens?: number,
  ): void {
    const normalized = text.trim();
    if (!normalized) return;
    const accumulator = call.transcript[role];
    const key = transcriptKey(normalized);
    const endedAt = Date.now();
    const startedAt = accumulator.startedAt
      ?? (role === "assistant" ? call.assistantResponseStartedAt : null)
      ?? endedAt;
    const tokens = providerTokens ?? estimateRealtimeTokens(normalized);
    accumulator.text = "";
    accumulator.startedAt = null;
    if (accumulator.finalKey === key) return;
    accumulator.finalKey = key;
    this.server.sendToSubscribers(call.convId, {
      type: "call_transcript",
      convId: call.convId,
      callId: call.callId,
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
      ...(role === "assistant" ? { model: REALTIME_MODEL, tokens } : {}),
    })) {
      broadcastConversationHistoryUpdated(this.server, call.convId);
      broadcastConversationUpdated(this.server, call.convId);
    }
    if (role === "user") call.assistantResponseStartedAt = endedAt;
  }

  private persistCallStatus(call: ActiveCall, text: string): void {
    if (!this.persistStatus(call.convId, text)) return;
    broadcastConversationHistoryUpdated(this.server, call.convId);
    broadcastConversationUpdated(this.server, call.convId);
  }

  private flushTranscriptBuffers(call: ActiveCall): void {
    this.finalizeTranscript(call, "user", call.transcript.user.text);
    this.finalizeTranscript(call, "assistant", call.transcript.assistant.text);
    call.userTranscriptFinal = false;
    call.pendingHandoffUserKey = null;
  }

  private async handleHandoff(call: ActiveCall, handoffId: string, text: string): Promise<void> {
    if (!this.delegate || call.handoffInFlight || this.active !== call) return;
    call.handoffInFlight = true;
    call.state = "delegating";
    // Delegation is an implementation detail of an otherwise continuous voice
    // reply. Publish the state transition for adapters, but do not inject a
    // visible lifecycle notice into conversation history.
    this.emitState(call);
    try {
      const result = (await this.delegate(call.convId, text)).trim();
      if (result && this.active === call) await call.transport.appendHandoff(handoffId, result);
    } catch (error) {
      log("warn", `realtime call: handoff failed for ${call.convId}: ${error instanceof Error ? error.message : String(error)}`);
      if (this.active === call) {
        await call.transport.appendHandoff(handoffId, "I couldn't complete that delegated request.").catch(() => {});
      }
    } finally {
      call.handoffInFlight = false;
      if (this.active === call && call.state === "delegating") {
        call.state = "live";
        this.emitState(call);
      }
    }
  }
}
