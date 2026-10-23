import { describe, expect, test } from "bun:test";
import { formatFinishTime, localDayKey, msUntilLocalMidnight, renderMetadata } from "./metadata";
import { visibleLength } from "./textwidth";
import { theme } from "./theme";

describe("renderMetadata", () => {
  test("starts fresh and optimistic messages at zero instead of an earlier rate", () => {
    const metadata = { startedAt: 1_000, endedAt: null, model: "gpt-5.4", tokens: 0 };
    expect(renderMetadata(metadata, { now: 1_000 })[0]).toContain("0.0 tokens/s");
    expect(renderMetadata({
      ...metadata,
      generationThroughput: { provider: "openai", model: metadata.model, rates: [] },
    }, { now: 50_000 })[0]).toContain("0.0 tokens/s");
  });

  test("uses measured throughput independently of the response span and work timer", () => {
    const metadata = {
      startedAt: 137_000, endedAt: 177_000, workTimerStartedAt: 3_000,
      model: "gpt-5.5", tokens: 42,
      generationThroughput: { provider: "openai" as const, model: "gpt-5.5", rates: [100] },
    };
    expect(renderMetadata(metadata)[0]).toContain("Gpt-5.5 | 100.0 tokens/s | 2m 54s");
    expect(renderMetadata({ ...metadata, endedAt: null }, { now: 187_000 })[0])
      .toContain("Gpt-5.5 | 100.0 tokens/s | 3m 4s");
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

    expect(line).toContain("DeepSeek V4 Pro | — tokens/s | 3s");
  });

  test("renders formatted OpenAI model names", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 3_000,
      model: "gpt-5.4-mini",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4-mini | — tokens/s | 2s");
  });

  test("renders formatted DeepSeek model names with spaces", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 3_000,
      model: "deepseek-v4-pro",
      tokens: 42,
    });

    expect(line).toContain("DeepSeek V4 Pro | — tokens/s | 2s");
  });

  test("renders minutes and seconds", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (23 * 60 + 2) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | — tokens/s | 23m 2s");
  });

  test("renders hours", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (1 * 60 * 60 + 2 * 60 + 3) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | — tokens/s | 1h 2m 3s");
  });

  test("renders days", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (1 * 24 * 60 * 60 + 2 * 60 * 60 + 3 * 60 + 4) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | — tokens/s | 1d 2h 3m 4s");
  });

  test("renders weeks", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (2 * 7 * 24 * 60 * 60 + 1 * 24 * 60 * 60 + 23 * 60 * 60 + 23 * 60 + 2) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | — tokens/s | 2w 1d 23h 23m 2s");
  });

  test("keeps elapsed time live when a completed provider round is still active", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 2_000,
      model: "gpt-5.4",
      tokens: 42,
    }, { active: true, now: 6_000 });

    expect(line).toContain("Gpt-5.4 | — tokens/s | 5s");
  });

  test("hides raw token counts by default without changing stored statistics", () => {
    const metadata = {
      startedAt: 1_000, endedAt: 3_000, model: "gpt-5.4", tokens: 1234,
      generationThroughput: { provider: "openai" as const, model: "gpt-5.4", rates: [617] },
    };
    const original = structuredClone(metadata);
    expect(renderMetadata(metadata)[0]).toContain("Gpt-5.4 | 617.0 tokens/s | 2s");
    expect(renderMetadata(metadata)[0]).not.toContain("1,234 tokens");
    expect(renderMetadata(metadata, { diagnostics: true })[0])
      .toContain("Gpt-5.4 | 617.0 tokens/s | 2s | 1,234 tokens");
    expect(metadata).toEqual(original);
  });

  test("renders measured throughput even for a subsecond response", () => {
    const metadata = {
      startedAt: 1_000, endedAt: 1_250, model: "gpt-5.4", tokens: 125,
      generationThroughput: { provider: "openai" as const, model: "gpt-5.4", rates: [500] },
    };
    expect(renderMetadata(metadata)[0]).toContain("500.0 tokens/s | 0s");
  });

  test("does not decay measured throughput while tools run or after completion", () => {
    const metadata = {
      startedAt: 1_000, endedAt: null, model: "gpt-5.4", tokens: 42,
      generationThroughput: { provider: "openai" as const, model: "gpt-5.4", rates: [21] },
    };
    expect(renderMetadata(metadata, { now: 3_000 })[0]).toContain("21.0 tokens/s | 2s");
    expect(renderMetadata(metadata, { now: 5_000 })[0]).toContain("21.0 tokens/s | 4s");
    expect(renderMetadata({ ...metadata, endedAt: 3_000 }, { now: 50_000 })[0])
      .toContain("21.0 tokens/s | 2s");
  });

  test("never falls back to output tokens divided by message duration", () => {
    for (const endedAt of [1_000, 999, NaN, Infinity]) {
      const metadata = { startedAt: 1_000, endedAt, model: "gpt-5.4", tokens: 42 };
      expect(renderMetadata(metadata)[0]).toContain("— tokens/s");
    }
  });

  test("only measured round rates affect throughput, not accumulated token counts", () => {
    const metadata = { startedAt: 1_000, endedAt: 3_000, model: "gpt-5.4", tokens: 0 };
    expect(renderMetadata(metadata)[0]).toContain("— tokens/s");
    for (const tokens of [0, 42, 123_456, NaN]) {
      expect(renderMetadata({
        ...metadata, tokens,
        generationThroughput: { provider: "openai", model: metadata.model, rates: [99] },
      })[0]).toContain("99.0 tokens/s");
    }
  });
});

describe("finish time", () => {
  const at = (iso: string) => Date.parse(iso);
  const meta = (endedAt: number | null) => ({ startedAt: endedAt === null ? 0 : endedAt - 109_000, endedAt, model: "claude-opus-5-5", tokens: 1 });

  test("today, yesterday, older, other year, on a 24-hour clock", () => {
    const now = at("2026-10-23T15:30:00Z");
    const f = (iso: string) => formatFinishTime(at(iso), now, "UTC");
    expect(f("2026-10-23T14:03:00Z")).toBe("14:03");
    expect(f("2026-10-23T00:00:00Z")).toBe("00:00");
    expect(f("2026-10-23T23:59:00Z")).toBe("23:59");
    expect(f("2026-10-22T22:41:00Z")).toBe("yesterday 22:41");
    expect(f("2026-10-22T00:00:00Z")).toBe("yesterday 00:00");
    expect(f("2026-10-19T09:12:00Z")).toBe("Oct 19 09:12");
    expect(f("2025-10-19T09:12:00Z")).toBe("Oct 19 2025 09:12");
    expect(f("2026-01-05T13:00:00Z")).toBe("Jan 5 13:00");
  });

  test("midnight edge: 23:59 vs 00:01 and year boundary", () => {
    expect(formatFinishTime(at("2026-10-22T23:59:00Z"), at("2026-10-23T00:01:00Z"), "UTC")).toBe("yesterday 23:59");
    expect(formatFinishTime(at("2026-10-23T00:00:00Z"), at("2026-10-23T00:01:00Z"), "UTC")).toBe("00:00");
    expect(formatFinishTime(at("2025-12-31T23:59:00Z"), at("2026-01-01T00:01:00Z"), "UTC")).toBe("yesterday 23:59");
    expect(formatFinishTime(at("2025-12-30T23:59:00Z"), at("2026-01-01T00:01:00Z"), "UTC")).toBe("Dec 30 2025 23:59");
  });

  test("uses the injected time zone for both the clock and the day boundary", () => {
    const endedAt = at("2026-10-23T03:30:00Z");
    const now = at("2026-10-23T15:30:00Z");
    expect(formatFinishTime(endedAt, now, "UTC")).toBe("03:30");
    expect(formatFinishTime(endedAt, now, "America/Toronto")).toBe("yesterday 23:30");
    expect(formatFinishTime(endedAt, now, "Asia/Tokyo")).toBe("yesterday 12:30");
    expect(formatFinishTime(endedAt, now, "America/Panama")).toBe("yesterday 22:30");
    expect(renderMetadata(meta(endedAt), { now, timeZone: "America/Toronto" })[0]).toContain("| yesterday 23:30");
    expect(renderMetadata(meta(endedAt), { now, timeZone: "Asia/Tokyo" })[0]).toContain("| yesterday 12:30");
  });

  test("day count survives a DST change", () => {
    // Toronto fell back on 2026-11-01.
    expect(formatFinishTime(at("2026-11-01T12:00:00Z"), at("2026-11-02T20:00:00Z"), "America/Toronto")).toBe("yesterday 07:00");
    expect(formatFinishTime(at("2026-10-31T23:30:00Z"), at("2026-11-02T20:00:00Z"), "America/Toronto")).toBe("Oct 31 19:30");
  });

  test("appended last, after duration and diagnostics tokens", () => {
    const now = at("2026-10-23T15:30:00Z");
    const endedAt = at("2026-10-23T14:03:00Z");
    expect(renderMetadata(meta(endedAt), { now, timeZone: "UTC" })[0]).toContain("Opus-5.5 | — tokens/s | 1m 49s | 14:03");
    expect(renderMetadata(meta(endedAt), { now, timeZone: "UTC", diagnostics: true })[0]).toContain("| 1 tokens | 14:03");
  });

  test("no segment without a timestamp, while live, or when active", () => {
    const now = at("2026-10-23T15:30:00Z");
    const live = renderMetadata(meta(null), { now, timeZone: "UTC" })[0];
    expect(live).toContain("tokens/s");
    expect(live.match(/\|/g)).toHaveLength(2);
    expect(renderMetadata(meta(at("2026-10-23T14:03:00Z")), { now, timeZone: "UTC", active: true })[0].match(/\|/g)).toHaveLength(2);
    expect(formatFinishTime(undefined, now, "UTC")).toBeNull();
    expect(formatFinishTime(null, now, "UTC")).toBeNull();
    expect(formatFinishTime(Number.NaN, now, "UTC")).toBeNull();
  });

  test("truncates like the rest of the line without exceeding the width", () => {
    const now = at("2026-10-23T15:30:00Z");
    const metadata = meta(at("2026-10-19T09:12:00Z"));
    const [full] = renderMetadata(metadata, { now, timeZone: "UTC" });
    expect(full).toContain("| Oct 19 09:12");
    for (let width = 1; width <= visibleLength(full); width++) {
      const [line] = renderMetadata(metadata, { now, timeZone: "UTC", width });
      expect(visibleLength(line)).toBeLessThanOrEqual(width);
    }
  });

  test("local day key and midnight timer", () => {
    expect(localDayKey(at("2026-10-23T03:30:00Z"), "America/Toronto")).not.toBe(localDayKey(at("2026-10-23T05:30:00Z"), "America/Toronto"));
    expect(localDayKey(at("2026-10-23T01:00:00Z"), "UTC")).toBe(localDayKey(at("2026-10-23T23:00:00Z"), "UTC"));
    expect(msUntilLocalMidnight(at("2026-10-23T23:59:30Z"), "UTC")).toBe(30_000);
    expect(msUntilLocalMidnight(at("2026-10-23T00:00:00Z"), "UTC")).toBe(24 * 3_600_000);
  });
});
