import { afterEach, describe, expect, mock, test } from "bun:test";
import { OPENAI_CODEX_RESPONSES_URL } from "./constants";
import { buildImageGenerationRequestBody, generateImageWithSession } from "./image-generation";

const originalFetch = globalThis.fetch;

function streamResponse(events: Record<string, unknown>[]): Response {
  const chunks = [
    ...events.map((event) => `data: ${JSON.stringify(event)}`),
    "data: [DONE]",
    "",
  ].join("\n\n");

  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("openai image generation", () => {
  test("builds the current minimal Responses request body", () => {
    expect(buildImageGenerationRequestBody("a tiny blue square")).toEqual({
      model: "gpt-5.4-mini",
      instructions: "Call the image generation tool EXACTLY according to the user's request. No interpretation no adding things copy the user request word for word.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "a tiny blue square" }],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      tools: [{ type: "image_generation" }],
      stream: true,
      store: false,
    });
  });

  test("posts to the ChatGPT codex responses endpoint and extracts the image payload", async () => {
    let fetchInput: RequestInfo | URL | undefined;
    let fetchInit: RequestInit | undefined;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      fetchInput = input;
      fetchInit = init;
      return Promise.resolve(streamResponse([
        {
          type: "response.output_item.done",
          item: {
            id: "ig_123",
            type: "image_generation_call",
            status: "completed",
            revised_prompt: "a polished tiny blue square",
            result: "Zm9v",
          },
        },
      ]));
    }) as unknown as typeof fetch;

    const generated = await generateImageWithSession(
      { accessToken: "token-123", accountId: "acct_456" },
      "a tiny blue square",
    );

    expect(fetchInput).toBe(OPENAI_CODEX_RESPONSES_URL);
    expect(fetchInit?.method).toBe("POST");
    const headers = new Headers(fetchInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("ChatGPT-Account-ID")).toBe("acct_456");
    expect(headers.get("originator")).toBeTruthy();
    expect(headers.get("Accept")).toBe("text/event-stream");

    expect(JSON.parse(String(fetchInit?.body))).toEqual({
      model: "gpt-5.4-mini",
      instructions: "Call the image generation tool EXACTLY according to the user's request. No interpretation no adding things copy the user request word for word.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "a tiny blue square" }],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      tools: [{ type: "image_generation" }],
      stream: true,
      store: false,
    });

    expect(generated).toEqual({
      id: "ig_123",
      status: "completed",
      revisedPrompt: "a polished tiny blue square",
      base64: "Zm9v",
    });
  });

  test("keeps the earlier image item when response.completed has an empty output array", async () => {
    globalThis.fetch = mock(() => {
      return Promise.resolve(streamResponse([
        {
          type: "response.output_item.done",
          item: {
            id: "ig_123",
            type: "image_generation_call",
            status: "completed",
            revised_prompt: "a polished tiny blue square",
            result: "Zm9v",
          },
        },
        {
          type: "response.completed",
          response: { output: [] },
        },
      ]));
    }) as unknown as typeof fetch;

    await expect(generateImageWithSession(
      { accessToken: "token-123", accountId: null },
      "a tiny blue square",
    )).resolves.toEqual({
      id: "ig_123",
      status: "completed",
      revisedPrompt: "a polished tiny blue square",
      base64: "Zm9v",
    });
  });

  test("rejects streams with no image_generation_call item", async () => {
    globalThis.fetch = mock(() => {
      return Promise.resolve(streamResponse([
        {
          type: "response.output_item.done",
          item: { id: "msg_1", type: "message" },
        },
      ]));
    }) as unknown as typeof fetch;

    await expect(generateImageWithSession(
      { accessToken: "token-123", accountId: null },
      "a tiny blue square",
    )).rejects.toThrow("without an image_generation_call item");
  });
});
