import { log } from "../log";
import type { AIMessage, Block } from "../messages";
import type { DisplayEntry } from "../protocol";

function textsCompatible(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function blocksMatch(a: Block, b: Block): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "text":
    case "thinking":
      return b.type === a.type && textsCompatible(a.text, b.text);
    case "tool_call":
      // Compact conversation loads regenerate summaries and may normalize tool
      // inputs, so the stable identity here is the tool call id.
      return b.type === "tool_call" && a.toolCallId === b.toolCallId;
    case "tool_result":
      // Compact conversation loads intentionally omit tool_result payloads, so
      // matching on output would make every reload fail to subtract completed
      // tool rounds and would duplicate them in pendingAI.
      return b.type === "tool_result"
        && a.toolCallId === b.toolCallId
        && a.isError === b.isError;
  }
}

export interface SnapshotAlignment {
  pairs: Array<{ localIndex: number; snapshotIndex: number }>;
  strictlyNewer: boolean;
}

function cloneBlock(block: Block): Block {
  return structuredClone(block);
}

function toolResultOutputsCompatible(local: Extract<Block, { type: "tool_result" }>, snapshot: Extract<Block, { type: "tool_result" }>): boolean {
  return local.output === ""
    || snapshot.output === ""
    || local.output === snapshot.output
    || snapshot.output.startsWith(local.output)
    || local.output.startsWith(snapshot.output);
}

function snapshotBlockCanCoverLocal(local: Block, snapshot: Block): boolean {
  if (local.type !== snapshot.type) return false;
  switch (local.type) {
    case "text":
    case "thinking":
      return snapshot.type === local.type && snapshot.text.startsWith(local.text);
    case "tool_call":
      // Tool-call summaries/inputs may be normalized by the daemon, but the id
      // is stable. A matching daemon tool call is authoritative.
      return snapshot.type === "tool_call" && local.toolCallId === snapshot.toolCallId;
    case "tool_result":
      // Compact daemon snapshots intentionally omit historical tool output. Treat
      // an empty/shorter snapshot output as compatible so a later catch-up snapshot
      // can still repair missed blocks after the tool result; the merge step below
      // preserves the fuller local output instead of clobbering it.
      return snapshot.type === "tool_result"
        && local.toolCallId === snapshot.toolCallId
        && local.isError === snapshot.isError
        && toolResultOutputsCompatible(local, snapshot);
  }
}

function snapshotBlockStrictlyNewer(local: Block, snapshot: Block): boolean {
  if (local.type !== snapshot.type) return false;
  switch (local.type) {
    case "text":
    case "thinking":
      return snapshot.type === local.type && snapshot.text.length > local.text.length;
    case "tool_result":
      return snapshot.type === "tool_result" && snapshot.output.length > local.output.length;
    case "tool_call":
      return false;
  }
}

export function findSnapshotAlignment(localBlocks: Block[], snapshotBlocks: Block[]): SnapshotAlignment | null {
  let snapshotCursor = 0;
  let strictlyNewer = false;
  const pairs: SnapshotAlignment["pairs"] = [];

  for (let localIndex = 0; localIndex < localBlocks.length; localIndex++) {
    const local = localBlocks[localIndex];
    const expectedSnapshotIndex = snapshotCursor;
    let matchedSnapshotIndex = -1;

    for (let i = snapshotCursor; i < snapshotBlocks.length; i++) {
      if (snapshotBlockCanCoverLocal(local, snapshotBlocks[i])) {
        matchedSnapshotIndex = i;
        break;
      }
    }

    if (matchedSnapshotIndex === -1) return null;
    if (matchedSnapshotIndex > expectedSnapshotIndex) strictlyNewer = true;
    if (snapshotBlockStrictlyNewer(local, snapshotBlocks[matchedSnapshotIndex])) strictlyNewer = true;
    pairs.push({ localIndex, snapshotIndex: matchedSnapshotIndex });
    snapshotCursor = matchedSnapshotIndex + 1;
  }

  if (snapshotCursor < snapshotBlocks.length) strictlyNewer = true;
  return { pairs, strictlyNewer };
}

export function mergeSnapshotBlocksPreservingLocalDetails(
  localBlocks: Block[],
  snapshotBlocks: Block[],
  alignment = findSnapshotAlignment(localBlocks, snapshotBlocks),
): Block[] {
  if (!alignment) return snapshotBlocks.map(cloneBlock);

  const localBySnapshotIndex = new Map<number, Block>();
  for (const pair of alignment.pairs) {
    localBySnapshotIndex.set(pair.snapshotIndex, localBlocks[pair.localIndex]);
  }

  return snapshotBlocks.map((snapshot, snapshotIndex) => {
    const local = localBySnapshotIndex.get(snapshotIndex);
    if (local?.type === "tool_result" && snapshot.type === "tool_result") {
      const merged = cloneBlock(snapshot);
      if (merged.type === "tool_result") {
        if (local.output && (!snapshot.output || local.output.length > snapshot.output.length)) {
          merged.output = local.output;
        }
        if (!snapshot.toolName && local.toolName) merged.toolName = local.toolName;
      }
      return merged;
    }
    return cloneBlock(snapshot);
  });
}

function blockSignature(block: Block): string {
  switch (block.type) {
    case "text":
    case "thinking":
      return `${block.type}:${block.text.length}`;
    case "tool_call":
      return `tool_call:${block.toolName}:${block.toolCallId}`;
    case "tool_result":
      return `tool_result:${block.toolName}:${block.toolCallId}:${block.output.length}:${block.isError ? "err" : "ok"}`;
  }
}

export function blockStats(blocks: Block[]): Record<string, unknown> {
  let textChars = 0;
  let thinkingChars = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const block of blocks) {
    if (block.type === "text") textChars += block.text.length;
    else if (block.type === "thinking") thinkingChars += block.text.length;
    else if (block.type === "tool_call") toolCalls += 1;
    else if (block.type === "tool_result") toolResults += 1;
  }
  return {
    blocks: blocks.length,
    textChars,
    thinkingChars,
    toolCalls,
    toolResults,
    signature: blocks.map(blockSignature).join(","),
  };
}

export function logStreamingRepair(
  source: string,
  convId: string | null,
  localBlocks: Block[],
  snapshotBlocks: Block[],
  mergedBlocks: Block[],
  alignment: SnapshotAlignment | null,
  localTokens: number | null | undefined,
  snapshotTokens: number | null | undefined,
  hydratedFromSnapshot: boolean,
  diagnostics: Record<string, unknown> = {},
): void {
  log("warn", `tui: streaming snapshot repaired ${JSON.stringify({
    source,
    convId,
    ...diagnostics,
    hydratedFromSnapshot,
    strictlyNewer: alignment?.strictlyNewer ?? false,
    matchedLocalBlocks: alignment?.pairs.length ?? 0,
    local: blockStats(localBlocks),
    snapshot: blockStats(snapshotBlocks),
    merged: blockStats(mergedBlocks),
    tokens: { local: localTokens ?? null, snapshot: snapshotTokens ?? null },
  })}`);
}

export function subtractLoadedAssistantPrefix(localBlocks: Block[], entries: DisplayEntry[]): Block[] {
  if (localBlocks.length === 0) return [];
  let loadedAiBlocks: Block[] | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "ai") {
      loadedAiBlocks = entry.blocks;
      break;
    }
  }
  if (!loadedAiBlocks || loadedAiBlocks.length === 0) return [...localBlocks];
  if (loadedAiBlocks.length > localBlocks.length) return [...localBlocks];
  for (let i = 0; i < loadedAiBlocks.length; i++) {
    if (!blocksMatch(localBlocks[i], loadedAiBlocks[i])) return [...localBlocks];
  }
  return localBlocks.slice(loadedAiBlocks.length);
}

export function clonePendingAI(msg: Pick<AIMessage, "blocks" | "metadata">): AIMessage {
  return {
    role: "assistant",
    blocks: [...msg.blocks],
    metadata: msg.metadata ? { ...msg.metadata } : null,
  };
}
