import type { BtwQueryCommand } from "../protocol";
import { runAgentLoop } from "../agent";
import { createProviderTurnSession } from "../api";
import { buildConversationApiContext } from "../context-compaction";
import * as convStore from "../conversations";
import type { ApiMessage, Conversation, ProviderId } from "../messages";
import { getCurrentAccountScope as getCurrentOpenAIAccountScope } from "../providers/openai/auth";
import { buildCodexWindowId } from "../providers/openai/identity";
import { buildSystemPrompt } from "../system";
import { buildExecutor, getToolDefs, summarizeTool } from "../tools/registry";
import type { ToolExecutionContext } from "../tools/types";
import { ensureConversationWorkspace } from "../workspace-service";
import { BTW_READ_ONLY_TOOLS, BTW_WRAPPER_NOTE } from "./constants";

type RunAgentLoop = typeof runAgentLoop;

export class BtwWorkspaceError extends Error {
  constructor(cause: unknown) {
    super(`Could not prepare conversation workspace: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "BtwWorkspaceError";
  }
}

export interface PreparedBtwRun {
  convId: string;
  sessionId: string;
  startedAt: number;
  provider: ProviderId;
  model: Conversation["model"];
  snapshotSize: number;
  messages: ApiMessage[];
  system: string;
  tools: ReturnType<typeof getToolDefs>;
  executor: ReturnType<typeof buildExecutor>;
  effort: Conversation["effort"];
  serviceTier: "fast" | undefined;
  providerSessionKey: string;
  sourceWindowId: string;
  accountScope: string | undefined;
}

export interface BtwRunHooks {
  onStatus(status: string): void;
  onContent(text: string): void;
  onTextChunk(text: string): void;
  onHeaders(headers: Headers): void;
}

function answerText(messages: readonly { type: string; text?: string }[]): string {
  return messages
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("");
}

/** Freeze source replay/settings and build every provider/tool input synchronously. */
export function prepareBtwRun(conv: Conversation, command: BtwQueryCommand, query: string): PreparedBtwRun {
  let workingDirectory: string;
  try {
    workingDirectory = ensureConversationWorkspace(command.convId);
  } catch (error) {
    throw new BtwWorkspaceError(error);
  }

  const provider = conv.provider;
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
  const system = buildSystemPrompt({
    conversationInstructions: convStore.getEffectiveSystemInstructions(command.convId) || undefined,
    conversationId: command.convId,
    workingDirectory,
    toolNames: BTW_READ_ONLY_TOOLS,
    includeExternalToolHints: false,
    wrapperNote: BTW_WRAPPER_NOTE,
  });
  const toolContext: ToolExecutionContext = {
    provider,
    model: conv.model,
    conversationId: command.convId,
    cwd: workingDirectory,
    allowDownloads: false,
  };

  return {
    convId: command.convId,
    sessionId: command.sessionId,
    startedAt: command.startedAt,
    provider,
    model: conv.model,
    snapshotSize: snapshot.length,
    messages,
    system,
    tools: getToolDefs(BTW_READ_ONLY_TOOLS),
    executor: buildExecutor(toolContext, BTW_READ_ONLY_TOOLS),
    effort: conv.effort,
    serviceTier: conv.fastMode ? "fast" : undefined,
    providerSessionKey: `${command.convId}:btw:${command.sessionId}`,
    sourceWindowId,
    accountScope,
  };
}

/** Run the isolated agent and translate low-level loop callbacks into BTW progress. */
export async function runBtw(
  prepared: PreparedBtwRun,
  runLoop: RunAgentLoop,
  signal: AbortSignal,
  hooks: BtwRunHooks,
): Promise<string> {
  let committedText = "";
  let roundText = "";
  const turnSession = createProviderTurnSession(prepared.provider);
  const result = await runLoop(prepared.messages, prepared.provider, prepared.model, {
    onBlockStart: (type) => {
      hooks.onStatus(type === "thinking" ? "Thinking…" : "Answering…");
    },
    onTextChunk: (text) => {
      roundText += text;
      hooks.onTextChunk(text);
    },
    onThinkingChunk() {},
    onBlocksUpdate: (blocks) => {
      roundText = answerText(blocks);
      hooks.onContent(committedText + roundText);
    },
    onSignature() {},
    onToolCall: (block) => {
      const summary = summarizeTool(block.toolName, block.input);
      hooks.onStatus(`Using ${summary.detail || summary.label || block.toolName}…`);
    },
    onToolResult: () => {
      hooks.onStatus("Reviewing results…");
    },
    onTokensUpdate() {},
    onContextUpdate() {},
    onHeaders: hooks.onHeaders,
    onRetry: (attempt, maxAttempts, errorMessage) => {
      roundText = "";
      hooks.onContent(committedText);
      hooks.onStatus(`Retrying ${attempt}/${maxAttempts}: ${errorMessage}`);
    },
    onRoundComplete: () => {
      committedText += roundText;
      roundText = "";
      hooks.onStatus("Thinking…");
    },
  }, {
    system: prepared.system,
    signal,
    executor: prepared.executor,
    summarizer: (name, input) => {
      const summary = summarizeTool(name, input);
      return summary.detail || summary.label;
    },
    tools: prepared.tools,
    effort: prepared.effort,
    serviceTier: prepared.serviceTier,
    promptCacheKey: prepared.providerSessionKey,
    tracking: { source: "btw", conversationId: prepared.convId },
    turnSession: turnSession ?? undefined,
    getCodexWindowId: () => `${prepared.sourceWindowId}:btw:${prepared.sessionId}`,
    accountScope: prepared.accountScope,
    codexTurnId: `${prepared.convId}:btw:${prepared.sessionId}`,
    codexTurnStartedAtMs: prepared.startedAt,
  });
  return answerText(result.blocks);
}
