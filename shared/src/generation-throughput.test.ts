import { describe, expect, test } from "bun:test";
import { appendGenerationRate, generationTokensPerSecond, GENERATION_RATE_ALPHA } from "./generation-throughput";
import { combineMessageMetadata, type GenerationThroughput } from "./messages";

describe("generation throughput", () => {
  test("uses normalized exponential weights, not combined tokens or durations", () => {
    expect(GENERATION_RATE_ALPHA).toBeCloseTo(2 / 11);
    expect(generationTokensPerSecond({ provider: "openai", model: "model", rates: [100, 200] }))
      .toBeCloseTo(155);
    expect(generationTokensPerSecond({ provider: "openai", model: "model", rates: [200, 100] }))
      .toBeCloseTo(145);
  });

  test("has a hard cutoff of ten and leaves prior snapshots immutable", () => {
    const original: GenerationThroughput = { provider: "openai", model: "model", rates: [10_000] };
    let throughput: GenerationThroughput | undefined = original;
    for (let i = 0; i < 10; i++) throughput = appendGenerationRate(throughput, "openai", "model", 100);
    expect(throughput?.rates).toEqual(Array(10).fill(100));
    expect(generationTokensPerSecond(throughput)).toBeCloseTo(100);
    expect(original.rates).toEqual([10_000]);
    expect(generationTokensPerSecond({ ...original, rates: [10_000, ...Array(10).fill(100)] }))
      .toBeCloseTo(100);
  });

  test("resets on provider/model changes and ignores invalid samples", () => {
    const previous: GenerationThroughput = { provider: "openai", model: "model", rates: [100] };
    expect(appendGenerationRate(previous, "deepseek", "model", 200)?.rates).toEqual([200]);
    expect(appendGenerationRate(previous, "openai", "different", 200)?.rates).toEqual([200]);
    for (const rate of [0, -1, NaN, Infinity]) {
      expect(appendGenerationRate(previous, "openai", "model", rate)).toBe(previous);
    }
    expect(generationTokensPerSecond(undefined)).toBeNull();
    expect(generationTokensPerSecond({ ...previous, rates: [NaN, 0, -1, Infinity] })).toBeNull();
  });

  test("message aggregation uses the latest round history, not a message-level rate", () => {
    const first = {
      startedAt: 0, endedAt: 1_000, model: "model", tokens: 100,
      generationThroughput: { provider: "openai" as const, model: "model", rates: [100] },
    };
    const last = {
      startedAt: 600_000, endedAt: 601_000, model: "model", tokens: 200,
      generationThroughput: { provider: "openai" as const, model: "model", rates: [100, 200] },
    };
    const combined = combineMessageMetadata(first, last);
    expect(combined?.tokens).toBe(300);
    expect(generationTokensPerSecond(combined?.generationThroughput)).toBeCloseTo(155);
  });
});
