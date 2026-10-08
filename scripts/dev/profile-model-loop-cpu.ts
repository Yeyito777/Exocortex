#!/usr/bin/env bun
/** No network/model calls. Fixed workload for before/after CPU profiles. */
import assert from "node:assert/strict";
import { createOpenAIEventAccumulator } from "../../daemon/src/providers/openai/stream";
import { OpenAITurnSession } from "../../daemon/src/providers/openai/api";
import { runAgentLoop, type AgentCallbacks } from "../../daemon/src/agent";
import type { streamMessage } from "../../daemon/src/api";

const results: Record<string, { medianMs: number; samplesMs: number[] }> = {};
async function measure(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  await fn(); // warm-up
  const samplesMs: number[] = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    await fn();
    samplesMs.push(performance.now() - start);
  }
  results[name] = { medianMs: [...samplesMs].sort((a, b) => a - b)[3]!, samplesMs };
}
const delta = "some streamed text ";
await measure("stream_text_20000_deltas", () => {
  let chars = 0;
  const accumulator = createOpenAIEventAccumulator({ onText: t => { chars += t.length; }, onThinking() {} });
  accumulator.handle({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "text" } });
  for (let i = 0; i < 20_000; i++) accumulator.handle({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta });
  assert.equal(chars, delta.length * 20_000);
  assert.equal(accumulator.finalize().text.length, chars);
});
await measure("stream_reasoning_20000_deltas", () => {
  let chars = 0;
  const accumulator = createOpenAIEventAccumulator({ onText() {}, onThinking: t => { chars += t.length; } });
  accumulator.handle({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "thinking" } });
  for (let i = 0; i < 20_000; i++) accumulator.handle({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta });
  assert.equal(chars, delta.length * 20_000);
  assert.equal(accumulator.finalize().thinking.length, chars);
});
const base = { model: "test", instructions: "x".repeat(40_000), tools: [{ name: "tool", description: "d".repeat(20_000) }] };
const input = Array.from({ length: 1000 }, (_, i) => ({ type: "message", role: "user", content: [{ type: "input_text", text: `${i}:${"x".repeat(8192)}` }] }));
await measure("incremental_replay_8mb_20_rounds", () => {
  const session = new OpenAITurnSession();
  let body: Record<string, unknown> = { ...base, input };
  for (let i = 0; i < 20; i++) {
    // Production rebuilds wire objects each round; do not benchmark an identity-only cache.
    body = { ...body, input: (body.input as any[]).map(item => ({
      ...item, ...(item.content ? { content: item.content.map((part: any) => ({ ...part })) } : {}),
    })) };
    session.prepareRequestBody(body);
    session.recordSuccessfulRequest(body, {
      text: "", thinking: "", blocks: [], toolCalls: [], stopReason: "stop",
      responseOutputItems: [],
      assistantProviderData: { openai: { responseId: `r${i}` } },
    });
    body = { ...base, input: [...(body.input as unknown[]), { type: "function_call_output", call_id: `c${i}`, output: "ok" }] };
  }
  session.destroy();
});
const callbacks: AgentCallbacks = {
  onBlockStart() {}, onTextChunk() {}, onThinkingChunk() {}, onSignature() {},
  onToolCall() {}, onToolResult() {}, onTokensUpdate() {}, onContextUpdate() {}, onHeaders() {},
};
await measure("agent_loop_100_tool_rounds", async () => {
  let round = 0;
  await runAgentLoop([], "openai", "gpt-6.1-sol", callbacks, {
    presentationResolver: async () => undefined,
    executor: async calls => calls.map(c => ({ toolCallId: c.id, toolName: c.name, output: "ok", isError: false })),
    streamMessageFn: (async () => ({
      text: "", thinking: "", blocks: [], stopReason: "stop", inputTokens: 1000, outputTokens: 100,
      toolCalls: round++ < 100 ? [{ id: `c${round}`, name: "exec_command", input: {} }] : [],
    })) as typeof streamMessage,
  });
});
console.log(JSON.stringify(results, null, 2));
