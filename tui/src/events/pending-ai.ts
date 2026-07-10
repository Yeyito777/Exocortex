import { splitPendingAI, type AIMessage } from "../messages";
import type { RenderState } from "../state";
import { clonePendingAI } from "./streaming-snapshot";

export function markPendingAILive(state: RenderState): AIMessage | null {
  if (!state.pendingAI) return null;
  state.pendingAIHydratedFromSnapshot = false;
  state.suppressPendingAIMetadataStartedAt = null;
  return state.pendingAI;
}

export function hydratePendingAIFromSnapshot(
  state: RenderState,
  snapshot: Pick<AIMessage, "blocks" | "metadata">,
  blockOffset = 0,
): void {
  state.pendingAI = clonePendingAI(snapshot);
  state.pendingAIBlockOffset = Math.max(0, blockOffset);
  state.pendingAIHydratedFromSnapshot = true;
  state.suppressPendingAIMetadataStartedAt = null;
}

/** Move the live segment into history and remember it for canonical completion. */
export function commitPendingAISegment(state: RenderState): AIMessage | null {
  if (!state.pendingAI) return null;
  const finalized = splitPendingAI(state.pendingAI);
  if (finalized) state.pendingAIPartialCommittedBlocks.push(...structuredClone(finalized.blocks));
  return finalized;
}

function sameCanonicalBlock(committed: AIMessage["blocks"][number], canonical: AIMessage["blocks"][number]): boolean {
  if (committed.type !== canonical.type) return false;
  if (committed.type === "tool_call" && canonical.type === "tool_call") return committed.toolCallId === canonical.toolCallId;
  if (committed.type === "tool_result" && canonical.type === "tool_result") return committed.toolCallId === canonical.toolCallId;
  return true;
}

/**
 * Remove visual segments split around notices from a canonical completion tail.
 * A notice may land halfway through one text/thinking block, so those segments
 * cannot be represented by the integer canonical block offset alone.
 */
export function subtractPartialCommittedBlocks(
  state: RenderState,
  canonicalBlocks: AIMessage["blocks"],
  committedBlocks: AIMessage["blocks"] = state.pendingAIPartialCommittedBlocks,
): AIMessage["blocks"] {
  const remaining = structuredClone(canonicalBlocks);
  let canonicalIndex = 0;

  for (const block of committedBlocks) {
    const canonical = remaining[canonicalIndex];
    if (!canonical || !sameCanonicalBlock(block, canonical)) return structuredClone(canonicalBlocks);
    if ((block.type === "text" || block.type === "thinking")
        && (canonical.type === "text" || canonical.type === "thinking")) {
      if (!canonical.text.startsWith(block.text)) return structuredClone(canonicalBlocks);
      canonical.text = canonical.text.slice(block.text.length);
      // Consecutive visual segments can belong to the same canonical block.
      if (canonical.text.length === 0) canonicalIndex += 1;
    } else {
      canonicalIndex += 1;
    }
  }

  return remaining.slice(canonicalIndex).filter((block) =>
    (block.type !== "text" && block.type !== "thinking") || block.text.length > 0
  );
}
