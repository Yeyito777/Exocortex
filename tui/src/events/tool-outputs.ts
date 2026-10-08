/**
 * Historical tool-result bodies.
 *
 * Compact history carries every tool_result with `output: ""`. Expanding with
 * Ctrl+O must not fetch (and wrap) every body in the materialized window — a
 * long agentic chat holds thousands — so bodies are requested only for results
 * rendered around the viewport and filled in lazily as the viewport moves.
 * Loaded bodies are immutable per toolCallId and survive canonical refreshes via
 * applyPreservedToolResultOutputs, so a body is fetched again only when a Ctrl+O
 * press retries one that is still empty.
 */
import { getViewStart, preserveViewportAcrossHistoryMutation, toggleToolOutputPreservingViewport } from "../chatscroll";
import type { Block } from "../messages";
import type { Event, ToolOutputInfo } from "../protocol";
import type { RenderState } from "../state";
import type { DaemonActions } from "./types";

type ToolResultBlock = Extract<Block, { type: "tool_result" }>;

function forEachToolResult(state: RenderState, visit: (block: ToolResultBlock) => void): void {
  for (const message of state.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) if (block.type === "tool_result") visit(block);
  }
  for (const block of state.pendingAI?.blocks ?? []) if (block.type === "tool_result") visit(block);
}

/**
 * Omitted bodies for tool calls/results in the last rendered frame, within one
 * viewport above and below the visible rows. Works collapsed (rows are tool
 * calls) and expanded (rows include the results themselves). Ids already
 * requested are skipped unless `retry` is set, so empty or failed bodies are not
 * re-fetched on every frame.
 */
export function omittedToolOutputIdsNearViewport(state: RenderState, { retry = false } = {}): string[] {
  const height = state.layout.messageAreaHeight;
  const anchors = state.historyLineAnchors;
  if (height <= 0 || anchors.length === 0) return [];
  const viewStart = getViewStart(state);
  const nearby = new Set<string>();
  for (let row = Math.max(0, viewStart - height); row < Math.min(anchors.length, viewStart + height * 2); row++) {
    if (anchors[row].segment !== "assistant_block") continue;
    const block = anchors[row].owner as Block;
    if (block.type === "tool_call" || block.type === "tool_result") nearby.add(block.toolCallId);
  }
  if (nearby.size === 0) return [];
  const omitted = new Set<string>();
  forEachToolResult(state, (block) => {
    if (block.output !== "" || !nearby.has(block.toolCallId)) return;
    if (retry || !state.requestedToolOutputIds.has(block.toolCallId)) omitted.add(block.toolCallId);
  });
  return [...omitted];
}

/** Issue one fetch. Only the newest request clears the in-flight gate. */
export function requestToolOutputs(state: RenderState, daemon: Pick<DaemonActions, "loadToolOutputs">, toolCallIds: string[]): void {
  if (!state.convId || toolCallIds.length === 0) return;
  for (const id of toolCallIds) state.requestedToolOutputIds.add(id);
  state.toolOutputsLoading = true;
  state.toolOutputsRequestId = daemon.loadToolOutputs(state.convId, toolCallIds) ?? null;
}

/** After each frame: fetch bodies scrolled into (or near) view while expanded. */
export function requestVisibleToolOutputs(state: RenderState, daemon: Pick<DaemonActions, "loadToolOutputs">): void {
  if (!state.showToolOutput || state.toolOutputsLoading || !state.convId) return;
  requestToolOutputs(state, daemon, omittedToolOutputIdsNearViewport(state));
}

export function applyToolOutputs(state: RenderState, outputs: ToolOutputInfo[]): void {
  const byId = new Map(outputs.map((item) => [item.toolCallId, item.output]));
  forEachToolResult(state, (block) => {
    const next = byId.get(block.toolCallId);
    if (next !== undefined) block.output = next;
  });
}

export function handleToolOutputsLoaded(state: RenderState, event: Extract<Event, { type: "tool_outputs_loaded" }>): void {
  const apply = () => applyToolOutputs(state, event.outputs);
  if (state.showToolOutput) preserveViewportAcrossHistoryMutation(state, apply);
  else apply();
  // A superseded response still carries valid bodies; only the newest settles.
  if (event.reqId && state.toolOutputsRequestId && event.reqId !== state.toolOutputsRequestId) return;
  state.toolOutputsLoading = false;
  state.toolOutputsRequestId = null;
  if (state.showToolOutputAfterLoad) {
    state.showToolOutputAfterLoad = false;
    if (!state.showToolOutput) toggleToolOutputPreservingViewport(state);
  }
}

/** Release the in-flight gate when the daemon rejects the current fetch. Returns whether it did. */
export function handleToolOutputsError(state: RenderState, reqId: string | undefined): boolean {
  if (!reqId || reqId !== state.toolOutputsRequestId) return false;
  state.toolOutputsLoading = false;
  state.toolOutputsRequestId = null;
  state.showToolOutputAfterLoad = false;
  return true;
}
