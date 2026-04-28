import { afterEach, describe, expect, mock, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import type { ApiMessage } from "../../messages";
import {
  buildOpenAIInputForTest,
  buildRequestBodyForTest,
  isRetriableOpenAIStatusForTest,
  mergeReasoningSummariesForTest,
  parseOpenAIUsageLimitErrorForTest,
  readOpenAIEventsForTest,
  shouldRetryOpenAIUsageLimitResetForTest,
  streamMessageWithSession,
} from "./api";
import { clearCloudflareCookiesForTest } from "./cookies";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCloudflareCookiesForTest();
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

  test("treats HTTP 507 as retriable", () => {
    expect(isRetriableOpenAIStatusForTest(507)).toBe(true);
    expect(isRetriableOpenAIStatusForTest(401)).toBe(false);
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
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: "pro",
        resets_in_seconds: 5456,
      },
    }), { status: 429 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("hard-fails context-window stream errors without transient retries", async () => {
    const onRetry = mock(() => {});
    const fetchMock = mock(() => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          "data: " + JSON.stringify({
            type: "response.failed",
            response: {
              error: {
                code: "context_length_exceeded",
                message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
              },
            },
          }),
          "",
        ].join("\n")));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("aborting an in-flight stream does not emit retry callbacks", async () => {
    const ac = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const onRetry = mock(() => {});

    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          fetchSignal?.addEventListener("abort", () => {
            controller.error(new DOMException("The message was aborted", "AbortError"));
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    }) as unknown as typeof fetch;

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
    let fetchInit: RequestInit | undefined;

    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchInit = init;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            'data: {"type":"response.created","response":{"id":"resp_1"}}',
            'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":1},"output":[]}}',
            "data: [DONE]",
            "",
          ].join("\n\n")));
          controller.close();
        },
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    }) as unknown as typeof fetch;

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

    const headers = new Headers(fetchInit?.headers);
    expect(headers.get("session_id")).toBe("conv-1");
    expect(headers.get("x-client-request-id")).toBe("conv-1");
    expect(headers.get("x-codex-window-id")).toBe("conv-1:0");
    expect(headers.get("ChatGPT-Account-ID")).toBe("acct_123");
    expect(headers.get("User-Agent")).toStartWith("codex_cli_rs/");
    expect(headers.get("Content-Encoding")).toBe("zstd");
  });

  test("stores Cloudflare cookies and reuses them on the next OpenAI request", async () => {
    const seenCookies: Array<string | null> = [];

    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      seenCookies.push(new Headers(init?.headers).get("Cookie"));
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            'data: {"type":"response.created","response":{"id":"resp_1"}}',
            'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":1},"output":[]}}',
            "data: [DONE]",
            "",
          ].join("\n\n")));
          controller.close();
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Set-Cookie": "__cf_bm=abc123; Path=/; Secure; HttpOnly",
        },
      }));
    }) as unknown as typeof fetch;

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

    expect(seenCookies).toEqual([null, "__cf_bm=abc123"]);
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
        role: "user",
        content: [{ type: "input_text", text: "first prompt" }],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "first answer" }],
      },
      {
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
