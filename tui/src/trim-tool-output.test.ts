import { expect, test } from "bun:test";

import { handleEvent, type DaemonActions } from "./events";
import { createInitialState } from "./state";

const daemon: DaemonActions = {
  subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {},
};

const entries = (output: string) => [
  { type: "user", text: "run it", metadata: null },
  { type: "ai", metadata: null, blocks: [
    { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "cat big.log" }, summary: "cat big.log" },
    { type: "tool_result", toolCallId: "t1", toolName: "bash", output, isError: false },
    { type: "text", text: "done" },
  ] },
];

test("tool output removed by /trim is not restored from the local copy", () => {
  const state = createInitialState();
  state.convId = "c";
  state.showToolOutput = true;
  handleEvent({
    type: "conversation_loaded", convId: "c", reqId: "o", entries: entries("FULL LOG ".repeat(500)),
    historyStartIndex: 0, historyStartUserIndex: 0, historyTotalEntries: 2, hasOlderHistory: false,
    contextTokens: 0, toolOutputsIncluded: true,
  } as never, state, daemon);

  state.requestedToolOutputIds.add("t1");

  // The trim's compact refresh: outputs omitted, window reset (daemon handler trim_conversation).
  handleEvent({
    type: "history_updated", convId: "c", entries: entries(""), historyStartIndex: 0,
    historyStartUserIndex: 0, historyTotalEntries: 2, hasOlderHistory: false, contextTokens: 0,
    toolOutputsIncluded: false, pendingAI: null, resetHistoryWindow: true,
  } as never, state, daemon);

  const block = (state.messages[1] as { blocks: Array<{ output?: string }> }).blocks[1]!;
  expect(block.output).toBe("");
  // The viewport loader may ask again for the daemon's current (placeholder) output.
  expect(state.requestedToolOutputIds.has("t1")).toBe(false);
});
