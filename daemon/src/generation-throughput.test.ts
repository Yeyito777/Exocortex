import { describe, expect, test } from "bun:test";
import { ProviderGenerationTimer } from "./generation-throughput";

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
});
