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

type DiskSyncSource = "conversation_loaded" | "history_updated";

type VisibleComparableBlock =
  | { type: "text" | "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; summary: string }
  | { type: "tool_result"; toolCallId: string; toolName: string; output: string; isError: boolean };

export interface AssistantDisplaySnapshot {
  assistantMessages: number;
  blocks: Block[];
  /** Blocks that belong specifically to the live, uncommitted assistant tail. */
  pendingBlocks: Block[] | null;
  visibleBlocks: VisibleComparableBlock[];
  showToolOutput: boolean;
  toolOutputsLoaded: boolean;
}

interface PreservedToolResultOutput {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

interface ToolOutputPreserveResult {
  patchedOutputs: number;
  patchedToolNames: number;
}

interface AssistantExtensionPreserveResult {
  preservedBlocks: number;
  beforeBlocks: number;
  afterBlocks: number;
  mergedBlocks: number;
}

function assistantBlocksFromMessages(messages: Message[], pendingAI: AIMessage | null): Block[] {
  const blocks: Block[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") blocks.push(...msg.blocks);
  }
  if (pendingAI) blocks.push(...pendingAI.blocks);
  return blocks;
}

function assistantMessageCountFromMessages(messages: Message[], pendingAI: AIMessage | null): number {
  return messages.filter((msg) => msg.role === "assistant").length + (pendingAI ? 1 : 0);
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

function collectToolOutputsFromBlocks(blocks: Block[], out: Map<string, PreservedToolResultOutput>): void {
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    // Keep both toolName and output. Empty output is tracked too so diagnostics
    // know the id existed locally, but applyPreservedToolResultOutputs only uses
    // non-empty output to fill compact snapshots.
    out.set(block.toolCallId, {
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      output: block.output,
      isError: block.isError,
    });
  }
}

function applyToolOutputsToBlocks(blocks: Block[], preserved: Map<string, PreservedToolResultOutput>): ToolOutputPreserveResult {
  let patchedOutputs = 0;
  let patchedToolNames = 0;
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    const local = preserved.get(block.toolCallId);
    if (!local || local.isError !== block.isError) continue;
    if (local.output && (!block.output || local.output.length > block.output.length)) {
      block.output = local.output;
      patchedOutputs += 1;
    }
    if (!block.toolName && local.toolName) {
      block.toolName = local.toolName;
      patchedToolNames += 1;
    }
  }
  return { patchedOutputs, patchedToolNames };
}

function cloneBlock(block: Block): Block {
  return structuredClone(block);
}

function toolResultOutputsCompatible(local: Extract<Block, { type: "tool_result" }>, applied: Extract<Block, { type: "tool_result" }>): boolean {
  return local.output === ""
    || applied.output === ""
    || local.output === applied.output
    || local.output.startsWith(applied.output)
    || applied.output.startsWith(local.output);
}

function localBlockCanCoverApplied(local: Block, applied: Block): boolean {
  if (local.type !== applied.type) return false;
  switch (local.type) {
    case "text":
    case "thinking":
      return applied.type === local.type && local.text.startsWith(applied.text);
    case "tool_call":
      return applied.type === "tool_call" && local.toolCallId === applied.toolCallId;
    case "tool_result":
      return applied.type === "tool_result"
        && local.toolCallId === applied.toolCallId
        && local.isError === applied.isError
        && toolResultOutputsCompatible(local, applied);
  }
}

function localBlockStrictlyNewerThanApplied(local: Block, applied: Block): boolean {
  if (local.type !== applied.type) return false;
  switch (local.type) {
    case "text":
    case "thinking":
      return applied.type === local.type && local.text.length > applied.text.length;
    case "tool_result":
      // Compact snapshots routinely omit hidden tool output. That is handled by
      // applyPreservedToolResultOutputs when output is expanded/loaded; by
      // itself it must not make a disk snapshot look stale or we would clobber
      // canonical regenerated tool-call summaries/inputs with older local ones.
      return false;
    case "tool_call":
      return false;
  }
}

function mergeLocalAssistantExtension(
  beforeBlocks: Block[],
  afterBlocks: Block[],
): Block[] | null {
  if (beforeBlocks.length === 0 || beforeBlocks.length < afterBlocks.length) return null;

  let strictlyNewer = beforeBlocks.length > afterBlocks.length;
  for (let i = 0; i < afterBlocks.length; i++) {
    const local = beforeBlocks[i];
    const applied = afterBlocks[i];
    if (!localBlockCanCoverApplied(local, applied)) return null;
    if (localBlockStrictlyNewerThanApplied(local, applied)) strictlyNewer = true;
  }
  if (!strictlyNewer) return null;

  const merged = beforeBlocks.map(cloneBlock);
  for (let i = 0; i < afterBlocks.length; i++) {
    const local = merged[i];
    const applied = afterBlocks[i];
    if (local.type !== "tool_result" || applied.type !== "tool_result") continue;
    if (applied.output && (!local.output || applied.output.length > local.output.length)) {
      local.output = applied.output;
    }
    if (!local.toolName && applied.toolName) local.toolName = applied.toolName;
  }
  return merged;
}

export function captureAssistantDisplaySnapshot(state: RenderState): AssistantDisplaySnapshot {
  const blocks = structuredClone(assistantBlocksFromMessages(state.messages, state.pendingAI));
  return {
    assistantMessages: assistantMessageCountFromMessages(state.messages, state.pendingAI),
    blocks,
    pendingBlocks: state.pendingAI ? structuredClone(state.pendingAI.blocks) : null,
    visibleBlocks: visibleComparableBlocks(blocks, state.showToolOutput),
    showToolOutput: state.showToolOutput,
    toolOutputsLoaded: state.toolOutputsLoaded,
  };
}

export function collectDisplayedToolResultOutputs(state: RenderState): Map<string, PreservedToolResultOutput> {
  const preserved = new Map<string, PreservedToolResultOutput>();
  for (const msg of state.messages) {
    if (msg.role === "assistant") collectToolOutputsFromBlocks(msg.blocks, preserved);
  }
  if (state.pendingAI) collectToolOutputsFromBlocks(state.pendingAI.blocks, preserved);
  return preserved;
}

export function applyPreservedToolResultOutputs(
  state: RenderState,
  preserved: Map<string, PreservedToolResultOutput>,
): ToolOutputPreserveResult {
  let patchedOutputs = 0;
  let patchedToolNames = 0;
  for (const msg of state.messages) {
    if (msg.role !== "assistant") continue;
    const result = applyToolOutputsToBlocks(msg.blocks, preserved);
    patchedOutputs += result.patchedOutputs;
    patchedToolNames += result.patchedToolNames;
  }
  if (state.pendingAI) {
    const result = applyToolOutputsToBlocks(state.pendingAI.blocks, preserved);
    patchedOutputs += result.patchedOutputs;
    patchedToolNames += result.patchedToolNames;
  }
  return { patchedOutputs, patchedToolNames };
}

export function preserveLocalAssistantExtensionAfterDiskSync(
  source: DiskSyncSource,
  convId: string,
  before: AssistantDisplaySnapshot | null,
  state: RenderState,
): AssistantExtensionPreserveResult {
  const empty = { preservedBlocks: 0, beforeBlocks: before?.pendingBlocks?.length ?? 0, afterBlocks: 0, mergedBlocks: 0 };
  if (!before || state.convId !== convId) return empty;
  if (!before.pendingBlocks || !state.pendingAI) return empty;

  const afterBlocks = structuredClone(state.pendingAI.blocks);
  const mergedBlocks = mergeLocalAssistantExtension(before.pendingBlocks, afterBlocks);
  if (!mergedBlocks) {
    return {
      preservedBlocks: 0,
      beforeBlocks: before.pendingBlocks.length,
      afterBlocks: afterBlocks.length,
      mergedBlocks: afterBlocks.length,
    };
  }

  state.pendingAI.blocks = mergedBlocks.map(cloneBlock);
  const preservedBlocks = Math.max(0, mergedBlocks.length - afterBlocks.length);
  log("warn", `tui: preserved local pending assistant extension across disk sync ${JSON.stringify({
    source,
    convId,
    preservedBlocks,
    before: blockStats(before.pendingBlocks),
    after: blockStats(afterBlocks),
    merged: blockStats(mergedBlocks),
  })}`);

  return {
    preservedBlocks,
    beforeBlocks: before.pendingBlocks.length,
    afterBlocks: afterBlocks.length,
    mergedBlocks: mergedBlocks.length,
  };
}

export function buildAssistantDisplayDiffPayload(
  source: DiskSyncSource,
  convId: string,
  before: AssistantDisplaySnapshot,
  after: AssistantDisplaySnapshot,
  diagnostics: Record<string, unknown> = {},
): Record<string, unknown> | null {
  const firstDiff = firstVisibleDiff(before.visibleBlocks, after.visibleBlocks);
  if (!firstDiff) return null;

  return {
    source,
    convId,
    ...diagnostics,
    beforeShowToolOutput: before.showToolOutput,
    afterShowToolOutput: after.showToolOutput,
    beforeToolOutputsLoaded: before.toolOutputsLoaded,
    afterToolOutputsLoaded: after.toolOutputsLoaded,
    beforeAssistantMessages: before.assistantMessages,
    afterAssistantMessages: after.assistantMessages,
    beforeVisibleBlocks: before.visibleBlocks.length,
    afterVisibleBlocks: after.visibleBlocks.length,
    before: blockStats(before.blocks),
    after: blockStats(after.blocks),
    firstDiff,
  };
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
  source: DiskSyncSource,
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

  const localAssistantMessages = assistantMessageCountFromMessages(state.messages, state.pendingAI);
  const diskAssistantMessages = assistantMessageCountFromEntries(disk.entries, disk.pendingAI ?? null);

  return {
    source,
    convId,
    showToolOutput: state.showToolOutput,
    toolOutputsLoaded: state.toolOutputsLoaded,
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
  source: DiskSyncSource,
  convId: string,
  state: RenderState,
  disk: DiskSyncSnapshot,
): void {
  const payload = buildDiskSyncAssistantDiffPayload(source, convId, state, disk);
  if (!payload) return;
  log("warn", `tui: disk sync changed displayed assistant messages ${JSON.stringify(payload)}`);
}

export function logDiskSyncAppliedAssistantDiff(
  source: DiskSyncSource,
  convId: string,
  before: AssistantDisplaySnapshot | null,
  state: RenderState,
  diagnostics: Record<string, unknown> = {},
): void {
  if (!before || state.convId !== convId) return;
  const after = captureAssistantDisplaySnapshot(state);
  const payload = buildAssistantDisplayDiffPayload(source, convId, before, after, diagnostics);
  if (!payload) return;
  log("warn", `tui: disk sync changed displayed assistant after apply ${JSON.stringify(payload)}`);
}
