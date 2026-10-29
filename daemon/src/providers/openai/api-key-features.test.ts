import { afterEach, describe, expect, mock, test } from "bun:test";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { resolveModelTokenPricing } from "@exocortex/shared/token-pricing";
import { clearProviderAuth, saveProviderAuth } from "../../store";
import { ensureAuthenticated, setOpenAIBrowserOAuthForTest } from "./auth";
import { openAIApiKeyAccountKey } from "./api-key";
import { apiKeyCredit, estimateApiKeyRequestCostUsd, recordApiKeyUsage, resetApiKeyUsageForTest, setApiKeyUsageRecordedListener } from "./api-key-usage";
import {
  OPENAI_API_IMAGE_GENERATIONS_URL,
  OPENAI_API_MODELS_URL,
  OPENAI_API_TRANSCRIPTIONS_URL,
  OPENAI_TRANSCRIBE_URL,
} from "./constants";
import { apiImageModels, generateImage } from "./image-generation";
import { apiTranscriptionModels, apiUploadFilename, transcribeAudio } from "./transcription";
import { getLastUsage, handleUsageHeaders, OPENAI_USAGE_ACCOUNT_KEY_HEADER, refreshRemoteUsage } from "./usage";
import type { StoredOpenAIAuth } from "./session";

const originalFetch = globalThis.fetch;
const API_KEY = "sk-proj-test-key-0123456789abcdef";
const KEY_MODELS = ["gpt-5.4-mini", "gpt-transcribe", "whisper-1", "gpt-image-2.5-sunburst", "gpt-image-1"];

interface Call { url: string; init?: RequestInit }

/** /v1/models answers for the key; `handler` answers everything else. */
function mockFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    if (call.url === OPENAI_API_MODELS_URL) {
      return new Response(JSON.stringify({ data: KEY_MODELS.map((id) => ({ id })) }), { status: 200 });
    }
    return handler(call);
  }) as unknown as typeof fetch;
  return calls;
}

async function loginWithKey(): Promise<void> {
  await ensureAuthenticated(undefined, { apiKey: API_KEY });
}

function chatGPTAuth(): StoredOpenAIAuth {
  return {
    tokens: {
      accessToken: "chatgpt-access",
      refreshToken: "chatgpt-refresh",
      expiresAt: Date.now() + 60 * 60_000,
      scopes: [],
      subscriptionType: "pro",
      rateLimitTier: null,
    },
    profile: null,
    updatedAt: new Date().toISOString(),
    source: "oauth",
    authMode: null,
    accountId: "acct_one",
    idToken: null,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setOpenAIBrowserOAuthForTest(null);
  clearProviderAuth("openai");
  clearProviderAuth("openai-api-key");
  resetApiKeyUsageForTest();
});

describe("transcription on an API key", () => {
  test("uses the best transcription model the key lists, with an upload name the API accepts", async () => {
    let form: FormData | null = null;
    const calls = mockFetch(async ({ init }) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ text: " hello there ", usage: { type: "tokens", input_tokens: 40, output_tokens: 3 } }), { status: 200 });
    });
    await loginWithKey();

    await expect(transcribeAudio(new Uint8Array([1, 2, 3]), "audio/ogg", { filename: "voice.opus" })).resolves.toBe("hello there");
    const call = calls.find((candidate) => candidate.url === OPENAI_API_TRANSCRIPTIONS_URL)!;
    expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(form!.get("model")).toBe("gpt-transcribe");
    expect((form!.get("file") as File).name).toBe("voice.ogg");
    expect(calls.some((candidate) => candidate.url.startsWith(OPENAI_TRANSCRIBE_URL))).toBe(false);
    expect(getLastUsage()?.apiKey?.today).toMatchObject({ requests: 1, inputTokens: 40, outputTokens: 3, unpricedRequests: 1 });
  });

  test("falls back to the next model when one is rejected", async () => {
    const models: unknown[] = [];
    mockFetch(async ({ init }) => {
      const model = (init?.body as FormData).get("model");
      models.push(model);
      return model === "gpt-transcribe"
        ? new Response(JSON.stringify({ error: { message: "The model `gpt-transcribe` does not exist" } }), { status: 404 })
        : new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    });
    await loginWithKey();
    await expect(transcribeAudio(new Uint8Array([1]), "audio/wav")).resolves.toBe("ok");
    expect(models).toEqual(["gpt-transcribe", "whisper-1"]);
  });

  test("a valid ChatGPT session keeps using the subscription's transcription", async () => {
    const calls = mockFetch(async ({ url }) => url === OPENAI_TRANSCRIBE_URL
      ? new Response(JSON.stringify({ text: "via chatgpt" }), { status: 200 })
      : new Response("{}", { status: 200 }));
    await loginWithKey();
    // A ChatGPT login after the key makes it the selected method again.
    saveProviderAuth("openai", chatGPTAuth());
    saveProviderAuth("openai-api-key", { apiKey: API_KEY, label: "x", active: false, models: KEY_MODELS, updatedAt: new Date().toISOString() });

    await expect(transcribeAudio(new Uint8Array([1]), "audio/wav")).resolves.toBe("via chatgpt");
    expect(calls.some((call) => call.url === OPENAI_API_TRANSCRIPTIONS_URL)).toBe(false);
  });

  test("model and file-name selection", () => {
    expect(apiTranscriptionModels(["whisper-1", "gpt-4o-transcribe", "gpt-transcribe"])).toEqual(["gpt-transcribe", "gpt-4o-transcribe", "whisper-1"]);
    expect(apiTranscriptionModels([])).toEqual(["gpt-transcribe"]);
    expect(apiUploadFilename("clip.m4a", "audio/mp4")).toBe("clip.m4a");
    expect(apiUploadFilename(undefined, "audio/wav")).toBe("audio.wav");
    expect(apiUploadFilename("memo", "audio/webm;codecs=opus")).toBe("memo.webm");
    expect(apiUploadFilename("odd.caf", "audio/x-caf")).toBe("odd.caf");
  });
});

describe("image generation on an API key", () => {
  test("uses the best GPT Image model the key lists, and moves on when the organization cannot use one", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    mockFetch(async ({ url, init }) => {
      expect(url).toBe(OPENAI_API_IMAGE_GENERATIONS_URL);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.model === "gpt-image-2.5-sunburst") {
        return new Response(JSON.stringify({ error: { message: "Your organization must be verified to use the model `gpt-image-2.5-sunburst`." } }), { status: 403 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }], usage: { input_tokens: 10, output_tokens: 272 } }), { status: 200 });
    });
    await loginWithKey();

    await expect(generateImage("a red circle")).resolves.toEqual({ imageBase64: "aW1hZ2U=", revisedPrompt: null });
    expect(bodies.map((body) => body.model)).toEqual(["gpt-image-2.5-sunburst", "gpt-image-1"]);
    expect(bodies[1]).toEqual({ model: "gpt-image-1", prompt: "a red circle", n: 1 });
    expect(getLastUsage()?.apiKey?.today).toMatchObject({ requests: 1, outputTokens: 272, unpricedRequests: 1 });
  });

  test("model selection", () => {
    expect(apiImageModels(["gpt-image-1", "gpt-image-2.5-flare", "dall-e-3"])).toEqual(["gpt-image-2.5-flare", "gpt-image-1"]);
    expect(apiImageModels([])).toEqual(["gpt-image-2.5-sunburst"]);
  });
});

describe("API-key usage", () => {
  test("replaces plan windows with the key's counted spend, priced from the published table", async () => {
    mockFetch(() => new Response("unexpected", { status: 500 }));
    await loginWithKey();
    const accountKey = openAIApiKeyAccountKey(API_KEY);
    recordApiKeyUsage(accountKey, { model: "gpt-5.4-mini", inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 500 });
    recordApiKeyUsage(accountKey, { model: "gpt-image-1", inputTokens: 10, outputTokens: 272 });

    const pricing = resolveModelTokenPricing("gpt-5.4-mini")!;
    const expected = (6_000 * pricing.inputUsdPerMillion! + 4_000 * pricing.cachedInputUsdPerMillion! + 500 * pricing.outputUsdPerMillion!) / 1_000_000;
    const usage = getLastUsage();
    expect(usage?.fiveHour).toBeNull();
    expect(usage?.sevenDay).toBeNull();
    expect(usage?.apiKey?.label).toBe("sk-proj-…cdef");
    expect(usage?.apiKey?.today.requests).toBe(2);
    expect(usage?.apiKey?.today.unpricedRequests).toBe(1);
    expect(usage?.apiKey?.today.estimatedCostUsd).toBeCloseTo(expected, 10);
    expect(usage?.apiKey?.month).toEqual(usage?.apiKey?.today);
    // No ChatGPT usage request is made for a key.
    await expect(refreshRemoteUsage()).resolves.toEqual(usage);
    expect(estimateApiKeyRequestCostUsd({ model: "gpt-image-1", outputTokens: 1 })).toBeNull();

    const onUpdate = mock(() => {});
    handleUsageHeaders(new Headers({ [OPENAI_USAGE_ACCOUNT_KEY_HEADER]: accountKey, "x-codex-primary-used-percent": "50" }), onUpdate);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("tells the daemon after every counted request, with the new totals already readable", async () => {
    mockFetch(() => new Response("unexpected", { status: 500 }));
    await loginWithKey();
    const accountKey = openAIApiKeyAccountKey(API_KEY);
    const seen: Array<[string, number | undefined]> = [];
    setApiKeyUsageRecordedListener((key) => seen.push([key, getLastUsage()?.apiKey?.today.requests]));
    try {
      recordApiKeyUsage(accountKey, { model: "gpt-5.4-mini", inputTokens: 100, outputTokens: 10 });
      recordApiKeyUsage(accountKey, { model: "gpt-image-1", outputTokens: 272 });
      recordApiKeyUsage(null, { model: "gpt-5.4-mini", inputTokens: 100 });
      expect(seen).toEqual([[accountKey, 1], [accountKey, 2]]);
    } finally {
      setApiKeyUsageRecordedListener(null);
    }
  });

  test("a credit grant counts the spend since it and the pace over the last week", () => {
    resetApiKeyUsageForTest();
    const accountKey = "api-key:credit-test";
    const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
    const grant = { amountUsd: 1000, since: "2026-10-20", expires: "2027-10-20" };
    const price = (tokens: number) => estimateApiKeyRequestCostUsd({ model: "gpt-5.4-mini", inputTokens: tokens })!;

    // No history yet.
    expect(apiKeyCredit(accountKey, grant, at(28))).toEqual({
      amountUsd: 1000, since: "2026-10-20", expires: "2027-10-20", asOf: "2026-10-28",
      usedUsd: 0, firstTrackedDay: null, paceUsd: 0, paceDays: 0,
    });

    // Before the grant: not counted. Oct 22 and 28: counted; Oct 22 is outside the last 7 days of Oct 29.
    recordApiKeyUsage(accountKey, { model: "gpt-5.4-mini", inputTokens: 5_000_000, timestamp: at(18) });
    recordApiKeyUsage(accountKey, { model: "gpt-5.4-mini", inputTokens: 1_000_000, timestamp: at(22) });
    recordApiKeyUsage(accountKey, { model: "gpt-transcribe", timestamp: at(23) }); // unpriced, still a tracked day
    recordApiKeyUsage(accountKey, { model: "gpt-5.4-mini", inputTokens: 2_000_000, timestamp: at(28, 23) });

    // Partial history: the ledger starts Oct 22, so the pace is over Oct 22–28 (7 days).
    const oct28 = apiKeyCredit(accountKey, grant, at(28));
    expect(oct28).toMatchObject({ firstTrackedDay: "2026-10-22", paceDays: 7, asOf: "2026-10-28" });
    expect(oct28.usedUsd).toBeCloseTo(price(3_000_000), 10);
    expect(oct28.paceUsd).toBeCloseTo(price(3_000_000), 10);

    // Oct 29: the last 7 days are Oct 23–29.
    const oct29 = apiKeyCredit(accountKey, grant, at(29));
    expect(oct29.paceDays).toBe(7);
    expect(oct29.paceUsd).toBeCloseTo(price(2_000_000), 10);
    expect(oct29.usedUsd).toBeCloseTo(price(3_000_000), 10);

    // Two days in: the pace is over those two.
    const oct23 = apiKeyCredit(accountKey, grant, at(23));
    expect(oct23).toMatchObject({ paceDays: 2, firstTrackedDay: "2026-10-22" });
    expect(oct23.usedUsd).toBeCloseTo(price(1_000_000), 10);
    resetApiKeyUsageForTest();
  });

  test("carries providers.openai.credit when valid, re-read on every update", async () => {
    mockFetch(() => new Response("unexpected", { status: 500 }));
    await loginWithKey();
    try {
      writeExocortexConfig({});
      expect(getLastUsage()?.apiKey?.credit).toBeNull();
      writeExocortexConfig({ providers: { openai: { monthlyBudgetUsd: 20, credit: { amountUsd: 1000, since: "2026-10-20", expires: "2027-10-20" } } } });
      expect(getLastUsage()?.apiKey?.credit).toMatchObject({ amountUsd: 1000, since: "2026-10-20", expires: "2027-10-20", usedUsd: 0 });
      expect(getLastUsage()?.apiKey?.monthlyBudgetUsd).toBe(20);
      writeExocortexConfig({ providers: { openai: { credit: { amountUsd: 1000, since: "2026-10-20" } } } });
      expect(getLastUsage()?.apiKey?.credit?.expires).toBeNull();
      writeExocortexConfig({ providers: { openai: { credit: { amountUsd: 0, since: "2026-10-20" } } } });
      expect(getLastUsage()?.apiKey?.credit).toBeNull();
      writeExocortexConfig({ providers: { openai: { credit: { amountUsd: 1000, since: "Oct 20" } } } });
      expect(getLastUsage()?.apiKey?.credit).toBeNull();
    } finally {
      writeExocortexConfig({});
    }
  });

  test("carries providers.openai.monthlyBudgetUsd, re-read on every update", async () => {
    mockFetch(() => new Response("unexpected", { status: 500 }));
    await loginWithKey();
    try {
      writeExocortexConfig({});
      expect(getLastUsage()?.apiKey?.monthlyBudgetUsd).toBeNull();
      writeExocortexConfig({ providers: { openai: { monthlyBudgetUsd: 20 } } });
      expect(getLastUsage()?.apiKey?.monthlyBudgetUsd).toBe(20);
      writeExocortexConfig({ providers: { openai: { monthlyBudgetUsd: -5 } } });
      expect(getLastUsage()?.apiKey?.monthlyBudgetUsd).toBeNull();
    } finally {
      writeExocortexConfig({});
    }
  });
});
