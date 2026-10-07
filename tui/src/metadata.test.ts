import { describe, expect, test } from "bun:test";
import { renderMetadata } from "./metadata";
import { visibleLength } from "./textwidth";
import { theme } from "./theme";

describe("renderMetadata", () => {
  test("uses the response span for throughput and the work stretch for duration", () => {
    const metadata = {
      startedAt: 137_000, endedAt: 177_000, workTimerStartedAt: 3_000,
      model: "gpt-5.5", tokens: 42,
    };
    expect(renderMetadata(metadata)[0]).toContain("Gpt-5.5 | 1.1 tokens/s | 2m 54s");
    expect(renderMetadata({ ...metadata, endedAt: null }, { now: 187_000 })[0])
      .toContain("Gpt-5.5 | 0.8 tokens/s | 3m 4s");
    expect(renderMetadata(metadata, { now: 900_000 })[0]).toContain("2m 54s");
  });
  test("fits metadata and its indent into terminal columns, including Unicode and tiny panes", () => {
    for (const model of ["gpt-6-astra", "模型👩‍💻é-super-long-model-name"]) {
      const metadata = { startedAt: 0, endedAt: 289_000, model, tokens: 3161 };
      for (const diagnostics of [false, true]) {
        const [full] = renderMetadata(metadata, { diagnostics });
        for (let width = 0; width <= visibleLength(full) + 1; width++) {
          const lines = renderMetadata(metadata, { width, diagnostics });
          expect(lines).toHaveLength(1);
          expect(visibleLength(lines[0])).toBeLessThanOrEqual(width);
          expect(lines[0].endsWith(theme.reset)).toBe(true);
          if (width > 0 && width < visibleLength(full)) expect(lines[0]).toContain("…");
          if (width >= visibleLength(full)) expect(lines[0]).toBe(full);
        }
      }
    }
    expect(renderMetadata(null, { width: 24 })).toEqual([]);
  });

  test("renders formatted provider model names", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 4_000,
      model: "deepseek-v4-pro",
      tokens: 123,
    });

    expect(line).toContain("DeepSeek V4 Pro | 41.0 tokens/s | 3s");
  });

  test("renders formatted OpenAI model names", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 3_000,
      model: "gpt-5.4-mini",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4-mini | 21.0 tokens/s | 2s");
  });

  test("renders formatted DeepSeek model names with spaces", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 3_000,
      model: "deepseek-v4-pro",
      tokens: 42,
    });

    expect(line).toContain("DeepSeek V4 Pro | 21.0 tokens/s | 2s");
  });

  test("renders minutes and seconds", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (23 * 60 + 2) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 0.0 tokens/s | 23m 2s");
  });

  test("renders hours", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (1 * 60 * 60 + 2 * 60 + 3) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 0.0 tokens/s | 1h 2m 3s");
  });

  test("renders days", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (1 * 24 * 60 * 60 + 2 * 60 * 60 + 3 * 60 + 4) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 0.0 tokens/s | 1d 2h 3m 4s");
  });

  test("renders weeks", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (2 * 7 * 24 * 60 * 60 + 1 * 24 * 60 * 60 + 23 * 60 * 60 + 23 * 60 + 2) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 0.0 tokens/s | 2w 1d 23h 23m 2s");
  });

  test("keeps elapsed time live when a completed provider round is still active", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 2_000,
      model: "gpt-5.4",
      tokens: 42,
    }, { active: true, now: 6_000 });

    expect(line).toContain("Gpt-5.4 | 8.4 tokens/s | 5s");
  });

  test("hides raw token counts by default without changing stored statistics", () => {
    const metadata = { startedAt: 1_000, endedAt: 3_000, model: "gpt-5.4", tokens: 1234 };
    const original = { ...metadata };
    expect(renderMetadata(metadata)[0]).toContain("Gpt-5.4 | 617.0 tokens/s | 2s");
    expect(renderMetadata(metadata)[0]).not.toContain("1,234 tokens");
    expect(renderMetadata(metadata, { diagnostics: true })[0])
      .toContain("Gpt-5.4 | 617.0 tokens/s | 2s | 1,234 tokens");
    expect(metadata).toEqual(original);
  });

  test("uses millisecond precision for subsecond throughput", () => {
    const metadata = { startedAt: 1_000, endedAt: 1_250, model: "gpt-5.4", tokens: 125 };
    expect(renderMetadata(metadata)[0]).toContain("500.0 tokens/s | 0s");
  });

  test("updates live throughput and freezes completed throughput", () => {
    const metadata = { startedAt: 1_000, endedAt: null, model: "gpt-5.4", tokens: 42 };
    expect(renderMetadata(metadata, { now: 3_000 })[0]).toContain("21.0 tokens/s | 2s");
    expect(renderMetadata(metadata, { now: 5_000 })[0]).toContain("10.5 tokens/s | 4s");
    expect(renderMetadata({ ...metadata, endedAt: 3_000 }, { now: 50_000 })[0])
      .toContain("21.0 tokens/s | 2s");
  });

  test("shows unavailable throughput for nonpositive or invalid response spans", () => {
    for (const endedAt of [1_000, 999, NaN, Infinity]) {
      const metadata = { startedAt: 1_000, endedAt, model: "gpt-5.4", tokens: 42 };
      expect(renderMetadata(metadata)[0]).toContain("— tokens/s");
    }
  });

  test("shows zero throughput for no output, and handles invalid token counts", () => {
    const metadata = { startedAt: 1_000, endedAt: 3_000, model: "gpt-5.4", tokens: 0 };
    expect(renderMetadata(metadata)[0]).toContain("0.0 tokens/s");
    for (const tokens of [-1, NaN, Infinity]) {
      expect(renderMetadata({ ...metadata, tokens })[0]).toContain("— tokens/s");
    }
  });
});
