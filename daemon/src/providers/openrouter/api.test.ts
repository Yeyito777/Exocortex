import { afterEach, expect, mock, test } from "bun:test";
import { buildRequestBody } from "./request";
import { streamMessageWithApiKey } from "./api";
import { readOpenAICompatibleEventsForTest } from "../openai-compatible/stream";
import { FALLBACK_OPENROUTER_MODELS } from "./models";
import { buildConversationRequestSurface } from "../../conversation-request-surface";
import type { Conversation } from "../../messages";

const hermes = "nousresearch/hermes-4-405b";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("builds chat-only requests, maps reasoning on/off, and preserves slash IDs", () => {
  const body = buildRequestBody([{ role: "user", content: "Hello" }], hermes, { tools: [{ name: "bash", description: "shell", input_schema: {} }] });
  expect(body.model).toBe(hermes);
  expect(body.reasoning).toEqual({ enabled: true });
  expect(body.provider).toEqual({ require_parameters: true });
  expect(body.tools).toBeUndefined();
  expect(body.tool_choice).toBeUndefined();
  expect(body.parallel_tool_calls).toBeUndefined();
  expect(body.thinking).toBeUndefined();
  expect(buildRequestBody([], hermes, { effort: "none" }).reasoning).toEqual({ enabled: false });
  expect(buildRequestBody([], FALLBACK_OPENROUTER_MODELS[2]!.id, {}).reasoning).toBeUndefined();
  expect(buildRequestBody([], FALLBACK_OPENROUTER_MODELS[2]!.id, { maxTokens: 10200 }).max_tokens).toBe(8192);
  expect(() => buildRequestBody([], "unknown/model", {})).toThrow("unsupported");
});

test("cross-model history retains tool results as inert text, not executable calls", () => {
  const body = buildRequestBody([
    { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning", signature: "" }, { type: "tool_use", id: "call1", name: "bash", input: { command: "pwd" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "/workspace" }] },
  ], hermes, {});
  expect(body.messages.some((message) => message.role === "tool")).toBe(false);
  expect(body.messages.some((message) => "tool_calls" in message)).toBe(false);
  expect(JSON.stringify(body)).toContain("/workspace");
  expect(JSON.stringify(body)).not.toContain("private reasoning");
});

test("chat-only conversation surfaces have no tool definitions or names", () => {
  const surface = buildConversationRequestSurface({ provider: "openrouter", model: hermes } as Conversation, { conversationId: "openrouter-test", workingDirectory: "/tmp" });
  expect(surface.tools).toEqual([]);
  expect(surface.toolNames).toEqual([]);
});

test("reads OpenRouter reasoning, text and cached usage", () => {
  const result = readOpenAICompatibleEventsForTest([
    { choices: [{ delta: { reasoning: "Consider it." } }] },
    { choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 12, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 4 } } },
  ], {}, "OpenRouter");
  expect(result.thinking).toBe("Consider it.");
  expect(result.text).toBe("Answer.");
  expect(result.inputTokens).toBe(12);
  expect(result.cachedInputTokens).toBe(4);
  expect(result.outputTokens).toBe(6);
  expect(() => readOpenAICompatibleEventsForTest([{ error: { message: "Insufficient credits" } }], {}, "OpenRouter")).toThrow("Insufficient credits");
});

test("streams SSE through the OpenRouter transport", async () => {
  globalThis.fetch = mock(async (url: any, init: any) => {
    expect(String(url)).toEndWith("/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(hermes);
    expect(body.tools).toBeUndefined();
    return new Response('data: {"choices":[{"delta":{"reasoning":"Thinking."}}]}\n\ndata: {"choices":[{"delta":{"content":"Hello."},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const result = await streamMessageWithApiKey("test-key", [{ role: "user", content: "Hi" }], hermes, { onText() {}, onThinking() {} });
  expect(result.text).toBe("Hello.");
  expect(result.thinking).toBe("Thinking.");
  expect(result.toolCalls).toEqual([]);
  expect(result.outputTokens).toBe(5);
});

test("rejects unexpected native tool calls from chat-only endpoints", async () => {
  globalThis.fetch = mock(async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')) as unknown as typeof fetch;
  await expect(streamMessageWithApiKey("test", [], hermes, { onText() {}, onThinking() {} })).rejects.toThrow("unsupported tool call");
});

test("reports SSE errors without retrying a billed or partially emitted stream", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls++;
    return new Response('data: {"error":{"code":402,"message":"Insufficient credits"}}\n\n');
  }) as unknown as typeof fetch;
  await expect(streamMessageWithApiKey("test", [], hermes, { onText() {}, onThinking() {} })).rejects.toThrow("Insufficient credits");
  expect(calls).toBe(1);
});
