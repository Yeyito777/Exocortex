import { describe, expect, test } from "bun:test";
import { ProviderGenerationTimer, generationThroughputForTurn } from "./generation-throughput";
import type { StoredMessage } from "./messages";

describe("per-request generation timing", () => {
  test("counts TTFT plus generation, with millisecond precision and no tool time", () => {
    let now = 0;
    const timer = new ProviderGenerationTimer(() => now);
    timer.reset();
    now += 2_000; // TTFT
    now += 1_000; // generation
    expect(timer.rate(300)).toBe(100);
    now += 3_600_000; // tools and inter-round work
    timer.reset();
    now += 250;
    expect(timer.rate(50)).toBe(200);
  });

  test("does not pollute throughput with retry waits or unknown/invalid usage", () => {
    let now = 0;
    const timer = new ProviderGenerationTimer(() => now);
    timer.reset();
    expect(timer.rate(10)).toBeNull();
    now = 1_000;
    for (const tokens of [undefined, 0, -1, NaN, Infinity]) expect(timer.rate(tokens)).toBeNull();
    timer.retry();
    now += 60_000;
    expect(timer.rate(100)).toBeNull();
    timer.reset();
    now += 1_000;
    expect(timer.rate(100)).toBe(100);
  });

  test("carries persisted samples across human messages but not model/provider changes", () => {
    const throughput = { provider: "openai" as const, model: "model", rates: [100, 200] };
    const messages: StoredMessage[] = [
      { role: "assistant", content: "previous", metadata: {
        startedAt: 0, endedAt: 1_000, model: "model", tokens: 300, generationThroughput: throughput,
      } },
      { role: "user", content: "next", metadata: null },
    ];
    expect(generationThroughputForTurn(messages, "openai", "model")).toBe(throughput);
    expect(generationThroughputForTurn(messages, "deepseek", "model")).toBeUndefined();
    expect(generationThroughputForTurn(messages, "openai", "different")).toBeUndefined();
  });
});
