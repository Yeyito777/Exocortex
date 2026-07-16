/**
 * Ephemeral one-shot `/btw` sessions.
 *
 * A session freezes the source conversation's provider replay and settings, then
 * runs a separate agent loop whose only tools are an explicit read-only
 * allowlist. Nothing is appended to or persisted with the source conversation.
 * Sessions belong to a socket client and remain visible after completion until
 * that client explicitly closes them.
 */

import type { BtwQueryCommand } from "./protocol";
import type { DaemonServer, ConnectedClient } from "./server";
import { runAgentLoop } from "./agent";
import { createProviderTurnSession } from "./api";
import { hasConfiguredCredentials } from "./auth";
import { buildConversationApiContext } from "./context-compaction";
import * as convStore from "./conversations";
import { log } from "./log";
import type { ApiMessage } from "./messages";
import { getCurrentAccountScope as getCurrentOpenAIAccountScope } from "./providers/openai/auth";
import { buildCodexWindowId } from "./providers/openai/identity";
import { buildSystemPrompt } from "./system";
import { buildExecutor, getToolDefs, summarizeTool } from "./tools/registry";
import type { ToolExecutionContext } from "./tools/types";

export const BTW_READ_ONLY_TOOLS = ["read", "grep", "glob", "browse"] as const;

const BTW_WRAPPER_NOTE = [
  "# BTW session",
  "You are answering an ephemeral, one-shot question against a frozen snapshot of an existing conversation.",
  "Answer the user's BTW query directly and do not ask follow-up questions.",
  "This answer is displayed in a transient panel and is not part of the source conversation.",
  "You have read-only tools only. Do not attempt or claim to modify files, processes, conversations, schedules, or external state.",
].join("\n");

interface BtwSession {
  id: string;
  provider: import("./messages").ProviderId;
  abort: AbortController;
  running: boolean;
}

export interface BtwSessionCallbacks {
  onHeaders(provider: import("./messages").ProviderId, headers: Headers): void;
  onComplete(provider: import("./messages").ProviderId): void;
  cannotStart?(provider: import("./messages").ProviderId): string | null;
}

export interface BtwSessionDependencies {
  runAgentLoop: typeof runAgentLoop;
  hasConfiguredCredentials: typeof hasConfiguredCredentials;
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

export class BtwSessionManager {
  private readonly sessions = new Map<string, BtwSession>();
  private readonly disconnectHooks = new Set<string>();
  /** Includes abort cleanup after a panel has already been removed/replaced. */
  private readonly inFlightProviders = new Map<import("./messages").ProviderId, number>();
  private readonly dependencies: BtwSessionDependencies;

  constructor(
    private readonly server: DaemonServer,
    private readonly callbacks: BtwSessionCallbacks,
    dependencies: Partial<BtwSessionDependencies> = {},
  ) {
    this.dependencies = {
      runAgentLoop: dependencies.runAgentLoop ?? runAgentLoop,
      hasConfiguredCredentials: dependencies.hasConfiguredCredentials ?? hasConfiguredCredentials,
    };
  }

  hasRunningProvider(provider: import("./messages").ProviderId): boolean {
    return (this.inFlightProviders.get(provider) ?? 0) > 0;
  }

  close(client: ConnectedClient, requestedSessionId?: string, notify = true): boolean {
    const session = this.sessions.get(client.id);
    if (!session || (requestedSessionId && requestedSessionId !== session.id)) return false;
    this.sessions.delete(client.id);
    if (session.running) session.abort.abort("btw-closed");
    if (notify) this.server.sendTo(client, { type: "btw_closed", sessionId: session.id });
    log("info", `btw: closed session ${session.id} for ${client.id}${session.running ? " (interrupted)" : ""}`);
    return true;
  }

  start(client: ConnectedClient, command: BtwQueryCommand): void {
    // A new query always replaces the client's prior panel/session.
    this.close(client, undefined, true);
    this.attachDisconnectHook(client);

    const conv = convStore.get(command.convId);
    const query = command.query.trim();
    const fail = (message: string) => {
      this.server.sendTo(client, {
        type: "btw_error",
        sessionId: command.sessionId,
        message,
        endedAt: Date.now(),
      });
    };

    if (!conv) {
      fail(`Conversation ${command.convId} not found`);
      return;
    }
    if (!query) {
      fail("Usage: /btw <query>");
      return;
    }
    const cannotStart = this.callbacks.cannotStart?.(conv.provider);
    if (cannotStart) {
      fail(cannotStart);
      return;
    }
    if (!this.dependencies.hasConfiguredCredentials(conv.provider)) {
      fail(`Not authenticated for provider ${conv.provider}.`);
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
    const session: BtwSession = { id: command.sessionId, provider, abort, running: true };
    this.sessions.set(client.id, session);
    this.inFlightProviders.set(provider, (this.inFlightProviders.get(provider) ?? 0) + 1);

    this.server.sendTo(client, {
      type: "btw_started",
      sessionId: command.sessionId,
      convId: command.convId,
      query,
      provider,
      model,
      startedAt: command.startedAt,
    });

    const isCurrent = () => this.sessions.get(client.id) === session;
    const sendStatus = (status: string) => {
      if (isCurrent()) this.server.sendTo(client, { type: "btw_status", sessionId: session.id, status });
    };
    const sendContent = (text: string) => {
      if (isCurrent()) this.server.sendTo(client, { type: "btw_content", sessionId: session.id, text });
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
    const manager = this;
    // OpenAI maps promptCacheKey to remote session/thread identity, so every
    // ephemeral copy must have its own key rather than sharing BTW history.
    const providerSessionKey = `${command.convId}:btw:${session.id}`;

    log("info", `btw: starting session ${session.id} for ${client.id} from ${command.convId} (${provider}/${model}, snapshot=${snapshot.length})`);
    sendStatus("Thinking…");

    void this.dependencies.runAgentLoop(messages, provider, model, {
      onBlockStart(type) {
        sendStatus(type === "thinking" ? "Thinking…" : "Answering…");
      },
      onTextChunk(text) {
        roundText += text;
        // Keep token deltas cheap; canonical snapshots reconcile retries and completion.
        if (isCurrent()) manager.server.sendTo(client, { type: "btw_text_chunk", sessionId: session.id, text });
      },
      onThinkingChunk() {},
      onBlocksUpdate(blocks) {
        roundText = answerText(blocks);
        sendContent(committedText + roundText);
      },
      onSignature() {},
      onToolCall(block) {
        const summary = summarizeTool(block.toolName, block.input);
        sendStatus(`Using ${summary.detail || summary.label || block.toolName}…`);
      },
      onToolResult() {
        sendStatus("Reviewing results…");
      },
      onTokensUpdate() {},
      onContextUpdate() {},
      onHeaders: headers => this.callbacks.onHeaders(provider, headers),
      onRetry(attempt, maxAttempts, errorMessage) {
        roundText = "";
        sendContent(committedText);
        sendStatus(`Retrying ${attempt}/${maxAttempts}: ${errorMessage}`);
      },
      onRoundComplete() {
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
      this.server.sendTo(client, { type: "btw_finished", sessionId: session.id, endedAt: Date.now() });
      log("info", `btw: completed session ${session.id} for ${client.id}`);
    }).catch(error => {
      if (!isCurrent() || abortIsSessionClose(error, abort.signal)) return;
      session.running = false;
      const message = error instanceof Error ? error.message : String(error);
      this.server.sendTo(client, { type: "btw_error", sessionId: session.id, message, endedAt: Date.now() });
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

  private attachDisconnectHook(client: ConnectedClient): void {
    if (this.disconnectHooks.has(client.id)) return;
    this.disconnectHooks.add(client.id);
    client.socket.once("close", () => {
      this.disconnectHooks.delete(client.id);
      this.close(client, undefined, false);
    });
  }
}
