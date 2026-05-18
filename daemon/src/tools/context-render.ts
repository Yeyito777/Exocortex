import type { ApiContentBlock, StoredMessage } from "../messages";
import { isModelVisibleSystemNotice, isRealUserMessage, isToolResultMessage } from "../messages";
import { safeSlice } from "./util";

export interface ContextListRow {
  idx: number;
  msg: StoredMessage;
  prevMsg: StoredMessage | null;
  tokens: number;
}

export type ContextTurnType = "user" | "assistant" | "tool_result" | "system_hint";

const INPUT_PREVIEW_CHARS = 400;
const OUTPUT_PREVIEW_CHARS = 100;
const MAX_FULL_PREVIEW_ROWS = 40;
const LARGEST_PREVIEW_ROWS = 12;
const RECENT_PREVIEW_ROWS = 12;

/** Format a number with thousand separators. */
export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Classify a non-system turn as "user", "assistant", "tool_result", or
 * "system_hint".
 *
 * Uses `isToolResultMessage()` so mixed messages — tool_result blocks alongside
 * model-visible context-pressure text — are still treated as tool results. That
 * keeps compaction ranges aligned with provider tool_use/tool_result contracts.
 */
export function turnType(msg: StoredMessage): ContextTurnType {
  if (msg.role === "assistant") return "assistant";
  if (isToolResultMessage(msg)) return "tool_result";
  if (isModelVisibleSystemNotice(msg)) return "system_hint";
  if (isRealUserMessage(msg)) return "user";
  return "system_hint";
}

/** Sanitize a string for one-line list display: collapse whitespace, truncate. */
function oneLine(s: string, maxLen = 60): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return safeSlice(clean, maxLen) + "…";
}

function previewValue(value: unknown, maxLen: number): string {
  if (typeof value === "string") return oneLine(value, maxLen);
  try {
    return oneLine(JSON.stringify(value), maxLen);
  } catch {
    return oneLine(String(value), maxLen);
  }
}

function toolUsesFromAssistant(msg: StoredMessage | null): Map<string, { name: string; input: Record<string, unknown> }> {
  const map = new Map<string, { name: string; input: Record<string, unknown> }>();
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return map;
  for (const block of msg.content as ApiContentBlock[]) {
    if (block.type === "tool_use") map.set(block.id, { name: block.name, input: block.input });
  }
  return map;
}

function hasVisibleThinking(msg: StoredMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: ApiContentBlock) => b.type === "thinking");
}

function semanticTurnType(msg: StoredMessage, prevMsg: StoredMessage | null): string {
  const tt = turnType(msg);
  if (tt === "assistant" && Array.isArray(msg.content)) {
    const labels: string[] = [];
    if (hasVisibleThinking(msg)) labels.push("think");
    let hasText = false;
    for (const block of msg.content as ApiContentBlock[]) {
      if (block.type === "text" && block.text.trim().length > 0) hasText = true;
      if (block.type === "tool_use") labels.push(block.name);
    }
    if (hasText) labels.unshift("text");
    return labels.length > 0 ? `assistant:${labels.join("+")}` : "assistant";
  }
  if (tt === "tool_result" && Array.isArray(msg.content)) {
    const toolUses = toolUsesFromAssistant(prevMsg);
    const names: string[] = [];
    for (const block of msg.content as ApiContentBlock[]) {
      if (block.type !== "tool_result") continue;
      const name = toolUses.get(block.tool_use_id)?.name ?? "?";
      if (!names.includes(name)) names.push(name);
    }
    return names.length > 0 ? `result:${names.join("+")}` : "result";
  }
  return tt;
}

function previewTextContent(msg: StoredMessage, maxLen: number): string {
  if (typeof msg.content === "string") return previewValue(msg.content, maxLen);
  const parts: string[] = [];
  for (const block of msg.content as ApiContentBlock[]) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "thinking") parts.push(`thinking: ${block.thinking}`);
    else if (block.type === "image") parts.push(`image:${block.source.media_type} ${fmt(block.source.data.length)}ch`);
  }
  return previewValue(parts.join(" | "), maxLen);
}

function previewToolInput(name: string, input: Record<string, unknown>, maxLen: number): string {
  return previewValue(`${name} ${previewValue(input, maxLen)}`, maxLen);
}

function previewToolResultContent(content: unknown, maxLen: number): string {
  const describe = (value: unknown): string => {
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.type === "image" && record.source && typeof record.source === "object") {
        const source = record.source as Record<string, unknown>;
        const mediaType = typeof source.media_type === "string" ? source.media_type : "image";
        const dataLen = typeof source.data === "string" ? source.data.length : 0;
        return `${mediaType} image ${fmt(dataLen)}ch`;
      }
      if (record.type === "text" && typeof record.text === "string") return record.text;
    }
    return previewValue(value, maxLen);
  };

  if (Array.isArray(content)) return previewValue(content.map(describe).join(" | "), maxLen);
  return describe(content);
}

function semanticTurnPreview(msg: StoredMessage, prevMsg: StoredMessage | null): { input: string; output: string } {
  const tt = turnType(msg);
  if (tt === "tool_result" && Array.isArray(msg.content)) {
    const toolUses = toolUsesFromAssistant(prevMsg);
    const inputs: string[] = [];
    const outputs: string[] = [];
    for (const block of msg.content as ApiContentBlock[]) {
      if (block.type !== "tool_result") continue;
      const toolUse = toolUses.get(block.tool_use_id);
      if (toolUse) inputs.push(previewToolInput(toolUse.name, toolUse.input, INPUT_PREVIEW_CHARS));
      else inputs.push(`unknown tool_result id=${block.tool_use_id}`);
      outputs.push(`${toolUse?.name ?? "?"}: ${previewToolResultContent(block.content, OUTPUT_PREVIEW_CHARS)}`);
    }
    return {
      input: previewValue(inputs.join(" | "), INPUT_PREVIEW_CHARS),
      output: previewValue(outputs.join(" | "), OUTPUT_PREVIEW_CHARS),
    };
  }

  if (tt === "assistant" && Array.isArray(msg.content)) {
    const inputs: string[] = [];
    for (const block of msg.content as ApiContentBlock[]) {
      if (block.type === "tool_use") inputs.push(previewToolInput(block.name, block.input, INPUT_PREVIEW_CHARS));
      else if (block.type === "text" && block.text.trim().length > 0) inputs.push(`text: ${block.text}`);
      else if (block.type === "thinking") inputs.push(`thinking: ${block.thinking}`);
    }
    return { input: previewValue(inputs.join(" | "), INPUT_PREVIEW_CHARS), output: "-" };
  }

  return { input: previewTextContent(msg, INPUT_PREVIEW_CHARS), output: "-" };
}

function suggestedOperation(row: ContextListRow): string {
  const tt = turnType(row.msg);
  if (tt === "tool_result") return "strip_results if the output was only for verification/debugging and durable facts are already captured";
  if (tt === "assistant" && hasVisibleThinking(row.msg)) return "strip_thinking for low-risk savings; summarize only if the surrounding work is old and still important";
  if (tt === "system_hint") return "usually leave protected/system hints alone unless summarizing an old completed range";
  return "summarize surrounding completed work if this range is old but contains durable facts; forget only if safe";
}

function semanticTurnCard(row: ContextListRow, totalTokens: number, includePercent = false): string[] {
  const pct = includePercent && totalTokens > 0 ? `  ${((row.tokens / totalTokens) * 100).toFixed(1)}%` : "";
  const preview = semanticTurnPreview(row.msg, row.prevMsg);
  return [
    `#${row.idx} ${semanticTurnType(row.msg, row.prevMsg)}  ${fmt(row.tokens)} tok${pct}`,
    `  in:  ${preview.input || "-"}`,
    `  out: ${preview.output || "-"}`,
    `  suggested: ${suggestedOperation(row)}`,
  ];
}

function compactTurnFlags(msg: StoredMessage): string {
  const flags: string[] = [];
  if (hasVisibleThinking(msg)) flags.push("think");
  if (Array.isArray(msg.content)) {
    if (msg.content.some((b) => b.type === "tool_use")) flags.push("tools");
    if (msg.content.some((b) => b.type === "tool_result")) flags.push("result");
  }
  return flags.length > 0 ? flags.join(",") : "-";
}

function flagsForRows(rows: Array<{ msg: StoredMessage }>): string {
  const flags = new Set<string>();
  for (const row of rows) {
    const rowFlags = compactTurnFlags(row.msg);
    if (rowFlags === "-") continue;
    for (const flag of rowFlags.split(",")) flags.add(flag);
  }
  return flags.size > 0 ? [...flags].sort().join(",") : "-";
}

function bucketedTurnRows(rows: ContextListRow[], desiredMaxBuckets = 80): string[] {
  if (rows.length === 0) return [];
  const bucketSize = Math.max(25, Math.ceil(rows.length / desiredMaxBuckets));
  const lines: string[] = [];
  let groupStart = 0;

  while (groupStart < rows.length) {
    let groupEnd = groupStart;
    while (groupEnd + 1 < rows.length && rows[groupEnd + 1].idx === rows[groupEnd].idx + 1) groupEnd++;

    for (let i = groupStart; i <= groupEnd; i += bucketSize) {
      const bucket = rows.slice(i, Math.min(i + bucketSize, groupEnd + 1));
      const first = bucket[0];
      const last = bucket[bucket.length - 1];
      const tokens = bucket.reduce((sum, row) => sum + row.tokens, 0);
      const range = first.idx === last.idx ? `${first.idx}` : `${first.idx}–${last.idx}`;
      lines.push(`  ${range}: ${fmt(tokens)}tok ${flagsForRows(bucket)}`);
    }

    groupStart = groupEnd + 1;
  }

  return lines;
}

export function renderContextListRowSections(rows: ContextListRow[], totalTokens: number, historyTurnCount: number): string[] {
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push("No modifiable turns.");
    return lines;
  }

  const largest = [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, LARGEST_PREVIEW_ROWS);
  lines.push("", "TOP CANDIDATES");
  for (const row of largest) {
    lines.push(...semanticTurnCard(row, totalTokens, row.idx < historyTurnCount).map((line) => `  ${line}`));
  }

  if (rows.length <= MAX_FULL_PREVIEW_ROWS) {
    lines.push("", "MODIFIABLE TURNS");
    for (const row of rows) {
      lines.push(...semanticTurnCard(row, totalTokens, row.idx < historyTurnCount).map((line) => `  ${line}`));
    }
    return lines;
  }

  lines.push("", "BUCKETS");
  lines.push("  Bounded map; each line is a contiguous range with total tokens and flags.");
  lines.push(...bucketedTurnRows(rows));
  lines.push("", "RECENT TAIL");
  for (const row of rows.slice(-RECENT_PREVIEW_ROWS)) {
    lines.push(...semanticTurnCard(row, totalTokens, row.idx < historyTurnCount).map((line) => `  ${line}`));
  }
  return lines;
}
