import { describe, expect, test } from "bun:test";

import { msUntilNextElapsedSecond } from "./time";

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
