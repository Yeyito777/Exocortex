import type { BtwQueryCommand } from "../protocol";
import { runAgentLoop } from "../agent";
import { createProviderTurnSession } from "../api";
import { buildConversationApiContext } from "../context-compaction";
import * as convStore from "../conversations";
import type { ApiMessage, Block, Conversation, ProviderId, ToolCallBlock, ToolResultBlock } from "../messages";
import type { ContentBlock as ProviderContentBlock } from "../providers/types";
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
  onBlockStart(type: "text" | "thinking"): void;
  onTextChunk(text: string): void;
  onThinkingChunk(text: string): void;
  onBlocksUpdate(blocks: Block[]): void;
  onToolCall(block: ToolCallBlock): void;
  onToolResult(block: ToolResultBlock): void;
  onHeaders(headers: Headers): void;
}

function streamingBlocks(blocks: ProviderContentBlock[]): Block[] {
  return blocks
    .filter((block): block is Extract<ProviderContentBlock, { type: "text" | "thinking" }> => (
      block.type === "text" || block.type === "thinking"
    ))
    .map(block => ({ type: block.type, text: block.text }));
}

function ensureRoundBlock(blocks: Block[], type: "text" | "thinking"): Extract<Block, { type: "text" | "thinking" }> {
  const last = blocks.at(-1);
  if (last?.type === type) return last;
  const block: Extract<Block, { type: "text" | "thinking" }> = { type, text: "" };
  blocks.push(block);
  return block;
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
): Promise<Block[]> {
  let committedBlocks: Block[] = [];
  let roundBlocks: Block[] = [];
  const turnSession = createProviderTurnSession(prepared.provider);
  const result = await runLoop(prepared.messages, prepared.provider, prepared.model, {
    onBlockStart: (type) => {
      roundBlocks.push({ type, text: "" });
      hooks.onBlockStart(type);
    },
    onTextChunk: (text) => {
      ensureRoundBlock(roundBlocks, "text").text += text;
      hooks.onTextChunk(text);
    },
    onThinkingChunk: (text) => {
      ensureRoundBlock(roundBlocks, "thinking").text += text;
      hooks.onThinkingChunk(text);
    },
    onBlocksUpdate: (blocks) => {
      roundBlocks = streamingBlocks(blocks);
      hooks.onBlocksUpdate([...committedBlocks, ...roundBlocks]);
    },
    onSignature() {},
    onToolCall: (block) => {
      roundBlocks.push(structuredClone(block));
      hooks.onToolCall(block);
    },
    onToolResult: (block) => {
      roundBlocks.push(structuredClone(block));
      hooks.onToolResult(block);
    },
    onTokensUpdate() {},
    onContextUpdate() {},
    onHeaders: hooks.onHeaders,
    onRetry: (attempt, maxAttempts, errorMessage) => {
      roundBlocks = [];
      hooks.onBlocksUpdate([...committedBlocks]);
      hooks.onStatus(`Retrying ${attempt}/${maxAttempts}: ${errorMessage}`);
    },
    onRoundComplete: () => {
      committedBlocks = [...committedBlocks, ...roundBlocks];
      roundBlocks = [];
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
  return result.blocks;
}
