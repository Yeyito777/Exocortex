import { describe, expect, test } from "bun:test";

import { formatHoursMinutesUntil, msUntilHoursMinutesUpdate, msUntilNextElapsedSecond } from "./time";

describe("msUntilNextElapsedSecond", () => {
  test("waits a full second when exactly on a boundary", () => {
    expect(msUntilNextElapsedSecond(1_000, 1_000)).toBe(1_000);
    expect(msUntilNextElapsedSecond(1_000, 2_000)).toBe(1_000);
  });

  test("returns the remaining time to the next elapsed second", () => {
    expect(msUntilNextElapsedSecond(1_000, 1_250)).toBe(750);
    expect(msUntilNextElapsedSecond(1_000, 1_999)).toBe(1);
  });

  test("clamps negative elapsed time", () => {
    expect(msUntilNextElapsedSecond(1_000, 900)).toBe(1_000);
  });
});

describe("hours/minutes countdown", () => {
  test("always includes integer hours and minutes without seconds", () => {
    expect(formatHoursMinutesUntil(10 * 60_000, 0)).toBe("0h 10m");
    expect(formatHoursMinutesUntil(2 * 60 * 60_000 + 34 * 60_000 + 1, 0)).toBe("2h 35m");
    expect(formatHoursMinutesUntil(0, 1)).toBe("0h 0m");
  });

  test("refreshes when the rounded-up minute can change", () => {
    expect(msUntilHoursMinutesUpdate(10 * 60_000, 0)).toBe(60_000);
    expect(msUntilHoursMinutesUpdate(10 * 60_000 + 12_345, 0)).toBe(12_345);
    expect(msUntilHoursMinutesUpdate(1_000, 1_000)).toBeNull();
  });
});
