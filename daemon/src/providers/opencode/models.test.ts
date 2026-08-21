import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchOpenCodeModels } from "./models";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenCode model catalog", () => {
  test("exposes only the compatible Ox Alpha model", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "gpt-5.6-sol" }, { id: "x-preview-f-free" }, { id: "claude-fable-5" }],
    }), { status: 200 }))) as unknown as typeof fetch;

    const models = await fetchOpenCodeModels();
    expect(models).toEqual([expect.objectContaining({
      id: "ox-alpha",
      label: "Ox Alpha",
      maxContext: 1_000_000,
      supportsImages: true,
      defaultEffort: "high",
    })]);
    expect(models[0].supportedEfforts.map((item) => item.effort)).toEqual(["low", "high", "max"]);
  });

  test("withdraws the model when the limited-time preview disappears", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }))) as unknown as typeof fetch;
    expect(await fetchOpenCodeModels()).toEqual([]);
  });
});
