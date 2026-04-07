import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ApiMessage } from "../../messages";
import { buildOpenAIInputForTest, buildRequestBodyForTest, mergeReasoningSummariesForTest, readOpenAIEventsForTest, streamMessageWithSession } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    expect(headers.get("ChatGPT-Account-ID")).toBe("acct_123");
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

    expect(blockStarts).toEqual(["thinking"]);
    expect(thinkingChunks).toEqual(["first section"]);
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
