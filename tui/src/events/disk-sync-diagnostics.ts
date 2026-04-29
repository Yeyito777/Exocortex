import { log } from "../log";
import type { AIMessage, Block, Message } from "../messages";
import type { AIMessagePayload, DisplayEntry } from "../protocol";
import type { RenderState } from "../state";
import { blockStats } from "./streaming-snapshot";

interface DiskSyncSnapshot {
  entries: DisplayEntry[];
  pendingAI?: Pick<AIMessage, "blocks" | "metadata"> | AIMessagePayload | null;
  toolOutputsIncluded: boolean;
}

type VisibleComparableBlock =
  | { type: "text" | "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; summary: string }
  | { type: "tool_result"; toolCallId: string; toolName: string; output: string; isError: boolean };

function assistantBlocksFromMessages(messages: Message[], pendingAI: AIMessage | null): Block[] {
  const blocks: Block[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") blocks.push(...msg.blocks);
  }
  if (pendingAI) blocks.push(...pendingAI.blocks);
  return blocks;
}

function assistantBlocksFromEntries(entries: DisplayEntry[], pendingAI: DiskSyncSnapshot["pendingAI"]): Block[] {
  const blocks: Block[] = [];
  for (const entry of entries) {
    if (entry.type === "ai") blocks.push(...entry.blocks);
  }
  if (pendingAI) blocks.push(...pendingAI.blocks);
  return blocks;
}

function assistantMessageCountFromEntries(entries: DisplayEntry[], pendingAI: DiskSyncSnapshot["pendingAI"]): number {
  return entries.filter((entry) => entry.type === "ai").length + (pendingAI ? 1 : 0);
}

function visibleComparableBlocks(blocks: Block[], showToolOutput: boolean): VisibleComparableBlock[] {
  const visible: VisibleComparableBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
      case "thinking":
        visible.push({ type: block.type, text: block.text });
        break;
      case "tool_call":
        visible.push({
          type: "tool_call",
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          summary: block.summary,
        });
        break;
      case "tool_result":
        // Hidden tool outputs produce no rendered rows, so ignore them when
        // diagnosing what visibly changed. If output is expanded, include the
        // payload because a compact disk sync can visibly collapse/erase it.
        if (showToolOutput) {
          visible.push({
            type: "tool_result",
            toolCallId: block.toolCallId,
            toolName: block.toolName,
            output: block.output,
            isError: block.isError,
          });
        }
        break;
    }
  }
  return visible;
}

function textPreview(text: string, max = 240): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return singleLine.slice(0, max - 1).trimEnd() + "…";
}

function hashString(text: string): string {
  // FNV-1a 32-bit: small deterministic fingerprint for logs without dumping
  // entire assistant/tool payloads.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function summarizeVisibleBlock(block: VisibleComparableBlock | undefined): Record<string, unknown> | null {
  if (!block) return null;
  switch (block.type) {
    case "text":
    case "thinking":
      return {
        type: block.type,
        chars: block.text.length,
        hash: hashString(block.text),
        preview: textPreview(block.text),
      };
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        summaryChars: block.summary.length,
        summaryHash: hashString(block.summary),
        summaryPreview: textPreview(block.summary),
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        outputChars: block.output.length,
        outputHash: hashString(block.output),
        outputPreview: textPreview(block.output),
        isError: block.isError,
      };
  }
}

function visibleBlocksEqual(a: VisibleComparableBlock, b: VisibleComparableBlock): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "text":
    case "thinking":
      return b.type === a.type && a.text === b.text;
    case "tool_call":
      return b.type === "tool_call"
        && a.toolCallId === b.toolCallId
        && a.toolName === b.toolName
        && a.summary === b.summary;
    case "tool_result":
      return b.type === "tool_result"
        && a.toolCallId === b.toolCallId
        && a.toolName === b.toolName
        && a.output === b.output
        && a.isError === b.isError;
  }
}

function firstVisibleDiff(local: VisibleComparableBlock[], disk: VisibleComparableBlock[]): Record<string, unknown> | null {
  const max = Math.max(local.length, disk.length);
  for (let i = 0; i < max; i++) {
    if (local[i] && disk[i] && visibleBlocksEqual(local[i], disk[i])) continue;
    return {
      visibleBlockIndex: i,
      local: summarizeVisibleBlock(local[i]),
      disk: summarizeVisibleBlock(disk[i]),
    };
  }
  return null;
}

/**
 * Build diagnostics for a same-conversation disk/daemon snapshot that would
 * visibly change the assistant content currently shown by the TUI.
 *
 * We intentionally compare the visible assistant block stream (all committed AI
 * entries plus any pending AI) rather than raw message metadata. Compact history
 * loads often omit hidden tool_result output; that is ignored unless the user has
 * tool output expanded, because hidden output does not affect the current display.
 */
export function buildDiskSyncAssistantDiffPayload(
  source: "conversation_loaded" | "history_updated",
  convId: string,
  state: RenderState,
  disk: DiskSyncSnapshot,
): Record<string, unknown> | null {
  if (state.convId !== convId) return null;

  const localBlocks = assistantBlocksFromMessages(state.messages, state.pendingAI);
  const diskBlocks = assistantBlocksFromEntries(disk.entries, disk.pendingAI ?? null);
  const localVisible = visibleComparableBlocks(localBlocks, state.showToolOutput);
  const diskVisible = visibleComparableBlocks(diskBlocks, state.showToolOutput);
  const firstDiff = firstVisibleDiff(localVisible, diskVisible);
  if (!firstDiff) return null;

  const localAssistantMessages = state.messages.filter((msg) => msg.role === "assistant").length + (state.pendingAI ? 1 : 0);
  const diskAssistantMessages = assistantMessageCountFromEntries(disk.entries, disk.pendingAI ?? null);

  return {
    source,
    convId,
    showToolOutput: state.showToolOutput,
    toolOutputsIncluded: disk.toolOutputsIncluded,
    localAssistantMessages,
    diskAssistantMessages,
    localVisibleBlocks: localVisible.length,
    diskVisibleBlocks: diskVisible.length,
    local: blockStats(localBlocks),
    disk: blockStats(diskBlocks),
    firstDiff,
  };
}

export function logDiskSyncAssistantDiff(
  source: "conversation_loaded" | "history_updated",
  convId: string,
  state: RenderState,
  disk: DiskSyncSnapshot,
): void {
  const payload = buildDiskSyncAssistantDiffPayload(source, convId, state, disk);
  if (!payload) return;
  log("warn", `tui: disk sync changed displayed assistant messages ${JSON.stringify(payload)}`);
}
