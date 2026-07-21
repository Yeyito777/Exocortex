// Conversation-owned, durable one-shot `/btw` sessions.
//
// A session freezes the source conversation's provider replay and settings, then
// runs a separate agent loop whose only tools are an explicit read-only
// allowlist. Its query/answer are not appended to model-visible chat history,
// but the panel state is persisted by conversation until explicitly closed.

import type { BtwQueryCommand, Event } from "./protocol";
import type { DaemonServer, ConnectedClient } from "./server";
import { runAgentLoop } from "./agent";
import { createProviderTurnSession } from "./api";
import { hasConfiguredCredentials } from "./auth";
import { buildConversationApiContext } from "./context-compaction";
import * as convStore from "./conversations";
import { onConversationRemoved } from "./conversation-lifecycle";
import { log } from "./log";
import type { ApiMessage, Conversation, ConversationBtw, ProviderId } from "./messages";
import * as persistence from "./persistence";
import { getCurrentAccountScope as getCurrentOpenAIAccountScope } from "./providers/openai/auth";
import { buildCodexWindowId } from "./providers/openai/identity";
import { buildSystemPrompt } from "./system";
import { buildExecutor, getToolDefs, summarizeTool } from "./tools/registry";
import type { ToolExecutionContext } from "./tools/types";

export const BTW_READ_ONLY_TOOLS = ["read", "grep", "glob", "browse"] as const;

const BTW_WRAPPER_NOTE = [
  "# BTW session",
  "You are answering a one-shot question against a frozen snapshot of an existing conversation.",
  "Answer the user's BTW query directly and do not ask follow-up questions.",
  "This answer is displayed in a conversation-owned panel and is not part of the model-visible transcript.",
  "You have read-only tools only. Do not attempt or claim to modify files, processes, conversations, schedules, or external state.",
].join("\n");

const BTW_PERSIST_DEBOUNCE_MS = 100;
const BTW_PERSIST_RETRY_MS = 250;
const BTW_RESTART_ERROR = "Interrupted by daemon restart.";

interface BtwSession {
  id: string;
  convId: string;
  provider: ProviderId;
  abort: AbortController;
  running: boolean;
  /** Non-subscribed requesters that need direct stream delivery until disconnect. */
  requesters: Map<ConnectedClient, () => void>;
}

export type BtwCloseResult = "closed" | "already_closed" | "failed";

export interface BtwSessionCallbacks {
  onHeaders(provider: ProviderId, headers: Headers): void;
  onComplete(provider: ProviderId): void;
  cannotStart?(provider: ProviderId): string | null;
}

export interface BtwSessionDependencies {
  runAgentLoop: typeof runAgentLoop;
  hasConfiguredCredentials: typeof hasConfiguredCredentials;
  loadConversationBtwState: typeof persistence.loadConversationBtwState;
  saveConversationBtwState: typeof persistence.saveConversationBtwState;
}

function answerText(messages: readonly { type: string; text?: string }[]): string {
  return messages
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("");
}

function abortIsSessionClose(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function cloneBtw(btw: ConversationBtw): ConversationBtw {
  return { ...btw };
}

export class BtwSessionManager {
  private readonly sessions = new Map<string, BtwSession>();
  private readonly states: Map<string, ConversationBtw>;
  private readonly seenSessionIds: Map<string, Set<string>>;
  /** Includes abort cleanup after a panel has already been removed/replaced. */
  private readonly inFlightProviders = new Map<ProviderId, number>();
  private readonly dependencies: BtwSessionDependencies;
  private readonly removeConversationListener: () => void;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly server: DaemonServer,
    private readonly callbacks: BtwSessionCallbacks,
    dependencies: Partial<BtwSessionDependencies> = {},
  ) {
    this.dependencies = {
      runAgentLoop: dependencies.runAgentLoop ?? runAgentLoop,
      hasConfiguredCredentials: dependencies.hasConfiguredCredentials ?? hasConfiguredCredentials,
      loadConversationBtwState: dependencies.loadConversationBtwState ?? persistence.loadConversationBtwState,
      saveConversationBtwState: dependencies.saveConversationBtwState ?? persistence.saveConversationBtwState,
    };
    const persisted = this.dependencies.loadConversationBtwState();
    this.states = new Map(
      [...persisted.btws].map(([convId, btw]) => [convId, cloneBtw(btw)]),
    );
    this.seenSessionIds = new Map(
      [...persisted.seenSessionIds].map(([convId, ids]) => [convId, new Set(ids)]),
    );

    // Provider calls cannot survive a daemon process restart. Retain their latest
    // durable text as an error panel rather than dropping the conversation's BTW.
    let recovered = false;
    const recoveredAt = Date.now();
    for (const [convId, btw] of this.states) {
      const seen = this.seenSessionIds.get(convId) ?? new Set<string>();
      if (!seen.has(btw.sessionId)) {
        seen.add(btw.sessionId);
        this.seenSessionIds.set(convId, seen);
        recovered = true;
      }
      if (btw.phase !== "running") continue;
      btw.phase = "error";
      btw.status = BTW_RESTART_ERROR;
      btw.endedAt = recoveredAt;
      recovered = true;
    }
    if (recovered) this.persistNow();

    this.removeConversationListener = onConversationRemoved((convId) => this.removeConversation(convId));
  }

  hasRunningProvider(provider: ProviderId): boolean {
    return (this.inFlightProviders.get(provider) ?? 0) > 0;
  }

  private addRequester(session: BtwSession, client: ConnectedClient): void {
    if (client.subscriptions.has(session.convId) || session.requesters.has(client)) return;
    const onClose = () => session.requesters.delete(client);
    session.requesters.set(client, onClose);
    client.socket.once("close", onClose);
  }

  private clearRequesters(session: BtwSession): void {
    for (const [client, onClose] of session.requesters) client.socket.off("close", onClose);
    session.requesters.clear();
  }

  private requesterList(session: BtwSession | undefined, client?: ConnectedClient): ConnectedClient[] {
    return [...new Set([...(client ? [client] : []), ...(session?.requesters.keys() ?? [])])];
  }

  private rememberSession(convId: string, sessionId: string): Set<string> | null {
    const previous = this.seenSessionIds.get(convId);
    const snapshot = previous ? new Set(previous) : null;
    const next = previous ?? new Set<string>();
    next.add(sessionId);
    this.seenSessionIds.set(convId, next);
    return snapshot;
  }

  private restoreSeenSessions(convId: string, previous: Set<string> | null): void {
    if (previous) this.seenSessionIds.set(convId, previous);
    else this.seenSessionIds.delete(convId);
  }

  /** Authoritative durable state for conversation loads and catch-up snapshots. */
  getSnapshot(convId: string): ConversationBtw | null {
    const btw = this.states.get(convId);
    return btw ? cloneBtw(btw) : null;
  }

  sendSnapshot(client: ConnectedClient, convId: string): void {
    const btw = this.getSnapshot(convId);
    this.server.sendTo(client, { type: "btw_snapshot", convId, btw });
  }

  /** Test/service cleanup; durable panels intentionally remain available afterward. */
  dispose(): void {
    this.removeConversationListener();
    for (const session of this.sessions.values()) {
      if (session.running) session.abort.abort("btw-manager-disposed");
      this.clearRequesters(session);
    }
    this.sessions.clear();
    this.disposed = true;
    this.persistNow();
  }

  close(client: ConnectedClient, convId: string, requestedSessionId?: string, notify = true): BtwCloseResult {
    const state = this.states.get(convId);
    if (!state || (requestedSessionId && requestedSessionId !== state.sessionId)) {
      // A targeted close is idempotent. A replay after an ambiguous disconnect
      // still receives confirmation even when the original close already won.
      if (notify && requestedSessionId) {
        const alreadySeen = this.seenSessionIds.get(convId)?.has(requestedSessionId) ?? false;
        if (!alreadySeen) {
          const previousSeen = this.rememberSession(convId, requestedSessionId);
          if (!this.persistNow()) {
            this.restoreSeenSessions(convId, previousSeen);
            this.server.sendTo(client, { type: "btw_snapshot", convId, btw: state ? cloneBtw(state) : null });
            this.server.sendTo(client, { type: "error", convId, message: "Failed to persist BTW close; it will be retried after reconnect." });
            return "failed";
          }
        }
        this.server.sendTo(client, {
          type: "btw_mutation_settled",
          convId,
          sessionId: requestedSessionId,
          mutation: "close",
        });
        this.emit(convId, { type: "btw_closed", convId, sessionId: requestedSessionId }, [client]);
      }
      return "already_closed";
    }

    const session = this.sessions.get(convId);
    const previousSeen = this.rememberSession(convId, state.sessionId);
    this.states.delete(convId);
    if (!this.persistNow()) {
      // Never acknowledge a close that was not durably applied. Restore the
      // authoritative panel; the client retains and replays its close mutation.
      this.states.set(convId, state);
      this.restoreSeenSessions(convId, previousSeen);
      this.server.sendTo(client, { type: "btw_snapshot", convId, btw: cloneBtw(state) });
      this.server.sendTo(client, { type: "error", convId, message: "Failed to persist BTW close; it will be retried after reconnect." });
      return "failed";
    }
    if (session?.id === state.sessionId) {
      this.sessions.delete(convId);
      if (session.running) session.abort.abort("btw-closed");
    }
    if (notify) {
      this.server.sendTo(client, {
        type: "btw_mutation_settled",
        convId,
        sessionId: state.sessionId,
        mutation: "close",
      });
      this.emit(convId, { type: "btw_closed", convId, sessionId: state.sessionId }, this.requesterList(session, client));
    }
    if (session) this.clearRequesters(session);
    log("info", `btw: closed session ${state.sessionId} for ${convId}${session?.running ? " (interrupted)" : ""}`);
    return "closed";
  }

  start(client: ConnectedClient, command: BtwQueryCommand): void {
    const conv = convStore.get(command.convId);
    const query = command.query.trim();
    if (!conv) {
      this.server.sendTo(client, {
        type: "btw_error",
        convId: command.convId,
        sessionId: command.sessionId,
        message: `Conversation ${command.convId} not found`,
        endedAt: Date.now(),
      });
      return;
    }

    const existingState = this.states.get(command.convId);
    if (this.seenSessionIds.get(command.convId)?.has(command.sessionId)) {
      // Session ids are stable mutation ids. Replaying an ambiguous query must
      // catch the requester up, not restart provider work, overwrite a newer
      // session, or resurrect a panel that another client already closed.
      const existingSession = existingState?.sessionId === command.sessionId
        ? this.sessions.get(command.convId)
        : undefined;
      if (existingSession) this.addRequester(existingSession, client);
      this.server.sendTo(client, {
        type: "btw_mutation_settled",
        convId: command.convId,
        sessionId: command.sessionId,
        mutation: "start",
      });
      this.server.sendTo(client, {
        type: "btw_snapshot",
        convId: command.convId,
        btw: existingState ? cloneBtw(existingState) : null,
      });
      return;
    }

    const startFailure = !query
      ? "Usage: /btw <query>"
      : this.callbacks.cannotStart?.(conv.provider)
        ?? (!this.dependencies.hasConfiguredCredentials(conv.provider)
          ? `Not authenticated for provider ${conv.provider}.`
          : null);
    if (startFailure) {
      this.replaceWithError(client, command, conv, query, startFailure);
      return;
    }

    // Freeze every source setting and all replay data before starting any async
    // work. The live conversation may continue streaming and mutating afterward.
    const provider = conv.provider;
    const model = conv.model;
    const effort = conv.effort;
    const fastMode = conv.fastMode;
    const instructions = convStore.getEffectiveSystemInstructions(command.convId);
    const accountScope = provider === "openai" ? getCurrentOpenAIAccountScope() ?? undefined : undefined;
    const builtSnapshot = buildConversationApiContext(conv, accountScope);
    const sourceWindowId = builtSnapshot.usedActiveContext && conv.activeContext
      ? conv.activeContext.windowId
      : buildCodexWindowId(command.convId);
    const snapshot = builtSnapshot.messages;
    const messages: ApiMessage[] = [
      ...snapshot,
      { role: "user", content: query },
    ];
    const abort = new AbortController();
    const session: BtwSession = {
      id: command.sessionId,
      convId: command.convId,
      provider,
      abort,
      running: true,
      requesters: new Map(),
    };
    this.addRequester(session, client);
    const state: ConversationBtw = {
      sessionId: command.sessionId,
      query,
      provider,
      model,
      startedAt: command.startedAt,
      endedAt: null,
      phase: "running",
      text: "",
      status: "Thinking…",
    };
    // A new query atomically replaces only this conversation's prior panel. If
    // the durable write fails, keep the previous session alive and authoritative.
    const previousState = this.states.get(command.convId);
    const previousSession = this.sessions.get(command.convId);
    const previousSeen = this.rememberSession(command.convId, command.sessionId);
    this.sessions.set(command.convId, session);
    this.states.set(command.convId, state);
    if (!this.persistNow()) {
      if (previousState) this.states.set(command.convId, previousState);
      else this.states.delete(command.convId);
      if (previousSession) this.sessions.set(command.convId, previousSession);
      else this.sessions.delete(command.convId);
      this.restoreSeenSessions(command.convId, previousSeen);
      this.clearRequesters(session);
      this.server.sendTo(client, {
        type: "btw_snapshot",
        convId: command.convId,
        btw: previousState ? cloneBtw(previousState) : null,
      });
      this.server.sendTo(client, { type: "error", convId: command.convId, message: "Failed to persist BTW start; it will be retried after reconnect." });
      return;
    }
    if (previousSession?.running) previousSession.abort.abort("btw-replaced");
    this.server.sendTo(client, {
      type: "btw_mutation_settled",
      convId: command.convId,
      sessionId: command.sessionId,
      mutation: "start",
    });
    if (previousState) {
      this.emit(command.convId, {
        type: "btw_closed",
        convId: command.convId,
        sessionId: previousState.sessionId,
      }, this.requesterList(previousSession, client));
    }
    if (previousSession) this.clearRequesters(previousSession);
    this.inFlightProviders.set(provider, (this.inFlightProviders.get(provider) ?? 0) + 1);

    this.emit(command.convId, {
      type: "btw_started",
      sessionId: command.sessionId,
      convId: command.convId,
      query,
      provider,
      model,
      startedAt: command.startedAt,
    }, [...session.requesters.keys()]);

    const isCurrent = () => (
      this.sessions.get(command.convId) === session
      && this.states.get(command.convId)?.sessionId === session.id
    );
    const sendStatus = (status: string) => {
      if (!isCurrent()) return;
      state.status = status;
      this.persistSoon();
      this.emit(command.convId, { type: "btw_status", convId: command.convId, sessionId: session.id, status }, [...session.requesters.keys()]);
    };
    const sendContent = (text: string) => {
      if (!isCurrent()) return;
      state.text = text;
      this.persistSoon();
      this.emit(command.convId, { type: "btw_content", convId: command.convId, sessionId: session.id, text }, [...session.requesters.keys()]);
    };

    const system = buildSystemPrompt({
      conversationInstructions: instructions || undefined,
      conversationId: command.convId,
      toolNames: BTW_READ_ONLY_TOOLS,
      includeExternalToolHints: false,
      wrapperNote: BTW_WRAPPER_NOTE,
    });
    const tools = getToolDefs(BTW_READ_ONLY_TOOLS);
    const toolContext: ToolExecutionContext = {
      provider,
      model,
      conversationId: command.convId,
    };
    const executor = buildExecutor(toolContext, BTW_READ_ONLY_TOOLS);
    const providerTurnSession = createProviderTurnSession(provider);
    let committedText = "";
    let roundText = "";
    // OpenAI maps promptCacheKey to remote session/thread identity, so every
    // isolated copy must have its own key rather than sharing BTW history.
    const providerSessionKey = `${command.convId}:btw:${session.id}`;

    log("info", `btw: starting session ${session.id} for ${command.convId} from frozen snapshot (${provider}/${model}, snapshot=${snapshot.length})`);
    sendStatus("Thinking…");

    void this.dependencies.runAgentLoop(messages, provider, model, {
      onBlockStart: (type) => {
        sendStatus(type === "thinking" ? "Thinking…" : "Answering…");
      },
      onTextChunk: (text) => {
        roundText += text;
        if (!isCurrent()) return;
        state.text += text;
        this.persistSoon();
        this.emit(command.convId, { type: "btw_text_chunk", convId: command.convId, sessionId: session.id, text }, [...session.requesters.keys()]);
      },
      onThinkingChunk() {},
      onBlocksUpdate: (blocks) => {
        roundText = answerText(blocks);
        sendContent(committedText + roundText);
      },
      onSignature() {},
      onToolCall: (block) => {
        const summary = summarizeTool(block.toolName, block.input);
        sendStatus(`Using ${summary.detail || summary.label || block.toolName}…`);
      },
      onToolResult: () => {
        sendStatus("Reviewing results…");
      },
      onTokensUpdate() {},
      onContextUpdate() {},
      onHeaders: headers => this.callbacks.onHeaders(provider, headers),
      onRetry: (attempt, maxAttempts, errorMessage) => {
        roundText = "";
        sendContent(committedText);
        sendStatus(`Retrying ${attempt}/${maxAttempts}: ${errorMessage}`);
      },
      onRoundComplete: () => {
        committedText += roundText;
        roundText = "";
        sendStatus("Thinking…");
      },
    }, {
      system,
      signal: abort.signal,
      executor,
      summarizer: (name, input) => {
        const summary = summarizeTool(name, input);
        return summary.detail || summary.label;
      },
      tools,
      effort,
      serviceTier: fastMode ? "fast" : undefined,
      promptCacheKey: providerSessionKey,
      tracking: { source: "btw", conversationId: command.convId },
      turnSession: providerTurnSession ?? undefined,
      getCodexWindowId: () => `${sourceWindowId}:btw:${session.id}`,
      accountScope,
      codexTurnId: `${command.convId}:btw:${session.id}`,
      codexTurnStartedAtMs: command.startedAt,
    }).then(result => {
      if (!isCurrent()) return;
      session.running = false;
      sendContent(answerText(result.blocks));
      const endedAt = Date.now();
      state.phase = "complete";
      state.status = "Complete";
      state.endedAt = endedAt;
      this.persistNow();
      this.emit(command.convId, { type: "btw_finished", convId: command.convId, sessionId: session.id, endedAt }, [...session.requesters.keys()]);
      this.sessions.delete(command.convId);
      this.clearRequesters(session);
      log("info", `btw: completed session ${session.id} for ${command.convId}`);
    }).catch(error => {
      if (!isCurrent() || abortIsSessionClose(error, abort.signal)) return;
      session.running = false;
      const message = error instanceof Error ? error.message : String(error);
      const endedAt = Date.now();
      state.phase = "error";
      state.status = message;
      state.endedAt = endedAt;
      this.persistNow();
      this.emit(command.convId, { type: "btw_error", convId: command.convId, sessionId: session.id, message, endedAt }, [...session.requesters.keys()]);
      this.sessions.delete(command.convId);
      this.clearRequesters(session);
      log("warn", `btw: session ${session.id} failed: ${message}`);
    }).finally(() => {
      const remaining = (this.inFlightProviders.get(provider) ?? 1) - 1;
      if (remaining > 0) this.inFlightProviders.set(provider, remaining);
      else this.inFlightProviders.delete(provider);
      try {
        this.callbacks.onComplete(provider);
      } catch (error) {
        log("warn", `btw: completion callback failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private replaceWithError(
    client: ConnectedClient,
    command: BtwQueryCommand,
    conv: Conversation,
    query: string,
    message: string,
  ): void {
    const endedAt = Date.now();
    const btw: ConversationBtw = {
      sessionId: command.sessionId,
      query,
      provider: conv.provider,
      model: conv.model,
      startedAt: command.startedAt,
      endedAt,
      phase: "error",
      text: "",
      status: message,
    };
    const previousState = this.states.get(command.convId);
    const previousSession = this.sessions.get(command.convId);
    const previousSeen = this.rememberSession(command.convId, command.sessionId);
    this.states.set(command.convId, btw);
    this.sessions.delete(command.convId);
    if (!this.persistNow()) {
      if (previousState) this.states.set(command.convId, previousState);
      else this.states.delete(command.convId);
      if (previousSession) this.sessions.set(command.convId, previousSession);
      this.restoreSeenSessions(command.convId, previousSeen);
      this.server.sendTo(client, {
        type: "btw_snapshot",
        convId: command.convId,
        btw: previousState ? cloneBtw(previousState) : null,
      });
      this.server.sendTo(client, { type: "error", convId: command.convId, message: "Failed to persist BTW error state; it will be retried after reconnect." });
      return;
    }
    if (previousSession?.running) previousSession.abort.abort("btw-replaced");
    this.server.sendTo(client, {
      type: "btw_mutation_settled",
      convId: command.convId,
      sessionId: command.sessionId,
      mutation: "start",
    });
    if (previousState) {
      this.emit(command.convId, {
        type: "btw_closed",
        convId: command.convId,
        sessionId: previousState.sessionId,
      }, this.requesterList(previousSession, client));
    }
    if (previousSession) this.clearRequesters(previousSession);
    this.emit(command.convId, { type: "btw_snapshot", convId: command.convId, btw: cloneBtw(btw) }, [client]);
    this.emit(command.convId, {
      type: "btw_error",
      convId: command.convId,
      sessionId: command.sessionId,
      message,
      endedAt,
    }, [client]);
  }

  private emit(convId: string, event: Event, requesters: readonly ConnectedClient[] = []): void {
    this.server.sendToSubscribers(convId, event);
    for (const client of requesters) {
      if (!client.subscriptions.has(convId)) this.server.sendTo(client, event);
    }
  }

  private removeConversation(convId: string): void {
    const session = this.sessions.get(convId);
    if (session?.running) session.abort.abort("conversation-removed");
    if (session) this.clearRequesters(session);
    this.sessions.delete(convId);
    // Keep accepted-session receipts across recoverable trash/undo. They prevent
    // a disconnected client from resurrecting deleted work if this ID is restored.
    if (this.states.delete(convId)) this.persistNow();
  }

  private persistSoon(delay = BTW_PERSIST_DEBOUNCE_MS): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.saveStates();
    }, delay);
    this.persistTimer.unref?.();
  }

  private persistNow(): boolean {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    return this.saveStates();
  }

  private saveStates(): boolean {
    try {
      this.dependencies.saveConversationBtwState({
        btws: this.states,
        seenSessionIds: this.seenSessionIds,
      });
      return true;
    } catch (error) {
      log("error", `btw: failed to persist conversation panels: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.disposed) this.persistSoon(BTW_PERSIST_RETRY_MS);
      return false;
    }
  }
}
