import { describe, expect, test } from "bun:test";
import { generateImageWithSession } from "./image-generation";

function sse(events: unknown[]): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  // Split mid-event so the reader has to reassemble chunks.
  const bytes = new TextEncoder().encode(body);
  const half = Math.floor(bytes.length / 2);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, half));
      controller.enqueue(bytes.subarray(half));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("daemon image generation", () => {
  test("sends the daemon's own credentials and returns the streamed image", async () => {
    let request: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      request = { url, init };
      return sse([
        { type: "response.created" },
        { type: "response.output_item.done", item: { type: "image_generation_call", result: "aW1n", revised_prompt: "a red square" } },
        { type: "response.completed", response: { output: [] } },
      ]);
    }) as unknown as typeof fetch;
    const image = await generateImageWithSession({ accessToken: "tok", accountId: "acct" }, "a red square", { fetchImpl });
    expect(image).toEqual({ imageBase64: "aW1n", revisedPrompt: "a red square" });
    const headers = request!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["ChatGPT-Account-ID"]).toBe("acct");
    expect(JSON.parse(String(request!.init.body)).input[0].content[0].text).toBe("a red square");
  });

  test("falls back to the completed response's output", async () => {
    const fetchImpl = (async () => sse([
      { type: "response.completed", response: { output: [{ type: "image_generation_call", result: "eA==" }] } },
    ])) as unknown as typeof fetch;
    await expect(generateImageWithSession({ accessToken: "t", accountId: null }, "x", { fetchImpl }))
      .resolves.toEqual({ imageBase64: "eA==", revisedPrompt: null });
  });

  test("reports HTTP errors and streams without an image", async () => {
    const failing = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(generateImageWithSession({ accessToken: "t", accountId: null }, "x", { fetchImpl: failing }))
      .rejects.toThrow("OpenAI image generation failed (401): nope");
    const empty = (async () => sse([{ type: "response.completed", response: { output: [] } }])) as unknown as typeof fetch;
    await expect(generateImageWithSession({ accessToken: "t", accountId: null }, "x", { fetchImpl: empty }))
      .rejects.toThrow("finished without an image");
  });
});
