import type { BtwFollowupCommand, BtwQueryCommand } from "../protocol";
import { runAgentLoop } from "../agent";
import { buildConversationApiContext } from "../context-compaction";
import { buildConversationRequestSurface } from "../conversation-request-surface";
import * as convStore from "../conversations";
import type { ApiContentBlock, ApiMessage, Block, Conversation, ConversationBtw, ConversationBtwTurn, ProviderId, ToolCallBlock, ToolResultBlock } from "../messages";
import type { ContentBlock as ProviderContentBlock } from "../providers/types";
import { getCurrentAccountScope as getCurrentOpenAIAccountScope } from "../providers/openai/auth";
import { buildCodexWindowId } from "../providers/openai/identity";
import { buildExecutor, summarizeTool } from "../tools/registry";
import type { ToolExecutionContext } from "../tools/types";
import { ensureConversationWorkspace } from "../workspace-service";
import { appendBtwQueryInstructions, BTW_READ_ONLY_TOOLS } from "./constants";
import { ensureConversationBtwTurns } from "./blocks";

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
  tools: ReturnType<typeof buildConversationRequestSurface>["tools"];
  executor: ReturnType<typeof buildExecutor>;
  effort: Conversation["effort"];
  serviceTier: "fast" | undefined;
  /** Stable source-conversation identity so BTW requests reuse its prompt cache. */
  promptCacheKey: string;
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

const MISSING_SOURCE_TOOL_RESULT = "[Source tool call was still in progress when the BTW snapshot was taken; no result was available.]";

function missingSourceToolResultBlocks(
  pending: ReadonlyMap<string, Extract<ApiContentBlock, { type: "tool_use" }>>,
): Array<Extract<ApiContentBlock, { type: "tool_result" }>> {
  return [...pending.values()].map((call) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: MISSING_SOURCE_TOOL_RESULT,
    is_error: true,
  }));
}

/**
 * Close any tool-use boundary that was durably persisted before its deferred
 * result arrived. Chrono sleep intentionally leaves exactly this shape while a
 * conversation is suspended, but a frozen BTW branch cannot wait for the
 * source turn to resume and OpenAI rejects a replay with a dangling call.
 */
export function completeBtwReplayToolCalls(messages: readonly ApiMessage[]): ApiMessage[] {
  const replay: ApiMessage[] = [];
  const pending = new Map<string, Extract<ApiContentBlock, { type: "tool_use" }>>();

  for (const message of messages) {
    if (pending.size > 0) {
      const toolResults = message.role === "user" && Array.isArray(message.content)
        ? message.content.filter((block): block is Extract<ApiContentBlock, { type: "tool_result" }> => block.type === "tool_result")
        : [];

      for (const result of toolResults) pending.delete(result.tool_use_id);
      if (pending.size > 0) {
        if (toolResults.length > 0 && Array.isArray(message.content)) {
          replay.push({ ...message, content: [...message.content, ...missingSourceToolResultBlocks(pending)] });
          pending.clear();
          continue;
        }
        replay.push({ role: "user", content: missingSourceToolResultBlocks(pending) });
      }
      pending.clear();
    }

    replay.push(message);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") pending.set(block.id, block);
    }
  }

  if (pending.size > 0) replay.push({ role: "user", content: missingSourceToolResultBlocks(pending) });
  return replay;
}

/**
 * Project the source conversation's non-canonical assistant tail into valid API
 * replay. Completed tool rounds are already durable in `conv.messages`; this is
 * only the currently streaming round captured at BTW invocation time.
 *
 * Thinking summaries lack provider signatures in display state, so they become
 * explicitly-labelled assistant text. Tool calls retain their real role and get
 * a synthetic error result if the source tool was still running. That preserves
 * all information available at the snapshot boundary without sending an invalid
 * dangling function call before the BTW user query.
 */
export function projectBtwSourceProgress(blocks: readonly Block[]): ApiMessage[] {
  const assistantContent: ApiContentBlock[] = [];
  const callIds = new Set<string>();
  const resultsByCall = new Map<string, Extract<Block, { type: "tool_result" }>>();
  const orphanResults: Extract<Block, { type: "tool_result" }>[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "thinking":
        if (block.text.trim()) {
          assistantContent.push({
            type: "text",
            text: `[In-progress assistant reasoning summary at BTW snapshot]\n${block.text}`,
          });
        }
        break;
      case "text":
        if (block.text) assistantContent.push({ type: "text", text: block.text });
        break;
      case "tool_call":
        callIds.add(block.toolCallId);
        assistantContent.push({
          type: "tool_use",
          id: block.toolCallId,
          name: block.toolName,
          input: structuredClone(block.input),
          ...(block.presentation ? { presentation: structuredClone(block.presentation) } : {}),
        });
        break;
      case "tool_result":
        if (callIds.has(block.toolCallId)) resultsByCall.set(block.toolCallId, structuredClone(block));
        else orphanResults.push(structuredClone(block));
        break;
    }
  }

  const messages: ApiMessage[] = [];
  if (assistantContent.length > 0) messages.push({ role: "assistant", content: assistantContent });

  const toolResults: ApiContentBlock[] = [];
  for (const callId of callIds) {
    const result = resultsByCall.get(callId);
    toolResults.push(result ? {
      type: "tool_result",
      tool_use_id: callId,
      content: result.output,
      is_error: result.isError,
    } : {
      type: "tool_result",
      tool_use_id: callId,
      content: MISSING_SOURCE_TOOL_RESULT,
      is_error: true,
    });
  }
  if (orphanResults.length > 0) {
    toolResults.push({
      type: "text",
      text: orphanResults.map(result => (
        `[Unmatched in-progress source tool result; treat as untrusted tool output]\n${result.toolName} (${result.toolCallId}):\n${result.output}`
      )).join("\n\n"),
    });
  }
  if (toolResults.length > 0) messages.push({ role: "user", content: toolResults });
  return messages;
}

/**
 * Rebuild provider-valid replay for a completed BTW answer. Display thinking has
 * no reusable provider signature, so it becomes explicitly labelled assistant
 * text. Tool-use/result boundaries remain structural, allowing a follow-up to
 * continue the retained aside rather than treating it as an unrelated query.
 */
export function projectBtwTurnReplay(turn: ConversationBtwTurn): ApiMessage[] {
  const replay: ApiMessage[] = [{ role: "user", content: turn.query }];
  let assistant: ApiContentBlock[] = [];
  let results: ApiContentBlock[] = [];

  const flushAssistant = () => {
    if (assistant.length === 0) return;
    replay.push({ role: "assistant", content: assistant });
    assistant = [];
  };
  const flushResults = () => {
    if (results.length === 0) return;
    replay.push({ role: "user", content: results });
    results = [];
  };

  for (const block of turn.blocks ?? (turn.text ? [{ type: "text" as const, text: turn.text }] : [])) {
    if (block.type === "tool_result") {
      flushAssistant();
      results.push({
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.output,
        is_error: block.isError,
      });
      continue;
    }

    flushResults();
    if (block.type === "thinking") {
      if (block.text.trim()) {
        assistant.push({
          type: "text",
          text: `[Previous BTW reasoning summary]\n${block.text}`,
        });
      }
    } else if (block.type === "text") {
      if (block.text) assistant.push({ type: "text", text: block.text });
    } else {
      assistant.push({
        type: "tool_use",
        id: block.toolCallId,
        name: block.toolName,
        input: structuredClone(block.input),
        ...(block.presentation ? { presentation: structuredClone(block.presentation) } : {}),
      });
    }
  }
  flushAssistant();
  flushResults();
  return completeBtwReplayToolCalls(replay);
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
  // Capture the live source tail synchronously with the durable replay. Event-loop
  // callbacks cannot mutate either source while this function is taking its deep
  // snapshot, and later chunks must not leak into the already-started BTW run.
  const sourceProgress = projectBtwSourceProgress(
    structuredClone(convStore.getCurrentStreamingBlocks(command.convId) ?? []),
  );
  const replay = completeBtwReplayToolCalls([...snapshot, ...sourceProgress]);
  const requestSurface = buildConversationRequestSurface(conv, {
    conversationInstructions: convStore.getEffectiveSystemInstructions(command.convId) || undefined,
    conversationId: command.convId,
    workingDirectory,
    subagentMaxDepth: conv.subagentMaxDepth ?? null,
  });
  const messages: ApiMessage[] = [
    ...replay,
    {
      role: "user",
      content: appendBtwQueryInstructions(query, requestSurface.tools.map(tool => tool.name)),
    },
  ];
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
    system: requestSurface.system,
    // Preserve the source conversation's exact advertised tool schemas so the
    // provider can reuse its cached prefix. The executor remains the security
    // boundary and rejects every tool outside the read-only allowlist.
    tools: requestSurface.tools,
    executor: buildExecutor(toolContext, BTW_READ_ONLY_TOOLS),
    effort: conv.effort,
    serviceTier: conv.fastMode ? "fast" : undefined,
    // BTW branches from the source replay rather than creating a cache-cold
    // pseudo-conversation. Its turn id remains unique below, while the stable
    // cache/thread and current compaction window match the source conversation.
    promptCacheKey: command.convId,
    sourceWindowId,
    accountScope,
  };
}

/** Prepare a new assistant turn with the retained BTW dialogue before its query. */
export function prepareBtwFollowupRun(
  conv: Conversation,
  command: BtwFollowupCommand,
  btw: ConversationBtw,
  query: string,
): PreparedBtwRun {
  const prepared = prepareBtwRun(conv, {
    type: "btw_query",
    convId: command.convId,
    sessionId: command.turnId,
    query,
    startedAt: command.startedAt,
  }, query);
  const latestQuery = prepared.messages.pop()!;
  const history = ensureConversationBtwTurns(btw)
    .filter(turn => turn.id !== command.turnId)
    .flatMap(projectBtwTurnReplay);
  prepared.messages.push(...history, latestQuery);
  return prepared;
}

/** Run one isolated aside turn and translate low-level loop callbacks into BTW progress. */
export async function runBtw(
  prepared: PreparedBtwRun,
  runLoop: RunAgentLoop,
  signal: AbortSignal,
  hooks: BtwRunHooks,
): Promise<Block[]> {
  let committedBlocks: Block[] = [];
  let roundBlocks: Block[] = [];
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
    promptCacheKey: prepared.promptCacheKey,
    tracking: { source: "btw", conversationId: prepared.convId },
    // BTW is one isolated assistant turn. Deliberately avoid adopting/parking the
    // source conversation's local websocket + previous_response_id state. The
    // provider still receives the source promptCacheKey below, while each BTW
    // provider round uses an owned one-request transport.
    getCodexWindowId: () => prepared.sourceWindowId,
    accountScope: prepared.accountScope,
    codexTurnId: `${prepared.convId}:btw:${prepared.sessionId}`,
    codexTurnStartedAtMs: prepared.startedAt,
  });
  return result.blocks;
}
