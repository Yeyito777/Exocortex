import { afterEach, describe, expect, mock, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import type { ApiMessage } from "../../messages";
import {
  buildOpenAIInputForTest,
  buildRequestBodyForTest,
  clearOpenAIWebSocketSessionCacheForTest,
  createOpenAITurnSession,
  isRetriableOpenAIStatusForTest,
  mergeReasoningSummariesForTest,
  parseOpenAIUsageLimitErrorForTest,
  readOpenAIEventsForTest,
  setOpenAIWebSocketIdleTimeoutMsForTest,
  shouldRetryOpenAIUsageLimitResetForTest,
  streamMessage,
  streamMessageWithSession,
} from "./api";
import { clearProviderAuth, saveProviderAuth } from "../../store";
import { OPENAI_CODEX_RESPONSES_WS_URL, OPENAI_TOKEN_URL } from "./constants";
import { clearCloudflareCookiesForTest } from "./cookies";
import type { StoredOpenAIAuth } from "./session";
import { OpenAIWebSocketHttpError, setOpenAIWebSocketConnectorForTest, type OpenAIWebSocketConnection } from "./websocket";

const originalFetch = globalThis.fetch;

interface MockWebSocketCall {
  url: string;
  headers: Record<string, string>;
  sent: string[];
  isClosed: () => boolean;
}

function mockOpenAIWebSocket(
  connections: Array<{
    events?: Array<Record<string, unknown>>;
    error?: Error;
    headers?: HeadersInit;
    nextMessage?: (signal?: AbortSignal) => Promise<{ type: "text"; text: string } | { type: "close" }>;
  }>,
): MockWebSocketCall[] {
  const calls: MockWebSocketCall[] = [];
  setOpenAIWebSocketConnectorForTest(mock(async (url, headers, signal) => {
    const config = connections.shift();
    if (!config) throw new Error("unexpected websocket connection");
    let closed = false;
    const call: MockWebSocketCall = { url, headers, sent: [], isClosed: () => closed };
    calls.push(call);
    if (config.error) throw config.error;
    const queued = [...(config.events ?? []).map((event) => ({ type: "text" as const, text: JSON.stringify(event) }))];
    const socket = {
      async sendText(text: string) {
        call.sent.push(text);
      },
      async nextMessage(_timeoutMs: number, nextSignal?: AbortSignal) {
        if (config.nextMessage) return config.nextMessage(nextSignal ?? signal);
        return queued.shift() ?? { type: "close" as const };
      },
      close() { closed = true; },
      destroy() { closed = true; },
      isClosed() { return closed; },
    } as unknown as OpenAIWebSocketConnection;
    return { socket, headers: new Headers(config.headers) };
  }));
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setOpenAIWebSocketConnectorForTest(null);
  clearOpenAIWebSocketSessionCacheForTest();
  setOpenAIWebSocketIdleTimeoutMsForTest(null);
  clearCloudflareCookiesForTest();
  clearProviderAuth("openai");
  writeExocortexConfig(defaultExocortexConfig());
});

describe("OpenAI replay input", () => {
  test("does not reuse response ids as assistant item ids", () => {
    const messages: ApiMessage[] = [
      {
        role: "user",
        content: "first prompt",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        providerData: {
          openai: {
            responseId: "resp_abc123",
            reasoningItems: [],
          },
        },
      },
      {
        role: "user",
        content: "follow-up",
      },
    ];

    const input = buildOpenAIInputForTest(messages) as Array<Record<string, unknown>>;
    const assistantItem = input.find((item) => item.role === "assistant");

    expect(assistantItem).toBeDefined();
    expect(assistantItem?.id).toBeUndefined();
  });

  test("request body omits max_output_tokens on the codex backend", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.4", 1234, {});

    expect(body.max_output_tokens).toBeUndefined();
  });

  test("fast mode maps to the priority service tier", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.4", 1234, { serviceTier: "fast" });

    expect(body.service_tier).toBe("priority");
  });

  test("reasoning summary defaults to detailed for models that support it", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.4", 1234, {});

    expect((body.reasoning as { summary?: string }).summary).toBe("detailed");
  });

  test("omits reasoning summary for gpt-5.3-codex-spark", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.3-codex-spark", 1234, {});

    expect((body.reasoning as { summary?: string }).summary).toBeUndefined();
  });

  test("treats transient HTTP statuses as retriable", () => {
    expect(isRetriableOpenAIStatusForTest(507)).toBe(true);
    expect(isRetriableOpenAIStatusForTest(520)).toBe(true);
    expect(isRetriableOpenAIStatusForTest(524)).toBe(true);
    expect(isRetriableOpenAIStatusForTest(401)).toBe(false);
  });

  test("omits invalid image payloads instead of sending provider-rejected data URLs", () => {
    const validPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const messages: ApiMessage[] = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: validPng } },
        { type: "text", text: "caption" },
      ],
    }];

    const input = buildOpenAIInputForTest(messages) as Array<{
      type: string;
      role?: string;
      content?: Array<{ type: string; text?: string; image_url?: string }>;
    }>;

    expect(input[0].content).toEqual([
      { type: "input_text", text: "[Invalid image/png attachment omitted before sending to OpenAI.]" },
      { type: "input_image", image_url: `data:image/png;base64,${validPng}` },
      { type: "input_text", text: "caption" },
    ]);
  });

  test("parses OpenAI usage-limit 429 reset metadata", () => {
    const parsed = parseOpenAIUsageLimitErrorForTest(JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: "pro",
        resets_at: 1_700_000_060,
        resets_in_seconds: 999,
      },
    }), 1_700_000_000_000);

    expect(parsed).toEqual({
      message: "The usage limit has been reached",
      planType: "pro",
      resetAt: 1_700_000_060_000,
      resetDelayMs: 62_000,
    });
  });

  test("reads usage-limit reset retry toggle from config", () => {
    expect(shouldRetryOpenAIUsageLimitResetForTest()).toBe(false);
    writeExocortexConfig({
      ...defaultExocortexConfig(),
      providers: { openai: { retryOnUsageLimitReset: true } },
    });
    expect(shouldRetryOpenAIUsageLimitResetForTest()).toBe(true);
  });

  test("hard-fails OpenAI usage-limit 429 without transient retries by default", async () => {
    const onRetry = mock(() => {});
    const calls = mockOpenAIWebSocket([{ events: [{
      type: "error",
      status: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: "pro",
        resets_in_seconds: 5456,
      },
    }] }]);

    await expect(streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry,
      },
    )).rejects.toThrow(/usage limit/i);
    expect(onRetry).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  test("retries empty-body OpenAI websocket 403 handshake errors", async () => {
    const retryCalls: unknown[][] = [];
    const onRetry = mock((...args: unknown[]) => { retryCalls.push(args); });
    const calls = mockOpenAIWebSocket([
      { error: new OpenAIWebSocketHttpError(403, new Headers(), "") },
      { events: [
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "ok" }] }] } },
      ] },
    ]);

    const result = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry,
      },
    );

    expect(result.text).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryCalls[0][0]).toBe(1);
    expect(retryCalls[0][1]).toBe(8);
    expect(retryCalls[0][2]).toBe("HTTP 403");
    expect(retryCalls[0][4]).toEqual({ kind: "transient" });
  });

  test("does not retry descriptive OpenAI websocket 403 handshake errors", async () => {
    const onRetry = mock(() => {});
    const calls = mockOpenAIWebSocket([
      { error: new OpenAIWebSocketHttpError(403, new Headers(), "Forbidden by policy") },
    ]);

    await expect(streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry,
      },
    )).rejects.toThrow(/Forbidden by policy/);
    expect(calls).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("retries transient OpenAI session refresh connection errors", async () => {
    const retryCalls: unknown[][] = [];
    const onRetry = mock((...args: unknown[]) => { retryCalls.push(args); });
    const auth: StoredOpenAIAuth = {
      tokens: {
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() - 60_000,
        scopes: [],
        subscriptionType: null,
        rateLimitTier: null,
      },
      profile: null,
      updatedAt: new Date().toISOString(),
      source: "oauth",
      authMode: null,
      accountId: null,
      idToken: null,
    };
    saveProviderAuth("openai", auth);

    let tokenRefreshAttempts = 0;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === OPENAI_TOKEN_URL) {
        tokenRefreshAttempts += 1;
        if (tokenRefreshAttempts === 1) {
          return Promise.reject(new Error("Unable to connect. Is the computer able to access the url?"));
        }
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "",
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }

      return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    }) as unknown as typeof fetch;
    mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "ok" }] }] } },
    ] }]);

    const result = await streamMessage(
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry,
      },
    );

    expect(result.text).toBe("ok");
    expect(tokenRefreshAttempts).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryCalls[0][0]).toBe(1);
    expect(retryCalls[0][1]).toBe(8);
    expect(retryCalls[0][2]).toBe("Unable to connect. Is the computer able to access the url?");
    expect(retryCalls[0][4]).toEqual({ kind: "transient" });
  });

  test("hard-fails context-window stream errors without transient retries", async () => {
    const onRetry = mock(() => {});
    const calls = mockOpenAIWebSocket([{ events: [{
      type: "response.failed",
      response: {
        error: {
          code: "context_length_exceeded",
          message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
        },
      },
    }] }]);

    await expect(streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry,
      },
    )).rejects.toThrow(/exceeds the context window/i);
    expect(onRetry).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  test("aborting an in-flight stream does not emit retry callbacks", async () => {
    const ac = new AbortController();
    const onRetry = mock(() => {});
    mockOpenAIWebSocket([{
      nextMessage: (signal) => new Promise((_, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The message was aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The message was aborted", "AbortError"));
        }, { once: true });
      }),
    }]);

    const promise = streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry,
      },
      { signal: ac.signal },
    );

    ac.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("sends conversation headers alongside prompt_cache_key", async () => {
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
    ] }]);

    await streamMessageWithSession(
      { accessToken: "test-token", accountId: "acct_123" },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
      },
      { promptCacheKey: "conv-1" },
    );

    expect(calls[0].url).toBe(OPENAI_CODEX_RESPONSES_WS_URL);
    const headers = new Headers(calls[0].headers);
    expect(headers.get("session_id")).toBe("conv-1");
    expect(headers.get("session-id")).toBe("conv-1");
    expect(headers.get("thread_id")).toBe("conv-1");
    expect(headers.get("thread-id")).toBe("conv-1");
    expect(headers.get("x-client-request-id")).toBe("conv-1");
    expect(headers.get("x-codex-window-id")).toBe("conv-1:0");
    expect(headers.get("x-codex-installation-id")).toBeTruthy();
    expect(headers.get("ChatGPT-Account-ID")).toBe("acct_123");
    expect(headers.get("User-Agent")).toStartWith("codex_cli_rs/");
    expect(headers.get("OpenAI-Beta")).toBe("responses_websockets=2026-02-06");
    expect(JSON.parse(calls[0].sent[0])).toMatchObject({
      type: "response.create",
      stream: true,
      client_metadata: {
        "x-codex-installation-id": expect.any(String),
        "x-codex-window-id": "conv-1:0",
      },
    });
  });

  test("stores Cloudflare cookies and reuses them on the next OpenAI request", async () => {
    const calls = mockOpenAIWebSocket([
      { headers: { "Set-Cookie": "__cf_bm=abc123; Path=/; Secure; HttpOnly" }, events: [
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
      ] },
      { events: [
        { type: "response.created", response: { id: "resp_2" } },
        { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
      ] },
    ]);

    const callbacks = {
      onText: () => {},
      onThinking: () => {},
    };

    await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1" },
    );

    await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "again" }],
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-2" },
    );

    expect(new Headers(calls[0].headers).get("Cookie")).toBeNull();
    expect(new Headers(calls[1].headers).get("Cookie")).toBe("__cf_bm=abc123");
  });

  test("reuses a turn websocket and sends incremental tool-result follow-ups", async () => {
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":"echo hi"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"echo hi"}' } },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 4 }, output: [{ type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"echo hi"}' }] } },
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_2" } },
      { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "done" },
      { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 3, output_tokens: 1 }, output: [{ type: "message", id: "msg_2", content: [{ type: "output_text", text: "done" }] }] } },
    ] }]);

    const turnSession = createOpenAITurnSession();
    const callbacks = {
      onText: () => {},
      onThinking: () => {},
    };
    const firstMessages: ApiMessage[] = [{ role: "user", content: "run echo" }];
    const first = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      firstMessages,
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession },
    );

    expect(first.toolCalls).toEqual([{ id: "call_1", name: "bash", input: { cmd: "echo hi" } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sent).toHaveLength(1);

    const secondMessages: ApiMessage[] = [
      ...firstMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "bash", input: { cmd: "echo hi" } }],
        providerData: first.assistantProviderData,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "hi", is_error: false }],
      },
    ];
    const second = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      secondMessages,
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession },
    );

    expect(second.text).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].sent).toHaveLength(2);
    const firstBody = JSON.parse(calls[0].sent[0]);
    const secondBody = JSON.parse(calls[0].sent[1]);
    expect(firstBody.previous_response_id).toBeUndefined();
    expect(firstBody.input).toHaveLength(1);
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "hi" },
    ]);
    turnSession.close();
  });

  test("reuses a completed conversation websocket during the idle persistence window", async () => {
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello" },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 2, output_tokens: 1 }, output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "hello" }] }] } },
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_2" } },
      { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "again" },
      { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: "message", id: "msg_2", content: [{ type: "output_text", text: "again" }] }] } },
    ] }]);

    const callbacks = {
      onText: () => {},
      onThinking: () => {},
    };
    const firstMessages: ApiMessage[] = [{ role: "user", content: "hi" }];
    const firstSession = createOpenAITurnSession();
    const first = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      firstMessages,
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession: firstSession },
    );

    firstSession.close();
    expect(calls).toHaveLength(1);
    expect(calls[0].isClosed()).toBe(false);

    const secondSession = createOpenAITurnSession();
    const secondMessages: ApiMessage[] = [
      ...firstMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: first.text }],
        providerData: first.assistantProviderData,
      },
      { role: "user", content: "and now?" },
    ];
    const second = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      secondMessages,
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession: secondSession },
    );

    expect(second.text).toBe("again");
    expect(calls).toHaveLength(1);
    expect(calls[0].sent).toHaveLength(2);
    const secondBody = JSON.parse(calls[0].sent[1]);
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "and now?" }] },
    ]);
    secondSession.destroy();
  });

  test("closes an idle reusable conversation websocket after the persistence timeout", async () => {
    setOpenAIWebSocketIdleTimeoutMsForTest(10);
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
    ] }]);

    const turnSession = createOpenAITurnSession();
    await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
      },
      { promptCacheKey: "conv-1", turnSession },
    );

    turnSession.close();
    expect(calls[0].isClosed()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls[0].isClosed()).toBe(true);
  });

  test("does not send previous_response_id to the codex backend", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        providerData: {
          openai: {
            responseId: "resp_abc123",
            reasoningItems: [],
          },
        },
      },
      { role: "user", content: "follow-up" },
    ];

    const body = buildRequestBodyForTest(messages, "gpt-5.4", 1234, { promptCacheKey: "conv-1" });

    expect(body.previous_response_id).toBeUndefined();
    expect(body.prompt_cache_key).toBe("conv-1");
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first prompt" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "first answer" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow-up" }],
      },
    ]);
  });

  test("replays the full conversation even when a prior response id is available", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        providerData: {
          openai: {
            responseId: "resp_abc123",
            reasoningItems: [],
          },
        },
      },
      { role: "user", content: "follow-up" },
    ];

    const body = buildRequestBodyForTest(messages, "gpt-5.4", 1234, {});

    expect(body.previous_response_id).toBeUndefined();
    expect(body.input).toEqual(buildOpenAIInputForTest(messages));
  });
});

describe("OpenAI reasoning summaries", () => {
  test("merges completed summaries over partial streamed summaries", () => {
    expect(mergeReasoningSummariesForTest(
      ["first section"],
      ["first section", "second section", "third section"],
    )).toEqual(["first section", "second section", "third section"]);
  });

  test("prefers completed summary text for overlapping sections", () => {
    expect(mergeReasoningSummariesForTest(
      ["partial first", "partial second"],
      ["final first", "final second"],
    )).toEqual(["final first", "final second"]);
  });

  test("streams reasoning summaries into thinking blocks and backfills missing final sections", () => {
    const blockStarts: Array<"text" | "thinking"> = [];
    const thinkingChunks: string[] = [];
    const result = readOpenAIEventsForTest([
      {
        type: "response.created",
        response: { id: "resp_1" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "first section",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: { input_tokens: 11, output_tokens: 7 },
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "opaque",
              summary: [
                { type: "summary_text", text: "first section" },
                { type: "summary_text", text: "second section" },
              ],
            },
          ],
        },
      },
    ], {
      onBlockStart(type) { blockStarts.push(type); },
      onThinking(chunk) { thinkingChunks.push(chunk); },
    });

    expect(blockStarts).toEqual(["thinking", "thinking"]);
    expect(thinkingChunks).toEqual(["first section", "second section"]);
    expect(result.thinking).toBe("first sectionsecond section");
    expect(result.blocks).toEqual([
      { type: "thinking", text: "first section", signature: "" },
      { type: "thinking", text: "second section", signature: "" },
    ]);
    expect(result.assistantProviderData).toEqual({
      openai: {
        responseId: "resp_1",
        reasoningItems: [
          {
            id: "rs_1",
            encryptedContent: "opaque",
            summaries: ["first section", "second section"],
          },
        ],
      },
    });
  });

  test("backfills assistant text that only appears in the completed payload", () => {
    const blockStarts: Array<"text" | "thinking"> = [];
    const textChunks: string[] = [];
    const result = readOpenAIEventsForTest([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: "hello",
      },
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              id: "msg_1",
              content: [{ type: "output_text", text: "hello world" }],
            },
          ],
        },
      },
    ], {
      onBlockStart(type) { blockStarts.push(type); },
      onText(chunk) { textChunks.push(chunk); },
    });

    expect(blockStarts).toEqual(["text"]);
    expect(textChunks).toEqual(["hello", " world"]);
    expect(result.blocks).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  test("uses output_text.done to backfill finalized text before response.completed", () => {
    const blockStarts: Array<"text" | "thinking"> = [];
    const textChunks: string[] = [];
    const result = readOpenAIEventsForTest([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "hello",
      },
      {
        type: "response.output_text.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        text: "hello world",
      },
    ], {
      onBlockStart(type) { blockStarts.push(type); },
      onText(chunk) { textChunks.push(chunk); },
    });

    expect(blockStarts).toEqual(["text"]);
    expect(textChunks).toEqual(["hello", " world"]);
    expect(result.blocks).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  test("syncs canonical blocks when a later event patches an earlier text block", () => {
    const syncedBlocks: Array<Array<{ type: string; text: string }>> = [];
    const result = readOpenAIEventsForTest([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "First paragraph.\n\n",
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "reasoning", id: "rs_1" },
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 1,
        summary_index: 0,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 1,
        summary_index: 0,
        delta: "Thinking...",
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "Second paragraph.",
      },
    ], {
      onBlocksUpdate(blocks) {
        syncedBlocks.push(blocks.flatMap((block) =>
          block.type === "text" || block.type === "thinking"
            ? [{ type: block.type, text: block.text }]
            : []));
      },
    });

    expect(syncedBlocks).toEqual([
      [
        { type: "text", text: "First paragraph.\n\nSecond paragraph." },
        { type: "thinking", text: "Thinking..." },
      ],
    ]);
    expect(result.blocks).toEqual([
      { type: "text", text: "First paragraph.\n\nSecond paragraph." },
      { type: "thinking", text: "Thinking...", signature: "" },
    ]);
  });

  test("does not emit a synthetic suffix when the completed payload rewrites existing reasoning text", () => {
    const blockStarts: Array<"text" | "thinking"> = [];
    const thinkingChunks: string[] = [];
    const result = readOpenAIEventsForTest([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "partial",
      },
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "final" }],
            },
          ],
        },
      },
    ], {
      onBlockStart(type) { blockStarts.push(type); },
      onThinking(chunk) { thinkingChunks.push(chunk); },
    });

    expect(blockStarts).toEqual(["thinking"]);
    expect(thinkingChunks).toEqual(["partial"]);
    expect(result.blocks).toEqual([
      { type: "thinking", text: "final", signature: "" },
    ]);
  });

  test("starts a new thinking block when a new reasoning summary part begins", () => {
    const blockStarts: Array<"text" | "thinking"> = [];
    const result = readOpenAIEventsForTest([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "first",
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 1,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 1,
        delta: "second",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [
                { type: "summary_text", text: "first" },
                { type: "summary_text", text: "second" },
              ],
            },
          ],
        },
      },
    ], {
      onBlockStart(type) { blockStarts.push(type); },
    });

    expect(blockStarts).toEqual(["thinking", "thinking"]);
    expect(result.blocks).toEqual([
      { type: "thinking", text: "first", signature: "" },
      { type: "thinking", text: "second", signature: "" },
    ]);
  });
});

  test("preserves output item ordering between reasoning and text blocks", () => {
    const result = readOpenAIEventsForTest([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "first think",
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1" },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: "then speak",
      },
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "first think" }],
            },
            {
              type: "message",
              id: "msg_1",
              content: [{ type: "output_text", text: "then speak" }],
            },
          ],
        },
      },
    ]);

    expect(result.blocks).toEqual([
      { type: "thinking", text: "first think", signature: "" },
      { type: "text", text: "then speak" },
    ]);
  });


describe("OpenAI raw reasoning", () => {
  test("uses raw reasoning content when available", () => {
    const result = readOpenAIEventsForTest([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
      { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "raw detail" },
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "summary detail" }],
              content: [{ type: "reasoning_text", text: "raw detail" }],
            },
          ],
        },
      },
    ]);

    expect(result.blocks).toEqual([
      { type: "thinking", text: "raw detail", signature: "" },
    ]);
    expect(result.assistantProviderData).toEqual({
      openai: {
        reasoningItems: [
          {
            id: "rs_1",
            encryptedContent: null,
            summaries: ["summary detail"],
            rawContent: ["raw detail"],
          },
        ],
      },
    });
  });

});
