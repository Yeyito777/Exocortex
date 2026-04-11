import { describe, expect, test } from "bun:test";
import { handleEvent } from "./events";
import { createPendingAI } from "./messages";
import { createInitialState } from "./state";

describe("streaming_sync", () => {
  test("replaces the live text/thinking tail while preserving earlier tool rounds", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.pendingAI = createPendingAI(Date.now(), "gpt-5.4");
    state.pendingAI.blocks.push(
      { type: "text", text: "round one" },
      { type: "tool_call", toolCallId: "call-1", toolName: "read", input: {}, summary: "read file" },
      { type: "tool_result", toolCallId: "call-1", toolName: "read", output: "ok", isError: false },
      { type: "text", text: "First paragraph.\n\n" },
      { type: "thinking", text: "Thinking..." },
      { type: "text", text: "Second paragraph." },
    );

    handleEvent({
      type: "streaming_sync",
      convId: "conv-1",
      blocks: [
        { type: "text", text: "First paragraph.\n\nSecond paragraph." },
        { type: "thinking", text: "Thinking..." },
      ],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.pendingAI?.blocks).toEqual([
      { type: "text", text: "round one" },
      { type: "tool_call", toolCallId: "call-1", toolName: "read", input: {}, summary: "read file" },
      { type: "tool_result", toolCallId: "call-1", toolName: "read", output: "ok", isError: false },
      { type: "text", text: "First paragraph.\n\nSecond paragraph." },
      { type: "thinking", text: "Thinking..." },
    ]);
  });
});
