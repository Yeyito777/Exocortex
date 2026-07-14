import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  OPENAI_AUTH_CLIENT_ID,
  OPENAI_DEVICE_AUTH_CALLBACK_URL,
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USER_CODE_URL,
  OPENAI_DEVICE_AUTH_VERIFICATION_URL,
  OPENAI_TOKEN_URL,
} from "./constants";
import { runOpenAIDeviceOAuth } from "./device-oauth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI device OAuth", () => {
  test("requests a code, reports it, polls, and exchanges the authorization code", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({
        device_auth_id: "device-auth-123",
        user_code: "CODE-1234",
        interval: "0",
      }), { status: 200 }),
      new Response("", { status: 404 }),
      new Response(JSON.stringify({
        authorization_code: "authorization-code-123",
        code_challenge: "challenge-123",
        code_verifier: "verifier-123",
      }), { status: 200 }),
      new Response(JSON.stringify({
        access_token: "access-token-123",
        refresh_token: "refresh-token-123",
        id_token: "id-token-123",
        expires_in: 3600,
      }), { status: 200 }),
    ];
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch");
      return Promise.resolve(response);
    }) as unknown as typeof fetch;

    const prompts: Array<{ verificationUrl: string; userCode: string; expiresInSeconds: number }> = [];
    const progress: string[] = [];
    const result = await runOpenAIDeviceOAuth({
      onProgress: (message) => progress.push(message),
      onDeviceCode: (prompt) => { prompts.push(prompt); },
    });

    expect(result).toMatchObject({
      access_token: "access-token-123",
      refresh_token: "refresh-token-123",
      id_token: "id-token-123",
    });
    expect(prompts).toEqual([{
      verificationUrl: OPENAI_DEVICE_AUTH_VERIFICATION_URL,
      userCode: "CODE-1234",
      expiresInSeconds: 900,
    }]);
    expect(progress).toContain("Waiting for code authorization...");
    expect(requests.map((request) => request.url)).toEqual([
      OPENAI_DEVICE_AUTH_USER_CODE_URL,
      OPENAI_DEVICE_AUTH_TOKEN_URL,
      OPENAI_DEVICE_AUTH_TOKEN_URL,
      OPENAI_TOKEN_URL,
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ client_id: OPENAI_AUTH_CLIENT_ID });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      device_auth_id: "device-auth-123",
      user_code: "CODE-1234",
    });
    expect(String(requests[3]?.init?.body)).toContain(`redirect_uri=${encodeURIComponent(OPENAI_DEVICE_AUTH_CALLBACK_URL)}`);
    expect(String(requests[3]?.init?.body)).toContain("code_verifier=verifier-123");
  });

  test("reports when OpenAI has not enabled code login", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("", { status: 404 }))) as unknown as typeof fetch;

    await expect(runOpenAIDeviceOAuth()).rejects.toThrow(/not available.*browser/i);
  });
});
