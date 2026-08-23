// Conversation-owned, durable `/btw` aside threads.
//
// A session freezes the source conversation's provider replay and settings, then
// runs separate agent turns whose only tools are an explicit read-only
// allowlist. Its questions/answers are not appended to model-visible chat history,
// but the panel state is persisted by conversation until explicitly closed.

import type { BtwFollowupCommand, BtwQueryCommand, Event } from "../protocol";
import type { DaemonServer, ConnectedClient } from "../server";
import { runAgentLoop } from "../agent";
import { hasConfiguredCredentials } from "../auth";
import * as convStore from "../conversations";
import { onConversationRemoved, onConversationRemoving } from "../conversation-lifecycle";
import { log } from "../log";
import type { Block, Conversation, ConversationBtw, ConversationBtwTurn, ProviderId } from "../messages";
import * as persistence from "../persistence";
import { BtwWorkspaceError, prepareBtwFollowupRun, prepareBtwRun, runBtw, type PreparedBtwRun } from "./runner";
import { cloneBtw, ensureConversationBtwTurns, syncConversationBtwFromTurn, textFromBtwBlocks } from "./blocks";
import { BtwRuntime } from "./runtime";
import { BtwStateStore } from "./state-store";
import type {
  BtwCloseResult,
  BtwSession,
  BtwSessionCallbacks,
  BtwSessionDependencies,
} from "./types";

function abortIsSessionClose(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

export class BtwSessionManager {
  private readonly runtime = new BtwRuntime();
  private readonly stateStore: BtwStateStore;
  private readonly dependencies: BtwSessionDependencies;
  private readonly removeConversationListener: () => void;
  private readonly removingConversationListener: () => void;

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
    this.stateStore = new BtwStateStore(this.dependencies);
    this.removeConversationListener = onConversationRemoved((convId) => this.removeConversation(convId));
    this.removingConversationListener = onConversationRemoving((convId) => {
      const session = this.runtime.get(convId);
      if (session?.running) session.abort.abort("conversation-being-removed");
    });
  }

  hasRunningProvider(provider: ProviderId): boolean {
    return this.runtime.hasRunningProvider(provider);
  }

  /** Authoritative durable state for conversation loads and catch-up snapshots. */
  getSnapshot(convId: string): ConversationBtw | null {
    return this.stateStore.getSnapshot(convId);
  }

  sendSnapshot(client: ConnectedClient, convId: string): void {
    this.server.sendTo(client, {
      type: "btw_snapshot",
      convId,
      btw: this.stateStore.getSnapshot(convId),
    });
  }

  /** Test/service cleanup; durable panels intentionally remain available afterward. */
  dispose(): void {
    this.removeConversationListener();
    this.removingConversationListener();
    this.runtime.dispose();
    this.stateStore.dispose();
  }

  close(client: ConnectedClient, convId: string, requestedSessionId?: string, notify = true): BtwCloseResult {
    const state = this.stateStore.get(convId);
    if (!state || (requestedSessionId && requestedSessionId !== state.sessionId)) {
      // A targeted close is idempotent. A replay after an ambiguous disconnect
      // still receives confirmation even when the original close already won.
      if (notify && requestedSessionId) {
        if (!this.stateStore.hasSeen(convId, requestedSessionId)) {
          const previousSeen = this.stateStore.remember(convId, requestedSessionId);
          if (!this.stateStore.persistNow()) {
            this.stateStore.restoreRemembered(convId, previousSeen);
            this.server.sendTo(client, {
              type: "btw_snapshot",
              convId,
              btw: this.stateStore.getSnapshot(convId),
            });
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

    const session = this.runtime.get(convId);
    const previousSeen = this.stateStore.remember(convId, state.sessionId);
    this.stateStore.delete(convId);
    if (!this.stateStore.persistNow()) {
      // Never acknowledge a close that was not durably applied. Restore the
      // authoritative panel; the client retains and replays its close mutation.
      this.stateStore.set(convId, state);
      this.stateStore.restoreRemembered(convId, previousSeen);
      this.server.sendTo(client, { type: "btw_snapshot", convId, btw: { ...state } });
      this.server.sendTo(client, { type: "error", convId, message: "Failed to persist BTW close; it will be retried after reconnect." });
      return "failed";
    }
    if (session?.id === state.sessionId) {
      this.runtime.delete(convId);
      if (session.running) session.abort.abort("btw-closed");
    }
    if (notify) {
      this.server.sendTo(client, {
        type: "btw_mutation_settled",
        convId,
        sessionId: state.sessionId,
        mutation: "close",
      });
      this.emit(
        convId,
        { type: "btw_closed", convId, sessionId: state.sessionId },
        this.runtime.requesterList(session, client),
      );
    }
    if (session) this.runtime.clearRequesters(session);
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

    const existingState = this.stateStore.get(command.convId);
    if (this.stateStore.hasSeen(command.convId, command.sessionId)) {
      // Session ids are stable mutation ids. Replaying an ambiguous query must
      // catch the requester up, not restart provider work, overwrite a newer
      // session, or resurrect a panel that another client already closed.
      const existingSession = existingState?.sessionId === command.sessionId
        ? this.runtime.get(command.convId)
        : undefined;
      if (existingSession) this.runtime.addRequester(existingSession, client);
      this.server.sendTo(client, {
        type: "btw_mutation_settled",
        convId: command.convId,
        sessionId: command.sessionId,
        mutation: "start",
      });
      this.server.sendTo(client, {
        type: "btw_snapshot",
        convId: command.convId,
        btw: this.stateStore.getSnapshot(command.convId),
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
    let prepared: ReturnType<typeof prepareBtwRun>;
    try {
      prepared = prepareBtwRun(conv, command, query);
    } catch (error) {
      if (!(error instanceof BtwWorkspaceError)) throw error;
      this.replaceWithError(client, command, conv, query, error.message);
      return;
    }

    const abort = new AbortController();
    const session: BtwSession = {
      id: command.sessionId,
      turnId: command.sessionId,
      convId: command.convId,
      provider: prepared.provider,
      abort,
      running: true,
      requesters: new Map(),
    };
    this.runtime.addRequester(session, client);
    const turn: ConversationBtwTurn = {
      id: command.sessionId,
      query,
      startedAt: command.startedAt,
      endedAt: null,
      phase: "running",
      blocks: [],
      text: "",
      status: "Thinking…",
    };
    const state: ConversationBtw = {
      sessionId: command.sessionId,
      provider: prepared.provider,
      model: prepared.model,
      query: turn.query,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      phase: turn.phase,
      blocks: turn.blocks,
      text: turn.text,
      status: turn.status,
      turns: [turn],
    };
    // A new query atomically replaces only this conversation's prior panel. If
    // the durable write fails, keep the previous session alive and authoritative.
    const previousState = this.stateStore.get(command.convId);
    const previousSession = this.runtime.get(command.convId);
    const previousSeen = this.stateStore.remember(command.convId, command.sessionId);
    this.runtime.set(command.convId, session);
    this.stateStore.set(command.convId, state);
    if (!this.stateStore.persistNow()) {
      if (previousState) this.stateStore.set(command.convId, previousState);
      else this.stateStore.delete(command.convId);
      if (previousSession) this.runtime.set(command.convId, previousSession);
      else this.runtime.delete(command.convId);
      this.stateStore.restoreRemembered(command.convId, previousSeen);
      this.runtime.clearRequesters(session);
      this.server.sendTo(client, {
        type: "btw_snapshot",
        convId: command.convId,
        btw: previousState ? { ...previousState } : null,
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
      }, this.runtime.requesterList(previousSession, client));
    }
    if (previousSession) this.runtime.clearRequesters(previousSession);
    this.launchTurn(prepared, state, turn, session, "start");
  }

  /** Append a question to a retained BTW panel without replacing its identity/history. */
  followup(client: ConnectedClient, command: BtwFollowupCommand): void {
    const conv = convStore.get(command.convId);
    const existing = this.stateStore.get(command.convId);

    if (this.stateStore.hasSeen(command.convId, command.turnId)) {
      const live = this.runtime.get(command.convId);
      if (live?.id === command.sessionId && live.turnId === command.turnId) {
        this.runtime.addRequester(live, client);
      }
      this.server.sendTo(client, {
        type: "btw_mutation_settled",
        convId: command.convId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        mutation: "followup",
      });
      this.sendSnapshot(client, command.convId);
      return;
    }

    if (!conv || !existing || existing.sessionId !== command.sessionId) {
      this.rejectFollowup(client, command, !conv
        ? `Conversation ${command.convId} not found`
        : "That /btw session is no longer open.");
      return;
    }
    if (existing.phase === "running" || this.runtime.get(command.convId)?.running) {
      this.rejectFollowup(client, command, "Wait for the current /btw answer before asking a follow-up.");
      return;
    }

    const query = command.query.trim();
    const startFailure = !query
      ? "Usage: /btw <query>"
      : this.callbacks.cannotStart?.(conv.provider)
        ?? (!this.dependencies.hasConfiguredCredentials(conv.provider)
          ? `Not authenticated for provider ${conv.provider}.`
          : null);
    if (startFailure) {
      this.appendFollowupError(client, command, existing, query, startFailure);
      return;
    }

    const nextState = cloneBtw(existing);
    ensureConversationBtwTurns(nextState);
    let prepared: PreparedBtwRun;
    try {
      prepared = prepareBtwFollowupRun(conv, command, nextState, query);
    } catch (error) {
      if (!(error instanceof BtwWorkspaceError)) throw error;
      this.appendFollowupError(client, command, existing, query, error.message);
      return;
    }

    const turn: ConversationBtwTurn = {
      id: command.turnId,
      query,
      startedAt: command.startedAt,
      endedAt: null,
      phase: "running",
      blocks: [],
      text: "",
      status: "Thinking…",
    };
    nextState.turns!.push(turn);
    syncConversationBtwFromTurn(nextState, turn);
    const session: BtwSession = {
      id: command.sessionId,
      turnId: command.turnId,
      convId: command.convId,
      provider: prepared.provider,
      abort: new AbortController(),
      running: true,
      requesters: new Map(),
    };
    this.runtime.addRequester(session, client);
    const previousSeen = this.stateStore.remember(command.convId, command.turnId);
    this.runtime.set(command.convId, session);
    this.stateStore.set(command.convId, nextState);
    if (!this.stateStore.persistNow()) {
      this.stateStore.set(command.convId, existing);
      this.runtime.delete(command.convId);
      this.stateStore.restoreRemembered(command.convId, previousSeen);
      this.runtime.clearRequesters(session);
      this.sendSnapshot(client, command.convId);
      this.server.sendTo(client, { type: "error", convId: command.convId, message: "Failed to persist BTW follow-up; it will be retried after reconnect." });
      return;
    }

    this.server.sendTo(client, {
      type: "btw_mutation_settled",
      convId: command.convId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      mutation: "followup",
    });
    this.launchTurn(prepared, nextState, turn, session, "followup");
  }

  private launchTurn(
    prepared: PreparedBtwRun,
    state: ConversationBtw,
    turn: ConversationBtwTurn,
    session: BtwSession,
    kind: "start" | "followup",
  ): void {
    const convId = session.convId;
    this.runtime.beginProvider(prepared.provider);
    if (kind === "start") {
      this.emit(convId, {
        type: "btw_started",
        sessionId: session.id,
        convId,
        query: turn.query,
        provider: prepared.provider,
        model: prepared.model,
        startedAt: turn.startedAt,
      }, [...session.requesters.keys()]);
    } else {
      this.emit(convId, {
        type: "btw_followup_started",
        sessionId: session.id,
        turnId: session.turnId,
        convId,
        query: turn.query,
        startedAt: turn.startedAt,
      }, [...session.requesters.keys()]);
    }

    const isCurrent = () => (
      this.runtime.isCurrent(convId, session)
      && this.stateStore.get(convId) === state
      && state.sessionId === session.id
      && state.turns?.at(-1) === turn
      && turn.id === session.turnId
    );
    const syncLatest = () => syncConversationBtwFromTurn(state, turn);
    const sendStatus = (status: string) => {
      if (!isCurrent()) return;
      turn.status = status;
      syncLatest();
      this.stateStore.persistSoon();
      this.emit(convId, {
        type: "btw_status",
        convId,
        sessionId: session.id,
        turnId: session.turnId,
        status,
      }, [...session.requesters.keys()]);
    };
    const persistProgress = () => this.stateStore.persistSoon();
    const matchingBlock = (type: "text" | "thinking"): Extract<Block, { type: "text" | "thinking" }> => {
      const last = turn.blocks?.at(-1);
      if (last?.type === type) return last;
      const block: Extract<Block, { type: "text" | "thinking" }> = { type, text: "" };
      (turn.blocks ??= []).push(block);
      syncLatest();
      return block;
    };
    const sendBlocks = (blocks: Block[]) => {
      if (!isCurrent()) return;
      turn.blocks = structuredClone(blocks);
      turn.text = textFromBtwBlocks(turn.blocks);
      syncLatest();
      persistProgress();
      this.emit(convId, {
        type: "btw_content",
        convId,
        sessionId: session.id,
        turnId: session.turnId,
        text: turn.text,
        blocks: structuredClone(turn.blocks),
      }, [...session.requesters.keys()]);
    };

    log("info", `btw: starting ${kind === "followup" ? "follow-up " : ""}turn ${session.turnId} in session ${session.id} for ${convId} (${prepared.provider}/${prepared.model}, snapshot=${prepared.snapshotSize})`);
    sendStatus("Thinking…");

    void runBtw(prepared, this.dependencies.runAgentLoop, session.abort.signal, {
      onStatus: sendStatus,
      onBlockStart: (blockType) => {
        if (!isCurrent()) return;
        (turn.blocks ??= []).push({ type: blockType, text: "" });
        syncLatest();
        persistProgress();
        this.emit(convId, {
          type: "btw_block_start",
          convId,
          sessionId: session.id,
          turnId: session.turnId,
          blockType,
        }, [...session.requesters.keys()]);
      },
      onTextChunk: (text) => {
        if (!isCurrent()) return;
        matchingBlock("text").text += text;
        turn.text = textFromBtwBlocks(turn.blocks ?? []);
        syncLatest();
        persistProgress();
        this.emit(convId, { type: "btw_text_chunk", convId, sessionId: session.id, turnId: session.turnId, text }, [...session.requesters.keys()]);
      },
      onThinkingChunk: (text) => {
        if (!isCurrent()) return;
        matchingBlock("thinking").text += text;
        syncLatest();
        persistProgress();
        this.emit(convId, { type: "btw_thinking_chunk", convId, sessionId: session.id, turnId: session.turnId, text }, [...session.requesters.keys()]);
      },
      onBlocksUpdate: sendBlocks,
      onToolCall: (block) => {
        if (!isCurrent()) return;
        (turn.blocks ??= []).push(structuredClone(block));
        syncLatest();
        persistProgress();
        this.emit(convId, {
          type: "btw_tool_call",
          convId,
          sessionId: session.id,
          turnId: session.turnId,
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          input: block.input,
          summary: block.summary,
          ...(block.presentation ? { presentation: block.presentation } : {}),
        }, [...session.requesters.keys()]);
      },
      onToolResult: (block) => {
        if (!isCurrent()) return;
        (turn.blocks ??= []).push(structuredClone(block));
        syncLatest();
        persistProgress();
        this.emit(convId, {
          type: "btw_tool_result",
          convId,
          sessionId: session.id,
          turnId: session.turnId,
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          output: block.output,
          isError: block.isError,
        }, [...session.requesters.keys()]);
      },
      onHeaders: headers => this.callbacks.onHeaders(prepared.provider, headers),
    }).then(blocks => {
      if (!isCurrent()) return;
      session.running = false;
      sendBlocks(blocks);
      const endedAt = Date.now();
      turn.phase = "complete";
      turn.status = "Complete";
      turn.endedAt = endedAt;
      syncLatest();
      this.stateStore.persistNow();
      this.emit(convId, { type: "btw_finished", convId, sessionId: session.id, turnId: session.turnId, endedAt }, [...session.requesters.keys()]);
      this.runtime.delete(convId);
      this.runtime.clearRequesters(session);
      log("info", `btw: completed turn ${session.turnId} in session ${session.id} for ${convId}`);
    }).catch(error => {
      if (!isCurrent() || abortIsSessionClose(error, session.abort.signal)) return;
      session.running = false;
      const message = error instanceof Error ? error.message : String(error);
      const endedAt = Date.now();
      turn.phase = "error";
      turn.status = message;
      turn.endedAt = endedAt;
      syncLatest();
      this.stateStore.persistNow();
      this.emit(convId, { type: "btw_error", convId, sessionId: session.id, turnId: session.turnId, message, endedAt }, [...session.requesters.keys()]);
      this.runtime.delete(convId);
      this.runtime.clearRequesters(session);
      log("warn", `btw: turn ${session.turnId} in session ${session.id} failed: ${message}`);
    }).finally(() => {
      this.runtime.finishProvider(prepared.provider);
      try {
        this.callbacks.onComplete(prepared.provider);
      } catch (error) {
        log("warn", `btw: completion callback failed for ${prepared.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private rejectFollowup(client: ConnectedClient, command: BtwFollowupCommand, message: string): void {
    const previousSeen = this.stateStore.remember(command.convId, command.turnId);
    if (!this.stateStore.persistNow()) {
      this.stateStore.restoreRemembered(command.convId, previousSeen);
      this.sendSnapshot(client, command.convId);
      this.server.sendTo(client, { type: "error", convId: command.convId, message: "Failed to settle BTW follow-up; it will be retried after reconnect." });
      return;
    }
    this.server.sendTo(client, {
      type: "btw_mutation_settled",
      convId: command.convId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      mutation: "followup",
    });
    this.sendSnapshot(client, command.convId);
    this.server.sendTo(client, { type: "error", convId: command.convId, message });
  }

  private appendFollowupError(
    client: ConnectedClient,
    command: BtwFollowupCommand,
    existing: ConversationBtw,
    query: string,
    message: string,
  ): void {
    const endedAt = Date.now();
    const nextState = cloneBtw(existing);
    const turns = ensureConversationBtwTurns(nextState);
    const turn: ConversationBtwTurn = {
      id: command.turnId,
      query,
      startedAt: command.startedAt,
      endedAt,
      phase: "error",
      blocks: [],
      text: "",
      status: message,
    };
    turns.push(turn);
    syncConversationBtwFromTurn(nextState, turn);
    const previousSeen = this.stateStore.remember(command.convId, command.turnId);
    this.stateStore.set(command.convId, nextState);
    if (!this.stateStore.persistNow()) {
      this.stateStore.set(command.convId, existing);
      this.stateStore.restoreRemembered(command.convId, previousSeen);
      this.sendSnapshot(client, command.convId);
      this.server.sendTo(client, { type: "error", convId: command.convId, message: "Failed to persist BTW follow-up error; it will be retried after reconnect." });
      return;
    }
    this.server.sendTo(client, {
      type: "btw_mutation_settled",
      convId: command.convId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      mutation: "followup",
    });
    this.emit(command.convId, {
      type: "btw_followup_started",
      sessionId: command.sessionId,
      turnId: command.turnId,
      convId: command.convId,
      query,
      startedAt: command.startedAt,
    }, [client]);
    this.emit(command.convId, {
      type: "btw_error",
      convId: command.convId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      message,
      endedAt,
    }, [client]);
  }

  private replaceWithError(
    client: ConnectedClient,
    command: BtwQueryCommand,
    conv: Conversation,
    query: string,
    message: string,
  ): void {
    const endedAt = Date.now();
    const turn: ConversationBtwTurn = {
      id: command.sessionId,
      query,
      startedAt: command.startedAt,
      endedAt,
      phase: "error",
      blocks: [],
      text: "",
      status: message,
    };
    const btw: ConversationBtw = {
      sessionId: command.sessionId,
      provider: conv.provider,
      model: conv.model,
      query: turn.query,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      phase: turn.phase,
      blocks: turn.blocks,
      text: turn.text,
      status: turn.status,
      turns: [turn],
    };
    const previousState = this.stateStore.get(command.convId);
    const previousSession = this.runtime.get(command.convId);
    const previousSeen = this.stateStore.remember(command.convId, command.sessionId);
    this.stateStore.set(command.convId, btw);
    this.runtime.delete(command.convId);
    if (!this.stateStore.persistNow()) {
      if (previousState) this.stateStore.set(command.convId, previousState);
      else this.stateStore.delete(command.convId);
      if (previousSession) this.runtime.set(command.convId, previousSession);
      this.stateStore.restoreRemembered(command.convId, previousSeen);
      this.server.sendTo(client, {
        type: "btw_snapshot",
        convId: command.convId,
        btw: previousState ? { ...previousState } : null,
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
      }, this.runtime.requesterList(previousSession, client));
    }
    if (previousSession) this.runtime.clearRequesters(previousSession);
    this.emit(command.convId, { type: "btw_snapshot", convId: command.convId, btw: { ...btw } }, [client]);
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
    const session = this.runtime.get(convId);
    if (session?.running) session.abort.abort("conversation-removed");
    if (session) this.runtime.clearRequesters(session);
    this.runtime.delete(convId);
    // Keep accepted-session receipts across recoverable trash/undo. They prevent
    // a disconnected client from resurrecting deleted work if this ID is restored.
    if (this.stateStore.delete(convId)) this.stateStore.persistNow();
  }
}
