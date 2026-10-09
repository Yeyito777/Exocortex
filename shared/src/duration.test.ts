import { describe, expect, test } from "bun:test";
import { isDurationMs, parseDurationMs } from "./duration";

describe("duration parser", () => {
  test("parses single-unit and compound durations", () => {
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("1.5m")).toBe(90_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1m20s")).toBe(80_000);
    expect(parseDurationMs("2h 30m")).toBe(9_000_000);
    expect(parseDurationMs("1d 4h 15m 250ms")).toBe(101_700_250);
    expect(parseDurationMs("1M 20S")).toBe(80_000);
  });

  test("rejects malformed, sub-millisecond, and excessive durations", () => {
    expect(parseDurationMs("later")).toBeNull();
    expect(parseDurationMs("1m, 20s")).toBeNull();
    expect(parseDurationMs("1m and 20s")).toBeNull();
    expect(parseDurationMs("0.1ms")).toBeNull();
    expect(parseDurationMs("999999999999999999999d")).toBeNull();
  });

  test("accepts only positive whole-millisecond wire durations", () => {
    expect(isDurationMs(1)).toBe(true);
    expect(isDurationMs(777_600_000)).toBe(true);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5m", null]) {
      expect(isDurationMs(value)).toBe(false);
    }
  });
});
