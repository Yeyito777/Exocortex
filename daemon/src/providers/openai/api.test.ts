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
  streamMessageHttpWithSessionForTest,
  streamMessage,
  streamMessageWithSession,
} from "./api";
import { clearProviderAuth, saveProviderAuth } from "../../store";
import { OPENAI_CODEX_RESPONSES_URL, OPENAI_CODEX_RESPONSES_WS_URL, OPENAI_TOKEN_URL } from "./constants";
import { clearCloudflareCookiesForTest } from "./cookies";
import { accountScopeForKey } from "./auth";
import type { StoredOpenAIAuth } from "./session";
import { OpenAIWebSocketHttpError, setOpenAIWebSocketConnectorForTest, type OpenAIWebSocketConnection } from "./websocket";

const originalFetch = globalThis.fetch;

function corruptFirstPngIdatByte(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  let offset = 8; // PNG signature
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      const dataStart = offset + 8;
      bytes[dataStart + Math.min(2, Math.max(0, length - 1))] ^= 0xff;
      return bytes.toString("base64");
    }
    offset += 12 + length;
  }
  throw new Error("fixture PNG has no IDAT chunk");
}

interface MockWebSocketCall {
  url: string;
  headers: Record<string, string>;
  sent: string[];
  isClosed: () => boolean;
}

type MockWebSocketMessage =
  | { type: "text"; text: string }
  | { type: "close"; code?: number; reason?: string };

function mockOpenAIWebSocket(
  connections: Array<{
    events?: Array<Record<string, unknown>>;
    error?: Error;
    headers?: HeadersInit;
    nextMessage?: (signal?: AbortSignal) => Promise<MockWebSocketMessage>;
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
  test("refuses encrypted replay when the verified request account or model scope changed", async () => {
    const accountA = accountScopeForKey("stable-account-a")!;
    const accountB = accountScopeForKey("stable-account-b")!;
    const scopedMessages: ApiMessage[] = [{
      role: "assistant",
      content: [],
      providerData: {
        openai: {
          replayScope: { model: "gpt-5.6-sol", accountScope: accountA },
          reasoningItems: [{ id: "reasoning-a", encryptedContent: "opaque-a", summaries: [] }],
        },
      },
    }];
    const callbacks = { onText: () => {}, onThinking: () => {} };

    await expect(streamMessageWithSession(
      { accessToken: "token-b", accountId: "acct-b", accountKey: "stable-account-b" },
      scopedMessages,
      "gpt-5.6-sol",
      callbacks,
      { accountScope: accountB },
    )).rejects.toThrow(/different model or account scope/i);

    await expect(streamMessageWithSession(
      { accessToken: "token-b", accountId: "acct-b", accountKey: "stable-account-b" },
      [{
        role: "assistant",
        content: [],
        providerData: {
          openai: {
            reasoningItems: [{ id: "legacy-unscoped", encryptedContent: "opaque", summaries: [] }],
          },
        },
      }],
      "gpt-5.6-sol",
      callbacks,
      { accountScope: accountA },
    )).rejects.toThrow(/account changed while preparing/i);
  });

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

  test("native compaction appends a trigger and replays opaque payloads without stored response IDs", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "keep this request" },
      {
        role: "assistant",
        content: [],
        providerData: {
          openai: {
            compactionItems: [{
              id: "cmp-local-only",
              encryptedContent: "opaque-checkpoint",
              internalChatMessageMetadataPassthrough: { turn_id: "turn_checkpoint" },
            }],
          },
        },
      },
    ], "gpt-5.6-sol", 1234, { compaction: true });

    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep this request" }] },
      {
        type: "compaction",
        encrypted_content: "opaque-checkpoint",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_checkpoint" },
      },
      { type: "compaction_trigger" },
    ]);
  });

  test("fast mode maps to the priority service tier", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.4", 1234, { serviceTier: "fast" });

    expect(body.service_tier).toBe("priority");
  });

  test("one-shot HTTP transport parses SSE responses without websocket beta headers", async () => {
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(OPENAI_CODEX_RESPONSES_URL);
      const headers = init?.headers as Record<string, string>;
      expect(headers["OpenAI-Beta"]).toBeUndefined();
      expect(headers.Accept).toBe("text/event-stream");
      const body = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } })}`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" })}`,
        `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "OK" })}`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 3, output_tokens: 1 }, output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "OK" }] }] } })}`,
        "",
      ].join("\n\n");
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await streamMessageHttpWithSessionForTest(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "hello" }],
      "gpt-5.4-mini",
      { onText: () => {}, onThinking: () => {} },
      { effort: "none", preferHttp: true },
    );

    expect(result.text).toBe("OK");
    expect(result.inputTokens).toBe(3);
    expect(result.outputTokens).toBe(1);
    expect(result.requestDiagnostics?.fallbackReason).toBe("http_sse");
  });

  test("reasoning summary defaults to detailed for models that support it", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.4", 1234, {});

    expect((body.reasoning as { summary?: string }).summary).toBe("detailed");
  });

  test("none effort disables reasoning summaries", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.4-mini", 1234, { effort: "none" });

    expect((body.reasoning as { effort?: string; summary?: string }).effort).toBe("none");
    expect((body.reasoning as { summary?: string }).summary).toBeUndefined();
    expect(body.include).toEqual([]);
  });

  test("max effort is sent through for GPT-5.6 models", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.6-sol", 1234, { effort: "max" });

    expect((body.reasoning as { effort?: string }).effort).toBe("max");
  });

  test("max effort remains xhigh-compatible for older OpenAI models", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.5", 1234, { effort: "max" });

    expect((body.reasoning as { effort?: string }).effort).toBe("xhigh");
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
    const validPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const corruptPng = corruptFirstPngIdatByte(validPng);
    const messages: ApiMessage[] = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: corruptPng } },
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
      { type: "input_text", text: "[Invalid image/png attachment omitted before sending to OpenAI.]" },
      { type: "input_image", image_url: `data:image/png;base64,${validPng}` },
      { type: "input_text", text: "caption" },
    ]);
  });

  test("omits corrupt tool-result images before building OpenAI input", () => {
    const validPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const corruptPng = corruptFirstPngIdatByte(validPng);
    const messages: ApiMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_read", name: "read", input: { file_path: "/tmp/corrupt.png" } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_read",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: corruptPng } },
            { type: "text", text: "Read image: /tmp/corrupt.png (0.0 MB)" },
          ],
          is_error: false,
        }],
      },
    ];

    const input = buildOpenAIInputForTest(messages) as Array<{
      type: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      output?: string;
      content?: Array<{ type: string; image_url?: string }>;
    }>;

    expect(input).toEqual([
      { type: "function_call", call_id: "call_read", name: "read", arguments: JSON.stringify({ file_path: "/tmp/corrupt.png" }) },
      { type: "function_call_output", call_id: "call_read", output: "Read image: /tmp/corrupt.png (0.0 MB)" },
    ]);
    expect(JSON.stringify(input)).not.toContain("input_image");
  });

  test("limits replayed tool-result images to the latest five", () => {
    const validPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const messages: ApiMessage[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `call_${i}`, name: "computer_get_app_state", input: { app: "vimbrowser" } }],
      });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: `call_${i}`,
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: validPng } },
            { type: "text", text: `screenshot ${i}` },
          ],
          is_error: false,
        }],
      });
    }

    const input = buildOpenAIInputForTest(messages) as Array<{
      type: string;
      role?: string;
      call_id?: string;
      output?: string;
      content?: Array<{ type: string; text?: string; image_url?: string }>;
    }>;

    expect(input.filter((item) => item.type === "function_call_output")).toHaveLength(7);
    const imageMessages = input.filter((item) =>
      item.type === "message" && item.role === "user" && item.content?.some((part) => part.type === "input_image")
    );
    expect(imageMessages).toHaveLength(5);
    expect(imageMessages.map((item) => item.content?.[0]?.text)).toEqual([
      "Image output for tool call call_2.",
      "Image output for tool call call_3.",
      "Image output for tool call call_4.",
      "Image output for tool call call_5.",
      "Image output for tool call call_6.",
    ]);
  });

  test("limits direct user image attachments to the latest five", () => {
    const validPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const messages: ApiMessage[] = [{
      role: "user",
      content: [
        ...Array.from({ length: 6 }, () => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png", data: validPng },
        })),
        { type: "text", text: "caption" },
      ],
    }];

    const input = buildOpenAIInputForTest(messages) as Array<{
      type: string;
      content?: Array<{ type: string; text?: string; image_url?: string }>;
    }>;
    const content = input[0].content ?? [];

    expect(content.filter((part) => part.type === "input_image")).toHaveLength(5);
    expect(content[0]).toEqual({
      type: "input_text",
      text: "[Older image omitted from replay; only the latest 5 images are sent to OpenAI.]",
    });
    expect(content.at(-1)).toEqual({ type: "input_text", text: "caption" });
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

  test("shares one native compaction budget across websocket transport retries", async () => {
    const retryCalls: unknown[][] = [];
    const requestBudget = { maxAttempts: 2, attempts: 0 };
    const calls = mockOpenAIWebSocket([
      { error: new OpenAIWebSocketHttpError(503, new Headers(), "first") },
      { error: new OpenAIWebSocketHttpError(503, new Headers(), "second") },
    ]);

    await expect(streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "compact" }],
      "gpt-5.6-sol",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry: (...args) => retryCalls.push(args),
      },
      {
        compaction: true,
        requestBudget,
      },
    )).rejects.toThrow(/503|second/i);

    expect(calls).toHaveLength(2);
    expect(requestBudget.attempts).toBe(2);
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0].slice(0, 3)).toEqual([1, 1, "HTTP 503"]);
  });

  test("reconnects when the Codex websocket connection limit is reached", async () => {
    const retryCalls: unknown[][] = [];
    const onRetry = mock((...args: unknown[]) => { retryCalls.push(args); });
    const calls = mockOpenAIWebSocket([
      { events: [
        {
          type: "error",
          status: 400,
          error: {
            type: "invalid_request_error",
            code: "websocket_connection_limit_reached",
            message: "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
          },
        },
      ] },
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
    expect(retryCalls[0][2]).toBe("Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.");
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

  test("routes native-compaction context errors through the general eight-retry backoff", async () => {
    const retryCalls: unknown[][] = [];
    const requestBudget = { maxAttempts: 9, attempts: 0 };
    const calls = mockOpenAIWebSocket([
      { events: [{
        type: "response.failed",
        response: {
          error: {
            code: "context_length_exceeded",
            message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
          },
        },
      }] },
      { events: [
        { type: "response.created", response: { id: "resp_compacted" } },
        {
          type: "response.completed",
          response: {
            id: "resp_compacted",
            usage: { input_tokens: 1, output_tokens: 1 },
            output: [],
          },
        },
      ] },
    ]);

    const result = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [{ role: "user", content: "oversized input" }],
      "gpt-5.4",
      {
        onText: () => {},
        onThinking: () => {},
        onRetry: (...args) => retryCalls.push(args),
      },
      { compaction: true, requestBudget },
    );

    expect(result.stopReason).toBe("stop");
    expect(calls).toHaveLength(2);
    expect(requestBudget.attempts).toBe(2);
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0].slice(0, 3)).toEqual([
      1,
      8,
      "Your input exceeds the context window of this model. Please adjust your input and try again.",
    ]);
    expect(retryCalls[0][3]).toBeGreaterThanOrEqual(1);
    expect(retryCalls[0][4]).toEqual({ kind: "transient" });
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
      {
        promptCacheKey: "conv-1",
        codexTurnId: "conv-1:turn-regular",
        codexTurnStartedAtMs: 1_700_000_000_000,
      },
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
    expect(headers.get("x-codex-beta-features")?.split(",")).toContain("remote_compaction_v2");
    const turnMetadata = JSON.parse(headers.get("x-codex-turn-metadata") ?? "null");
    expect(turnMetadata).toMatchObject({
      request_kind: "turn",
      turn_id: "conv-1:turn-regular",
      turn_started_at_unix_ms: 1_700_000_000_000,
      window_id: "conv-1:0",
    });
    expect(turnMetadata.compaction).toBeUndefined();
    const body = JSON.parse(calls[0].sent[0]);
    expect(body).toMatchObject({
      type: "response.create",
      stream: true,
      client_metadata: {
        "x-codex-installation-id": expect.any(String),
        "x-codex-window-id": "conv-1:0",
      },
    });
    expect(JSON.parse(body.client_metadata["x-codex-turn-metadata"])).toEqual(turnMetadata);
  });

  test("marks native compaction requests with Codex v2 turn metadata", async () => {
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_compact" } },
      {
        type: "response.completed",
        response: {
          id: "resp_compact",
          usage: { input_tokens: 100, output_tokens: 1 },
          output: [{ type: "compaction", encrypted_content: "opaque" }],
        },
      },
    ] }]);

    const result = await streamMessageWithSession(
      { accessToken: "test-token", accountId: "acct_123" },
      [{ role: "user", content: "compact me" }],
      "gpt-5.6-sol",
      { onText: () => {}, onThinking: () => {} },
      {
        promptCacheKey: "conv-compact",
        codexWindowId: "conv-compact:3",
        codexTurnId: "turn-compact-123",
        codexTurnStartedAtMs: 1_700_000_000_000,
        compaction: true,
        compactionMetadata: { reason: "context_limit", phase: "mid_turn" },
      },
    );

    const headers = new Headers(calls[0].headers);
    const metadata = JSON.parse(headers.get("x-codex-turn-metadata") ?? "null");
    expect(metadata).toMatchObject({
      installation_id: expect.any(String),
      session_id: "conv-compact",
      thread_id: "conv-compact",
      turn_id: "turn-compact-123",
      turn_started_at_unix_ms: 1_700_000_000_000,
      request_kind: "compaction",
      window_id: "conv-compact:3",
      compaction: {
        trigger: "auto",
        reason: "context_limit",
        implementation: "responses_compaction_v2",
        phase: "mid_turn",
        strategy: "memento",
      },
    });
    expect(headers.get("x-codex-window-id")).toBe("conv-compact:3");
    const requestBody = JSON.parse(calls[0].sent[0]);
    expect(requestBody.client_metadata["x-codex-window-id"]).toBe("conv-compact:3");
    expect(JSON.parse(requestBody.client_metadata["x-codex-turn-metadata"])).toEqual(metadata);
    expect(requestBody.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(result.compactionItems).toEqual([{ encryptedContent: "opaque" }]);
  });

  test("sends compaction turn metadata in response.create when reusing a websocket", async () => {
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_normal" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_normal" } },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "normal answer" },
      {
        type: "response.completed",
        response: {
          id: "resp_normal",
          usage: { input_tokens: 10, output_tokens: 2 },
          output: [{ type: "message", id: "msg_normal", content: [{ type: "output_text", text: "normal answer" }] }],
        },
      },
      { type: "response.created", response: { id: "resp_compact" } },
      {
        type: "response.completed",
        response: {
          id: "resp_compact",
          usage: { input_tokens: 12, output_tokens: 1 },
          output: [{ type: "compaction", encrypted_content: "opaque-reused" }],
        },
      },
    ] }]);
    const turnSession = createOpenAITurnSession();
    const session = { accessToken: "test-token", accountId: "acct_123", accountKey: "stable-account-a" };
    const callbacks = { onText: () => {}, onThinking: () => {} };

    const first = await streamMessageWithSession(
      session,
      [{ role: "user", content: "hello" }],
      "gpt-5.6-sol",
      callbacks,
      { promptCacheKey: "conv-reused-compact", codexWindowId: "conv-reused-compact:0", turnSession },
    );
    const second = await streamMessageWithSession(
      session,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "normal answer" }], providerData: first.assistantProviderData },
      ],
      "gpt-5.6-sol",
      callbacks,
      {
        promptCacheKey: "conv-reused-compact",
        codexWindowId: "conv-reused-compact:0",
        turnSession,
        compaction: true,
        compactionMetadata: { reason: "context_limit", phase: "mid_turn" },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].sent).toHaveLength(2);
    const compactionBody = JSON.parse(calls[0].sent[1]);
    expect(compactionBody.previous_response_id).toBe("resp_normal");
    expect(compactionBody.input).toEqual([{ type: "compaction_trigger" }]);
    expect(JSON.parse(compactionBody.client_metadata["x-codex-turn-metadata"])).toMatchObject({
      request_kind: "compaction",
      window_id: "conv-reused-compact:0",
      compaction: { phase: "mid_turn", implementation: "responses_compaction_v2" },
    });
    expect(second.compactionItems).toEqual([{ encryptedContent: "opaque-reused" }]);
    expect(first.assistantProviderData?.openai.replayScope).toEqual({
      model: "gpt-5.6-sol",
      accountScope: accountScopeForKey("stable-account-a")!,
    });
    expect(second.assistantProviderData?.openai.replayScope).toEqual(first.assistantProviderData?.openai.replayScope);
    turnSession.close();
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
      { type: "response.metadata", headers: { "x-codex-turn-state": "turn-state-1" } },
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
    expect(firstBody.client_metadata?.["x-codex-turn-state"]).toBeUndefined();
    expect(firstBody.input).toHaveLength(1);
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.client_metadata["x-codex-turn-state"]).toBe("turn-state-1");
    expect(secondBody.input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "hi" },
    ]);
    turnSession.close();
  });


  test("silently reconnects a reused websocket that closes before the follow-up response starts", async () => {
    const retryCalls: unknown[][] = [];
    const onRetry = mock((...args: unknown[]) => { retryCalls.push(args); });
    const firstConnectionMessages: MockWebSocketMessage[] = [
      { type: "text", text: JSON.stringify({ type: "response.created", response: { id: "resp_1" } }) },
      { type: "text", text: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash" } }) },
      { type: "text", text: JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":"echo hi"}' }) },
      { type: "text", text: JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"echo hi"}' } }) },
      { type: "text", text: JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 4 }, output: [{ type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"echo hi"}' }] } }) },
      { type: "close", code: 1000 },
    ];
    const calls = mockOpenAIWebSocket([
      {
        headers: { "x-codex-turn-state": "turn-state-1" },
        nextMessage: async () => firstConnectionMessages.shift() ?? { type: "close" },
      },
      { events: [
        { type: "response.created", response: { id: "resp_2" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_2" } },
        { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "done" },
        { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 20, output_tokens: 1 }, output: [{ type: "message", id: "msg_2", content: [{ type: "output_text", text: "done" }] }] } },
      ] },
    ]);

    const turnSession = createOpenAITurnSession();
    const callbacks = {
      onText: () => {},
      onThinking: () => {},
      onRetry,
    };
    const firstMessages: ApiMessage[] = [{ role: "user", content: "run echo" }];
    const first = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      firstMessages,
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession },
    );

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
    expect(calls).toHaveLength(2);
    expect(calls[0].sent).toHaveLength(2);
    const staleIncrementalBody = JSON.parse(calls[0].sent[1]);
    expect(staleIncrementalBody.previous_response_id).toBe("resp_1");
    const replayBody = JSON.parse(calls[1].sent[0]);
    expect(new Headers(calls[1].headers).get("x-codex-turn-state")).toBe("turn-state-1");
    expect(replayBody.previous_response_id).toBeUndefined();
    expect(Array.isArray(replayBody.input)).toBe(true);
    expect(replayBody.input.length).toBeGreaterThan(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(retryCalls).toEqual([]);
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
      { promptCacheKey: "conv-1", codexTurnId: "conv-1:turn-1", turnSession: firstSession },
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
      { promptCacheKey: "conv-1", codexTurnId: "conv-1:turn-2", turnSession: secondSession },
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

  test("clears Codex turn-state when reusing a parked websocket for a new user turn", async () => {
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.metadata", headers: { "x-codex-turn-state": "turn-state-1" } },
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

    const secondSession = createOpenAITurnSession();
    await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [
        ...firstMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: first.text }],
          providerData: first.assistantProviderData,
        },
        { role: "user", content: "and now?" },
      ],
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession: secondSession },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].sent).toHaveLength(2);
    const secondBody = JSON.parse(calls[0].sent[1]);
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.client_metadata?.["x-codex-turn-state"]).toBeUndefined();
    secondSession.destroy();
  });

  test("full-replays instead of incremental when the exact previous output baseline differs", async () => {
    const calls = mockOpenAIWebSocket([{ events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello" },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 2, output_tokens: 1 }, output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "hello" }] }] } },
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_2" } },
      { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "again" },
      { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 4, output_tokens: 1 }, output: [{ type: "message", id: "msg_2", content: [{ type: "output_text", text: "again" }] }] } },
    ] }]);

    const turnSession = createOpenAITurnSession();
    const callbacks = {
      onText: () => {},
      onThinking: () => {},
    };
    const firstMessages: ApiMessage[] = [{ role: "user", content: "hi" }];
    const first = await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      firstMessages,
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession },
    );
    expect(first.text).toBe("hello");

    await streamMessageWithSession(
      { accessToken: "test-token", accountId: null },
      [
        ...firstMessages,
        // Deliberately differ from the provider output item that was actually
        // emitted for resp_1. The exact-output baseline should catch this and
        // fall back to full replay instead of skipping by item shape alone.
        { role: "assistant", content: [{ type: "text", text: "HELLO" }], providerData: first.assistantProviderData },
        { role: "user", content: "again?" },
      ],
      "gpt-5.4",
      callbacks,
      { promptCacheKey: "conv-1", turnSession },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].sent).toHaveLength(2);
    const secondBody = JSON.parse(calls[0].sent[1]);
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toHaveLength(3);
    turnSession.destroy();
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
  test("captures a native compaction item without rendering assistant output", () => {
    const result = readOpenAIEventsForTest([
      { type: "response.created", response: { id: "resp_compact" } },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "compaction",
          encrypted_content: "encrypted-context",
          internal_chat_message_metadata_passthrough: { turn_id: "turn_compact" },
        },
      },
      {
        type: "response.completed",
        response: {
          usage: { input_tokens: 300_000, output_tokens: 1 },
          output: [{
            type: "compaction",
            encrypted_content: "encrypted-context",
            internal_chat_message_metadata_passthrough: { turn_id: "turn_compact" },
          }],
        },
      },
    ]);

    expect(result.blocks).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.compactionItems).toEqual([{
      encryptedContent: "encrypted-context",
      internalChatMessageMetadataPassthrough: { turn_id: "turn_compact" },
    }]);
    expect(result.responseOutputItems).toEqual([{
      type: "compaction",
      encrypted_content: "encrypted-context",
      internal_chat_message_metadata_passthrough: { turn_id: "turn_compact" },
    }]);
    expect(result.assistantProviderData?.openai.compactionItems).toEqual([{
      encryptedContent: "encrypted-context",
      internalChatMessageMetadataPassthrough: { turn_id: "turn_compact" },
    }]);
  });

  test("captures a compaction-only done item without output_index or duplicated completed output", () => {
    const result = readOpenAIEventsForTest([
      { type: "response.created", response: { id: "resp_compact_sparse" } },
      {
        type: "response.output_item.done",
        item: { type: "compaction", encrypted_content: "sparse-encrypted-context" },
      },
      {
        type: "response.completed",
        response: { id: "resp_compact_sparse", usage: { input_tokens: 300_000, output_tokens: 1 } },
      },
    ]);

    expect(result.stopReason).toBe("stop");
    expect(result.compactionItems).toEqual([{ encryptedContent: "sparse-encrypted-context" }]);
    expect(result.compactionDoneCount).toBe(1);
    expect(result.responseCompleted).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  test("does not duplicate a compaction item when done omits the added item's output_index", () => {
    const result = readOpenAIEventsForTest([
      { type: "response.created", response: { id: "resp_compact_added" } },
      {
        type: "response.output_item.added",
        output_index: 3,
        item: { type: "compaction", id: "cmp-added", encrypted_content: "opaque-added" },
      },
      {
        type: "response.output_item.done",
        item: { type: "compaction", id: "cmp-added", encrypted_content: "opaque-added" },
      },
      {
        type: "response.completed",
        response: { id: "resp_compact_added", usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ]);

    expect(result.compactionItems).toEqual([{
      id: "cmp-added",
      encryptedContent: "opaque-added",
    }]);
    expect(result.compactionDoneCount).toBe(1);
  });

  test("counts duplicate compaction done events even when they reuse one output slot", () => {
    const result = readOpenAIEventsForTest([
      { type: "response.created", response: { id: "resp_compact_duplicate" } },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "compaction", encrypted_content: "first" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "compaction", encrypted_content: "second" },
      },
      { type: "response.completed", response: { id: "resp_compact_duplicate", output: [] } },
    ]);

    expect(result.compactionDoneCount).toBe(2);
    expect(result.compactionItems).toEqual([{ encryptedContent: "second" }]);
  });

  test("reads cached input token counts and exact replay output items", () => {
    const result = readOpenAIEventsForTest([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":"echo hi"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"echo hi"}' } },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: {
            input_tokens: 123,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens: 7,
          },
          output: [
            { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"echo hi"}' },
          ],
        },
      },
    ]);

    expect(result.inputTokens).toBe(123);
    expect(result.cachedInputTokens).toBe(100);
    expect(result.outputTokens).toBe(7);
    expect(result.responseOutputItems).toEqual([
      { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"echo hi"}' },
    ]);
  });

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

  test("keeps generated summary headings while hiding placeholders and preserving exact replay data", () => {
    const result = readOpenAIEventsForTest([
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "opaque",
              summary: [
                { type: "summary_text", text: "**Checking tests**\n\n<!-- -->" },
                { type: "summary_text", text: "  <!-- -->\n" },
              ],
            },
          ],
        },
      },
    ]);

    expect(result.thinking).toBe("**Checking tests**");
    expect(result.blocks).toEqual([
      { type: "thinking", text: "**Checking tests**", signature: "" },
    ]);
    expect(result.responseOutputItems).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "opaque",
        summary: [
          { type: "summary_text", text: "**Checking tests**\n\n<!-- -->" },
          { type: "summary_text", text: "  <!-- -->\n" },
        ],
      },
    ]);
    expect(result.assistantProviderData).toEqual({
      openai: {
        responseId: "resp_1",
        reasoningItems: [
          {
            id: "rs_1",
            encryptedContent: "opaque",
            summaries: ["**Checking tests**\n\n<!-- -->", "  <!-- -->\n"],
          },
        ],
      },
    });
  });

  test("projects empty summary parts without hiding bold content or literal HTML comments", () => {
    const result = readOpenAIEventsForTest([
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [
                { type: "summary_text", text: "**Plan**\n\nInspect the parser." },
                { type: "summary_text", text: "**Checking tests**\n\n<!-- -->" },
                { type: "summary_text", text: "**Important conclusion**" },
                { type: "summary_text", text: "Use `<!-- -->` in JSX." },
              ],
            },
          ],
        },
      },
    ]);

    expect(result.blocks).toEqual([
      { type: "thinking", text: "**Plan**\n\nInspect the parser.", signature: "" },
      { type: "thinking", text: "**Checking tests**", signature: "" },
      { type: "thinking", text: "**Important conclusion**", signature: "" },
      { type: "thinking", text: "Use `<!-- -->` in JSX.", signature: "" },
    ]);
    expect(result.assistantProviderData?.openai.reasoningItems?.[0]?.summaries).toEqual([
      "**Plan**\n\nInspect the parser.",
      "**Checking tests**\n\n<!-- -->",
      "**Important conclusion**",
      "Use `<!-- -->` in JSX.",
    ]);
  });

  test("keeps a streamed heading when the part resolves to an empty placeholder", () => {
    const thinkingChunks: string[] = [];
    const syncedBlocks: Array<Array<{ type: string; text: string }>> = [];
    const result = readOpenAIEventsForTest([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
      { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0 },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "**Checking tests**",
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "\n\n<!-- -->",
      },
    ], {
      onThinking(chunk) { thinkingChunks.push(chunk); },
      onBlocksUpdate(blocks) {
        syncedBlocks.push(blocks.flatMap((block) =>
          block.type === "text" || block.type === "thinking"
            ? [{ type: block.type, text: block.text }]
            : []));
      },
    });

    expect(thinkingChunks).toEqual(["**Checking tests**"]);
    expect(syncedBlocks).toEqual([]);
    expect(result.thinking).toBe("**Checking tests**");
    expect(result.blocks).toEqual([
      { type: "thinking", text: "**Checking tests**", signature: "" },
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
