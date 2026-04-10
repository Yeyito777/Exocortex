/**
 * Deterministic conversation trimming helpers.
 *
 * These mutate the provided conversation in place but do not handle
 * persistence or updatedAt bookkeeping; conversations.ts owns that layer.
 */

import type { ApiContentBlock, Conversation, StoredMessage } from "./messages";
import { isToolResultMessage } from "./messages";
import type { TrimMode } from "./protocol";

const TRIMMED_TOOL_RESULT_PLACEHOLDER = "[Output removed by /trim]";

export interface TrimConversationResult {
  changed: boolean;
  message: string;
}

function buildHistoryTurnMap(messages: StoredMessage[]): number[] {
  const map: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system" && messages[i].role !== "system_instructions") map.push(i);
  }
  return map;
}

function hasToolUse(message: StoredMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === "tool_use");
}

function hasThinking(message: StoredMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === "thinking");
}

function blockChars(block: ApiContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length + block.signature.length;
    case "tool_use":
      return block.name.length + JSON.stringify(block.input).length;
    case "tool_result":
      return typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
    case "image":
      return block.source.data.length;
    default:
      return 0;
  }
}

function messageChars(message: StoredMessage): number {
  if (typeof message.content === "string") return message.content.length;
  return message.content.reduce((sum, block) => sum + blockChars(block), 0);
}

function approxTokens(lastContextTokens: number | null, removedChars: number, totalCharsBeforeTrim: number): number {
  if (lastContextTokens != null && totalCharsBeforeTrim > 0) {
    return Math.round((removedChars / totalCharsBeforeTrim) * lastContextTokens);
  }
  return Math.round(removedChars / 4);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function totalConversationChars(conv: Conversation): number {
  return conv.messages.reduce((sum, message) => sum + messageChars(message), 0);
}

function summarizeRemoval(
  label: string,
  removedChars: number,
  lastContextTokens: number | null,
  totalCharsBeforeTrim: number,
  extra = "",
): string {
  return `${label}${extra}. Removed ~${fmt(removedChars)} chars (~${fmt(approxTokens(lastContextTokens, removedChars, totalCharsBeforeTrim))} estimated tokens).`;
}

function trimMessagesFromStart(conv: Conversation, count: number): TrimConversationResult {
  const turnMap = buildHistoryTurnMap(conv.messages);
  if (turnMap.length === 0) {
    return { changed: false, message: "No history entries available to trim." };
  }

  const requested = Math.min(count, turnMap.length);
  let endTurn = requested - 1;
  if (endTurn < turnMap.length - 1) {
    const lastTrimmed = conv.messages[turnMap[endTurn]];
    const next = conv.messages[turnMap[endTurn + 1]];
    if (lastTrimmed.role === "assistant" && hasToolUse(lastTrimmed) && isToolResultMessage(next)) {
      endTurn++;
    }
  }

  const deleteStart = turnMap[0]!;
  const deleteEnd = turnMap[endTurn]!;
  const totalCharsBeforeTrim = totalConversationChars(conv);
  const lastContextTokens = conv.lastContextTokens;
  const removedChars = conv.messages
    .slice(deleteStart, deleteEnd + 1)
    .reduce((sum, message) => sum + messageChars(message), 0);
  const removedTurns = endTurn + 1;
  conv.messages.splice(deleteStart, deleteEnd - deleteStart + 1);

  const preservedPairNote = removedTurns !== requested
    ? ` (expanded from ${requested} to ${removedTurns} to preserve a tool_use/tool_result pair)`
    : "";
  return {
    changed: true,
    message: summarizeRemoval(
      `Trimmed ${removedTurns} oldest history entr${removedTurns === 1 ? "y" : "ies"}`,
      removedChars,
      lastContextTokens,
      totalCharsBeforeTrim,
      preservedPairNote,
    ),
  };
}

function trimThinkingFromStart(conv: Conversation, count: number): TrimConversationResult {
  let strippedTurns = 0;
  let removedChars = 0;

  for (const index of buildHistoryTurnMap(conv.messages)) {
    if (strippedTurns >= count) break;
    const message = conv.messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.content) || !hasThinking(message)) continue;

    const nextContent = message.content.filter((block) => block.type !== "thinking");
    if (nextContent.length === 0) continue;

    for (const block of message.content) {
      if (block.type === "thinking") removedChars += block.thinking.length + block.signature.length;
    }
    message.content = nextContent;
    strippedTurns++;
  }

  if (strippedTurns === 0) {
    return { changed: false, message: "No assistant turns with removable thinking found." };
  }

  const totalCharsBeforeTrim = totalConversationChars(conv) + removedChars;
  return {
    changed: true,
    message: summarizeRemoval(
      `Trimmed thinking from ${strippedTurns} assistant turn${strippedTurns === 1 ? "" : "s"}`,
      removedChars,
      conv.lastContextTokens,
      totalCharsBeforeTrim,
    ),
  };
}

function trimToolResultsFromStart(conv: Conversation, count: number): TrimConversationResult {
  let strippedResults = 0;
  let removedChars = 0;

  for (const index of buildHistoryTurnMap(conv.messages)) {
    if (strippedResults >= count) break;
    const message = conv.messages[index];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (strippedResults >= count) break;
      if (block.type !== "tool_result") continue;
      if (block.content === TRIMMED_TOOL_RESULT_PLACEHOLDER) continue;

      const oldLen = typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
      const saved = oldLen - TRIMMED_TOOL_RESULT_PLACEHOLDER.length;
      if (saved <= 0) continue;

      removedChars += saved;
      (block as { content: string }).content = TRIMMED_TOOL_RESULT_PLACEHOLDER;
      strippedResults++;
    }
  }

  if (strippedResults === 0) {
    return { changed: false, message: "No tool results found that can be trimmed." };
  }

  const totalCharsBeforeTrim = totalConversationChars(conv) + removedChars;
  return {
    changed: true,
    message: summarizeRemoval(
      `Trimmed ${strippedResults} tool result${strippedResults === 1 ? "" : "s"}`,
      removedChars,
      conv.lastContextTokens,
      totalCharsBeforeTrim,
    ),
  };
}

export function trimConversationInPlace(conv: Conversation, mode: TrimMode, count: number): TrimConversationResult {
  if (!Number.isSafeInteger(count) || count <= 0) {
    return { changed: false, message: "Trim count must be a positive integer." };
  }

  switch (mode) {
    case "messages":
      return trimMessagesFromStart(conv, count);
    case "thinking":
      return trimThinkingFromStart(conv, count);
    case "toolresult":
      return trimToolResultsFromStart(conv, count);
    default:
      return { changed: false, message: `Unknown trim mode: ${mode}` };
  }
}
