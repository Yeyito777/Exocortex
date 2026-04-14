import { afterEach, describe, expect, mock, test } from "bun:test";
import { OPENAI_TRANSCRIBE_URL } from "./constants";
import { transcribeAudioWithSession } from "./transcription";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("openai transcription", () => {
  test("posts multipart audio to the ChatGPT transcription endpoint", async () => {
    let fetchInput: RequestInfo | URL | undefined;
    let fetchInit: RequestInit | undefined;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      fetchInput = input;
      fetchInit = init;
      return Promise.resolve(new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }) as unknown as typeof fetch;

    const text = await transcribeAudioWithSession(
      { accessToken: "token-123", accountId: "acct_456" },
      new Uint8Array([1, 2, 3, 4]),
      "audio/wav",
    );

    expect(text).toBe("hello world");
    expect(fetchInput).toBe(OPENAI_TRANSCRIBE_URL);

    const headers = new Headers(fetchInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("ChatGPT-Account-ID")).toBe("acct_456");
    expect(headers.get("originator")).toBeTruthy();

    expect(fetchInit?.body).toBeInstanceOf(FormData);
    const file = (fetchInit?.body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe("audio/wav");
    expect(await (file as Blob).arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
  });

  test("rejects empty transcription results", async () => {
    globalThis.fetch = mock(() => {
      return Promise.resolve(new Response(JSON.stringify({ text: "   " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }) as unknown as typeof fetch;

    await expect(transcribeAudioWithSession(
      { accessToken: "token-123", accountId: null },
      new Uint8Array([1, 2, 3]),
      "audio/wav",
    )).rejects.toThrow("empty result");
  });
});
