/**
 * Context tool — lets the AI inspect and manage its own conversation context.
 *
 * Actions:
 *   list            — show all turns with token estimates
 *   delete          — remove a contiguous range of turns
 *   summarize       — replace a range with an LLM-generated summary
 *   strip_thinking  — remove thinking blocks from old assistant turns
 *
 * Unlike stateless tools, this one needs access to the live conversation.
 * The static tool definition (schema, display, summarize) is registered
 * normally in the TOOLS array; execution is routed through executeContext()
 * by the executor with injected conversation context.
 */

import type { Tool, ToolResult } from "./types";
import type { Conversation, StoredMessage, ApiContentBlock, ApiMessage } from "../messages";
import { complete } from "../llm";
import { log } from "../log";

// ── Constants ─────────────────────────────────────────────────────

const CONTEXT_LIMIT = 200_000;

// ── Context tool environment ──────────────────────────────────────

/** Context passed to the context tool's execute function. */
export interface ContextToolEnv {
  /** The conversation being operated on. */
  conv: Conversation;
  /** Called after delete/summarize/strip_thinking modifies conv.messages. */
  onContextModified: () => void;
  /** Tool summarizer for labeling tool_use blocks in the listing. */
  summarizer: (name: string, input: Record<string, unknown>) => string;
  /** Number of messages in conv.messages that are off-limits (current turn).
   *  The modifiable range is turnMap[0] through
   *  turnMap[turnMap.length - 1 - protectedTailCount]. */
  protectedTailCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Build turn index → conv.messages index mapping, skipping system messages. */
function buildTurnMap(messages: StoredMessage[]): number[] {
  const map: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") map.push(i);
  }
  return map;
}

/** Character count for a single content block. */
function blockChars(block: ApiContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length + block.signature.length;
    case "tool_use":
      return JSON.stringify(block.input).length + block.name.length;
    case "tool_result":
      return typeof block.content === "string"
        ? block.content.length
        : JSON.stringify(block.content).length;
    case "image":
      return block.source.data.length;
    default:
      return 0;
  }
}

/** Character count for a message's content. */
function messageChars(msg: StoredMessage): number {
  if (typeof msg.content === "string") return msg.content.length;
  let total = 0;
  for (const b of msg.content) total += blockChars(b);
  return total;
}

/** Format a number with thousand separators. */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Sanitize a string for single-line table display: collapse whitespace, truncate. */
function oneLine(s: string, maxLen = 60): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "…";
}

/** Classify a non-system turn as "user", "assistant", or "tool_result". */
function turnType(msg: StoredMessage): "user" | "assistant" | "tool_result" {
  if (msg.role === "assistant") return "assistant";
  // A user message whose content is an array of all tool_result blocks
  if (Array.isArray(msg.content)) {
    const allToolResult = msg.content.length > 0 &&
      msg.content.every((b: ApiContentBlock) => b.type === "tool_result");
    if (allToolResult) return "tool_result";
  }
  return "user";
}

/** Check whether an assistant message has thinking blocks. */
function hasThinking(msg: StoredMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: ApiContentBlock) => b.type === "thinking");
}

// ── Validation helpers ────────────────────────────────────────────

function validateRange(
  input: Record<string, unknown>,
  turnMap: number[],
  protectedTailCount: number,
): { start: number; end: number; error?: string } {
  const start = input.start as number | undefined;
  const end = input.end as number | undefined;

  if (start == null || end == null) {
    return { start: 0, end: 0, error: "Both 'start' and 'end' turn indices are required." };
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { start: 0, end: 0, error: "'start' and 'end' must be integers." };
  }
  if (start < 0 || start >= turnMap.length) {
    return { start: 0, end: 0, error: `'start' index ${start} is out of range (valid: 0–${turnMap.length - 1}).` };
  }
  if (end < 0 || end >= turnMap.length) {
    return { start: 0, end: 0, error: `'end' index ${end} is out of range (valid: 0–${turnMap.length - 1}).` };
  }
  if (start > end) {
    return { start: 0, end: 0, error: `'start' (${start}) must be <= 'end' (${end}).` };
  }

  const maxModifiable = turnMap.length - 1 - protectedTailCount;
  if (maxModifiable < 0) {
    return { start: 0, end: 0, error: "No modifiable turns available." };
  }
  if (start > maxModifiable || end > maxModifiable) {
    return {
      start, end,
      error: `Turns ${maxModifiable + 1}–${turnMap.length - 1} are protected (current turn). Modifiable range: 0–${maxModifiable}.`,
    };
  }

  return { start, end };
}

/**
 * Validate that a message array maintains correct tool_use/tool_result
 * pairing after a proposed modification. The Anthropic API auto-merges
 * consecutive same-role messages, so alternation is NOT checked.
 */
function validateConversationIntegrity(
  messages: StoredMessage[],
): { valid: boolean; error?: string } {
  const nonSystem = messages.filter(m => m.role !== "system");

  if (nonSystem.length === 0) return { valid: true };

  // Check tool_use/tool_result pairing
  for (let i = 0; i < nonSystem.length; i++) {
    const msg = nonSystem[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const toolUseIds = msg.content
      .filter((b: ApiContentBlock) => b.type === "tool_use")
      .map((b: ApiContentBlock) => (b as { type: "tool_use"; id: string }).id);

    if (toolUseIds.length === 0) continue;

    // Find the next user message with tool_results
    const next = nonSystem[i + 1];
    if (!next || next.role !== "user" || !Array.isArray(next.content)) {
      return {
        valid: false,
        error: `Assistant at position ${i} has tool_use blocks but no following tool_result message.`,
      };
    }

    const toolResultIds = new Set(
      next.content
        .filter((b: ApiContentBlock) => b.type === "tool_result")
        .map((b: ApiContentBlock) => (b as { type: "tool_result"; tool_use_id: string }).tool_use_id),
    );

    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) {
        return {
          valid: false,
          error: `tool_use id '${id}' in assistant at position ${i} has no matching tool_result.`,
        };
      }
    }
  }

  // Check orphaned tool_results
  for (let i = 0; i < nonSystem.length; i++) {
    const msg = nonSystem[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    const toolResultIds = msg.content
      .filter((b: ApiContentBlock) => b.type === "tool_result")
      .map((b: ApiContentBlock) => (b as { type: "tool_result"; tool_use_id: string }).tool_use_id);

    if (toolResultIds.length === 0) continue;

    // Previous message must be assistant with matching tool_use
    const prev = nonSystem[i - 1];
    if (!prev || prev.role !== "assistant" || !Array.isArray(prev.content)) {
      return {
        valid: false,
        error: `tool_result at position ${i} has no preceding assistant with tool_use blocks.`,
      };
    }

    const toolUseIds = new Set(
      prev.content
        .filter((b: ApiContentBlock) => b.type === "tool_use")
        .map((b: ApiContentBlock) => (b as { type: "tool_use"; id: string }).id),
    );

    for (const id of toolResultIds) {
      if (!toolUseIds.has(id)) {
        return {
          valid: false,
          error: `tool_result id '${id}' at position ${i} has no matching tool_use in the preceding assistant message.`,
        };
      }
    }
  }

  return { valid: true };
}

// ── Action: list ──────────────────────────────────────────────────

function actionList(env: ContextToolEnv): ToolResult {
  const { conv, summarizer, protectedTailCount } = env;
  const turnMap = buildTurnMap(conv.messages);

  if (turnMap.length === 0) {
    return { output: "No turns in the conversation (system messages excluded).", isError: false };
  }

  // Compute char counts per turn
  const charCounts: number[] = turnMap.map(i => messageChars(conv.messages[i]));
  const totalChars = charCounts.reduce((a, b) => a + b, 0);
  const lastCtx = conv.lastContextTokens ?? null;

  // Token estimates
  const estTokens: number[] = charCounts.map(ch =>
    lastCtx && totalChars > 0
      ? Math.round((ch / totalChars) * lastCtx)
      : Math.round(ch / 4),
  );
  const totalTokens = lastCtx ?? estTokens.reduce((a, b) => a + b, 0);

  const pct = ((totalTokens / CONTEXT_LIMIT) * 100).toFixed(1);
  const lines: string[] = [];

  const tokenNote = lastCtx ? "" : "  (estimated — no API token count available yet)";
  lines.push(`Context: ${fmt(totalTokens)} tokens / ${fmt(CONTEXT_LIMIT)} limit  (${pct}%)${tokenNote}`);
  lines.push("");

  // Table header
  const idxWidth = Math.max(3, String(turnMap.length - 1).length);
  lines.push(`${"#".padStart(idxWidth)}  Type           Est.Tok  Content`);

  const maxModifiable = turnMap.length - 1 - protectedTailCount;

  for (let t = 0; t < turnMap.length; t++) {
    const msg = conv.messages[turnMap[t]];
    const tt = turnType(msg);
    const tokens = estTokens[t];
    const tokPct = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;

    let content = "";
    const thinkingMarker = hasThinking(msg) ? "†" : " ";

    if (tt === "assistant" && Array.isArray(msg.content)) {
      // Describe block composition
      const parts: string[] = [];
      let thinkingChars = 0;
      let hasText = false;
      const toolNames: string[] = [];

      for (const b of msg.content as ApiContentBlock[]) {
        if (b.type === "thinking") {
          thinkingChars += b.thinking.length;
        } else if (b.type === "text") {
          if (b.text.length > 0) hasText = true;
        } else if (b.type === "tool_use") {
          toolNames.push(`${b.name}(${oneLine(summarizer(b.name, b.input))})`);
        }
      }

      if (thinkingChars > 0) parts.push(`[thinking ${fmt(thinkingChars)}ch]`);
      if (hasText) parts.push("text");
      parts.push(...toolNames);
      content = parts.join(" + ");
    } else if (tt === "tool_result" && Array.isArray(msg.content)) {
      // Resolve labels from preceding assistant
      const prevTurnIdx = t - 1;
      const prevMsg = prevTurnIdx >= 0 ? conv.messages[turnMap[prevTurnIdx]] : null;
      const toolUseMap = new Map<string, { name: string; input: Record<string, unknown> }>();
      if (prevMsg && Array.isArray(prevMsg.content)) {
        for (const b of prevMsg.content as ApiContentBlock[]) {
          if (b.type === "tool_use") {
            toolUseMap.set(b.id, { name: b.name, input: b.input });
          }
        }
      }

      const labels: string[] = [];
      for (const b of msg.content as ApiContentBlock[]) {
        if (b.type === "tool_result") {
          const tu = toolUseMap.get(b.tool_use_id);
          const name = tu ? oneLine(summarizer(tu.name, tu.input)) : "?";
          const ch = typeof b.content === "string" ? b.content.length : JSON.stringify(b.content).length;
          labels.push(`${name}→${fmt(ch)}ch`);
        }
      }
      content = labels.join(", ");
    } else {
      // User turn — preview text
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content as ApiContentBlock[])
            .filter((b: ApiContentBlock) => b.type === "text")
            .map((b: ApiContentBlock) => (b as { type: "text"; text: string }).text)
            .join(" ");
      const preview = text.slice(0, 60).replace(/\n/g, "\\n");
      content = `"${preview}${text.length > 60 ? "…" : ""}"`;
    }

    // Big-turn marker
    const bigMarker = tokPct >= 5 ? `  ◀ ${tokPct.toFixed(1)}%` : "";

    const typeLabel = `${thinkingMarker}${tt}`;
    lines.push(
      `${String(t).padStart(idxWidth)}  ${typeLabel.padEnd(14)} ${fmt(tokens).padStart(7)}  ${content}${bigMarker}`,
    );
  }

  // Top 5 by size
  lines.push("");
  lines.push("Top 5 by size:");
  const sorted = estTokens
    .map((tok, i) => ({ tok, i }))
    .sort((a, b) => b.tok - a.tok)
    .slice(0, 5);
  for (const { tok, i } of sorted) {
    const pctI = totalTokens > 0 ? ((tok / totalTokens) * 100).toFixed(1) : "0.0";
    const tt = turnType(conv.messages[turnMap[i]]);
    lines.push(`  #${i} ${tt}  ${fmt(tok)} tok (${pctI}%)`);
  }

  // Breakdown by type
  const byType: Record<string, number> = { user: 0, assistant: 0, tool_result: 0 };
  for (let t = 0; t < turnMap.length; t++) {
    const tt = turnType(conv.messages[turnMap[t]]);
    byType[tt] += estTokens[t];
  }
  const breakdown = Object.entries(byType)
    .map(([k, v]) => `${k} ${totalTokens > 0 ? ((v / totalTokens) * 100).toFixed(1) : "0.0"}%`)
    .join(" | ");
  lines.push("");
  lines.push(`Breakdown: ${breakdown}`);

  if (maxModifiable >= 0) {
    lines.push(`Modifiable turns: 0–${maxModifiable}  |  Protected (current turn): ${maxModifiable + 1}–${turnMap.length - 1}`);
  } else {
    lines.push("No modifiable turns (all are protected).");
  }

  return { output: lines.join("\n"), isError: false };
}

// ── Action: delete ────────────────────────────────────────────────

function actionDelete(
  input: Record<string, unknown>,
  env: ContextToolEnv,
): ToolResult {
  const { conv, onContextModified, protectedTailCount } = env;
  const turnMap = buildTurnMap(conv.messages);

  const { start, end, error } = validateRange(input, turnMap, protectedTailCount);
  if (error) return { output: error, isError: true };

  // Compute savings estimate before deleting
  let removedChars = 0;
  for (let t = start; t <= end; t++) {
    removedChars += messageChars(conv.messages[turnMap[t]]);
  }
  const totalChars = turnMap.reduce((sum, i) => sum + messageChars(conv.messages[i]), 0);
  const lastCtx = conv.lastContextTokens ?? null;
  const removedTokens = lastCtx && totalChars > 0
    ? Math.round((removedChars / totalChars) * lastCtx)
    : Math.round(removedChars / 4);

  // Simulate the deletion
  const indicesToRemove = new Set<number>();
  for (let t = start; t <= end; t++) indicesToRemove.add(turnMap[t]);

  const simulated = conv.messages.filter((_, i) => !indicesToRemove.has(i));
  const integrity = validateConversationIntegrity(simulated);
  if (!integrity.valid) {
    // Try to give a helpful suggestion
    let suggestion = "";
    // Check if adjacent turns are needed
    if (end + 1 < turnMap.length) {
      const nextMsg = conv.messages[turnMap[end + 1]];
      if (turnType(nextMsg) === "tool_result") {
        suggestion = ` Turn ${end + 1} is a tool_result — you may need to include it in the range.`;
      }
    }
    if (start > 0) {
      const prevMsg = conv.messages[turnMap[start - 1]];
      if (turnType(prevMsg) === "assistant" && hasToolUse(prevMsg)) {
        suggestion = ` Turn ${start - 1} is an assistant with tool_use blocks — include it or start after the tool_result.`;
      }
    }
    return {
      output: `Deletion would break conversation integrity: ${integrity.error}${suggestion}`,
      isError: true,
    };
  }

  // Perform the deletion — splice from highest index to lowest
  const sortedIndices = Array.from(indicesToRemove).sort((a, b) => b - a);
  for (const idx of sortedIndices) {
    conv.messages.splice(idx, 1);
  }

  onContextModified();

  const count = end - start + 1;
  return {
    output: `Deleted turns ${start}–${end} (${count} turn${count !== 1 ? "s" : ""}). Estimated savings: ~${fmt(removedTokens)} tokens.`,
    isError: false,
  };
}

/** Check if an assistant message contains tool_use blocks. */
function hasToolUse(msg: StoredMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: ApiContentBlock) => b.type === "tool_use");
}

// ── Action: summarize ─────────────────────────────────────────────

async function actionSummarize(
  input: Record<string, unknown>,
  env: ContextToolEnv,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { conv, onContextModified, summarizer, protectedTailCount } = env;
  const turnMap = buildTurnMap(conv.messages);

  const { start, end, error } = validateRange(input, turnMap, protectedTailCount);
  if (error) return { output: error, isError: true };

  // Compute original size
  let originalChars = 0;
  for (let t = start; t <= end; t++) {
    originalChars += messageChars(conv.messages[turnMap[t]]);
  }
  const totalChars = turnMap.reduce((sum, i) => sum + messageChars(conv.messages[i]), 0);
  const lastCtx = conv.lastContextTokens ?? null;
  const originalTokens = lastCtx && totalChars > 0
    ? Math.round((originalChars / totalChars) * lastCtx)
    : Math.round(originalChars / 4);

  // Extract content for summarization
  const textParts: string[] = [];
  for (let t = start; t <= end; t++) {
    const msg = conv.messages[turnMap[t]];
    const tt = turnType(msg);

    if (tt === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content as ApiContentBlock[])
            .filter((b: ApiContentBlock) => b.type === "text")
            .map((b: ApiContentBlock) => (b as { type: "text"; text: string }).text)
            .join("\n");
      textParts.push(`User: ${text}`);
    } else if (tt === "assistant" && Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const b of msg.content as ApiContentBlock[]) {
        if (b.type === "thinking") {
          parts.push(b.thinking);
        } else if (b.type === "text") {
          parts.push(b.text);
        } else if (b.type === "tool_use") {
          parts.push(`Tool call: ${b.name}(${summarizer(b.name, b.input)})`);
        }
      }
      textParts.push(`Assistant: ${parts.join("\n")}`);
    } else if (tt === "tool_result" && Array.isArray(msg.content)) {
      // Resolve tool names from preceding assistant
      const prevTurnIdx = t - 1;
      const prevMsg = prevTurnIdx >= 0 ? conv.messages[turnMap[prevTurnIdx]] : null;
      const toolUseMap = new Map<string, string>();
      if (prevMsg && Array.isArray(prevMsg.content)) {
        for (const b of prevMsg.content as ApiContentBlock[]) {
          if (b.type === "tool_use") {
            toolUseMap.set(b.id, b.name);
          }
        }
      }

      const results: string[] = [];
      for (const b of msg.content as ApiContentBlock[]) {
        if (b.type === "tool_result") {
          const name = toolUseMap.get(b.tool_use_id) ?? "unknown";
          const output = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          results.push(`${name}: ${output}`);
        }
      }
      textParts.push(`Tool results: ${results.join("\n")}`);
    }
  }

  const extractedText = textParts.join("\n\n");

  // LLM call
  let systemPrompt = `You are a conversation summarizer. You receive a portion of a conversation
between a user and an AI assistant (including tool calls and results).
Produce a concise summary that preserves:
- Key decisions and conclusions
- Important code snippets, file paths, and commands
- What tools were used and their significant outputs
- Any errors encountered and how they were resolved
Omit redundant tool outputs (e.g., full file contents that were only read for reference).
Output plain text, not markdown.`;

  const customPrompt = input.prompt as string | undefined;
  if (customPrompt) {
    systemPrompt += `\n\nAdditional instructions: ${customPrompt}`;
  }

  let summaryText: string;
  try {
    const result = await complete(systemPrompt, extractedText, {
      model: "sonnet",
      maxTokens: 4096,
      signal,
    });
    summaryText = result.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `context: summarize LLM call failed: ${msg}`);
    return { output: `Summarization failed: ${msg}`, isError: true };
  }

  // Replace the range with a user+assistant summary pair.
  // The Anthropic API auto-merges consecutive same-role messages,
  // so we don't need to worry about alternation.
  const insertIdx = turnMap[start];
  const afterStart = turnMap[end] + 1;

  const replacement: StoredMessage[] = [
    { role: "user" as const, content: `[Summary of turns ${start}–${end}]`, metadata: null },
    { role: "assistant" as const, content: summaryText, metadata: null },
  ];

  // Validate tool_use/tool_result pairing after replacement
  const simulated = [
    ...conv.messages.slice(0, insertIdx),
    ...replacement,
    ...conv.messages.slice(afterStart),
  ];

  const integrity = validateConversationIntegrity(simulated);
  if (!integrity.valid) {
    return {
      output: `Summarization would break conversation integrity: ${integrity.error}`,
      isError: true,
    };
  }

  // Perform the replacement
  const removeCount = afterStart - insertIdx;
  conv.messages.splice(insertIdx, removeCount, ...replacement);

  onContextModified();

  const summaryTokens = Math.round(summaryText.length / 4);
  return {
    output: `Summarized turns ${start}–${end} into 2 turns. Original: ~${fmt(originalTokens)} tokens → Summary: ~${fmt(summaryTokens)} tokens.`,
    isError: false,
  };
}

// ── Action: strip_thinking ────────────────────────────────────────

function actionStripThinking(
  input: Record<string, unknown>,
  env: ContextToolEnv,
): ToolResult {
  const { conv, onContextModified, protectedTailCount } = env;
  const turnMap = buildTurnMap(conv.messages);

  const { start, end, error } = validateRange(input, turnMap, protectedTailCount);
  if (error) return { output: error, isError: true };

  let strippedCount = 0;
  let removedChars = 0;
  const skipped: string[] = [];

  for (let t = start; t <= end; t++) {
    const msg = conv.messages[turnMap[t]];
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const blocks = msg.content as ApiContentBlock[];
    const thinkingBlocks = blocks.filter(b => b.type === "thinking");
    if (thinkingBlocks.length === 0) continue;

    // Count chars being removed
    for (const b of thinkingBlocks) {
      if (b.type === "thinking") {
        removedChars += b.thinking.length + b.signature.length;
      }
    }

    const filtered = blocks.filter(b => b.type !== "thinking");
    if (filtered.length === 0) {
      // Only thinking, nothing else — skip
      skipped.push(`Skipped turn ${t} (only contained thinking, no text/tool_use to preserve).`);
      continue;
    }

    msg.content = filtered;
    strippedCount++;
  }

  if (strippedCount === 0 && skipped.length > 0) {
    return {
      output: `No thinking blocks could be stripped. ${skipped.join(" ")} Consider using 'delete' instead.`,
      isError: true,
    };
  }

  if (strippedCount === 0) {
    return { output: "No assistant turns with thinking blocks found in the specified range.", isError: false };
  }

  onContextModified();

  const totalChars = turnMap.reduce((sum, i) => sum + messageChars(conv.messages[i]), 0) + removedChars;
  const lastCtx = conv.lastContextTokens ?? null;
  const removedTokens = lastCtx && totalChars > 0
    ? Math.round((removedChars / totalChars) * lastCtx)
    : Math.round(removedChars / 4);

  const parts = [
    `Stripped thinking from ${strippedCount} assistant turn${strippedCount !== 1 ? "s" : ""}. Removed ~${fmt(removedChars)} chars (~${fmt(removedTokens)} estimated tokens).`,
  ];
  if (skipped.length > 0) {
    parts.push(...skipped);
  }

  return { output: parts.join("\n"), isError: false };
}

// ── Public API ────────────────────────────────────────────────────

/** Execute the context tool with conversation access. */
export async function executeContext(
  input: Record<string, unknown>,
  env: ContextToolEnv,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const action = input.action as string | undefined;

  switch (action) {
    case "list":
      return actionList(env);
    case "delete":
      return actionDelete(input, env);
    case "summarize":
      return actionSummarize(input, env, signal);
    case "strip_thinking":
      return actionStripThinking(input, env);
    default:
      return { output: `Unknown action: '${action}'. Valid actions: list, delete, summarize, strip_thinking.`, isError: true };
  }
}

/** Static tool definition — registered in TOOLS array. execute() is a stub. */
export const context: Tool = {
  name: "context",
  description: "Inspect and manage the conversation context. Actions: 'list' shows all turns with token estimates; 'delete' removes a contiguous range of turns; 'summarize' replaces a range with an LLM-generated summary; 'strip_thinking' removes thinking blocks from old assistant turns to save context.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "delete", "summarize", "strip_thinking"],
        description: "Action to perform on the conversation context.",
      },
      start: {
        type: "number",
        description: "Start turn index (inclusive). Required for delete, summarize, strip_thinking.",
      },
      end: {
        type: "number",
        description: "End turn index (inclusive). Required for delete, summarize, strip_thinking.",
      },
      prompt: {
        type: "string",
        description: "Custom instruction for the summarizer LLM. Only used with action='summarize'.",
      },
    },
    required: ["action"],
  },
  systemHint: "When approaching the context limit, use the context tool to free space: strip_thinking first (cheap, high impact), then summarize or delete old turns.",
  display: {
    label: "Context",
    color: "#e2b35e",  // warm gold
  },
  summarize(input) {
    const action = (input.action as string) ?? "?";
    if (action === "list") return { label: "Context", detail: "list" };
    const start = input.start as number | undefined;
    const end = input.end as number | undefined;
    const range = start != null && end != null ? `${start}–${end}` : "?";
    return { label: "Context", detail: `${action} ${range}` };
  },
  // Stub — never called; executor routes to executeContext()
  async execute() {
    return { output: "Error: context tool requires conversation context", isError: true };
  },
};
