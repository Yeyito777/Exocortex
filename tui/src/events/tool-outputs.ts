import { preserveViewportAcrossHistoryMutation, toggleToolOutputPreservingViewport } from "../chatscroll";
import type { RenderState } from "../state";

export function applyToolOutputs(state: RenderState, outputs: Array<{ toolCallId: string; output: string }>): void {
  const byId = new Map(outputs.map((item) => [item.toolCallId, item.output]));
  const applyToBlocks = (blocks: Array<{ type: string; toolCallId?: string; output?: string }>) => {
    for (const block of blocks) {
      if (block.type !== "tool_result" || !block.toolCallId) continue;
      const next = byId.get(block.toolCallId);
      if (next !== undefined) block.output = next;
    }
  };

  for (const msg of state.messages) {
    if (msg.role === "assistant") applyToBlocks(msg.blocks as Array<{ type: string; toolCallId?: string; output?: string }>);
  }
  if (state.pendingAI) applyToBlocks(state.pendingAI.blocks as Array<{ type: string; toolCallId?: string; output?: string }>);
}

export function handleToolOutputsLoaded(state: RenderState, outputs: Array<{ toolCallId: string; output: string }>): void {
  const apply = () => applyToolOutputs(state, outputs);
  if (state.showToolOutput) preserveViewportAcrossHistoryMutation(state, apply);
  else apply();
  state.toolOutputsLoaded = true;
  state.toolOutputsLoading = false;
  if (state.showToolOutputAfterLoad && !state.showToolOutput) {
    state.showToolOutputAfterLoad = false;
    toggleToolOutputPreservingViewport(state);
  }
}
