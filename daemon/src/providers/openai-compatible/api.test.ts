import { afterEach, describe, expect, mock, test } from "bun:test";
import { streamOpenAICompatibleWithApiKey, type OpenAICompatibleTransport } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const transport: OpenAICompatibleTransport = {
  providerLabel: "Test Provider",
  loginInstruction: "Log in.",
  buildUrl: () => "https://example.invalid/v1/chat/completions",
  buildHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  buildRequestBody: (_messages, model) => ({
    model,
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  }),
  parseError: (text) => {
    try {
      return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? null;
    } catch {
      return null;
    }
  },
};

describe("OpenAI-compatible transport", () => {
  test("does not hammer a provider that supplies a long Retry-After", async () => {
    let requests = 0;
    globalThis.fetch = mock(() => {
      requests += 1;
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "daily limit reached" } }), {
        status: 429,
        headers: { "Retry-After": "3600" },
      }));
    }) as unknown as typeof fetch;

    const result = streamOpenAICompatibleWithApiKey(
      transport,
      "public",
      [{ role: "user", content: "hi" }],
      "test-model",
      { onText: () => {}, onThinking: () => {} },
    );

    await expect(result).rejects.toThrow("daily limit reached; retry after 3600 seconds");
    expect(requests).toBe(1);
  });
});
