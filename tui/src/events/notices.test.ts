import { describe, expect, test } from "bun:test";
import { formatConnectionLostNotice } from "./notices";

describe("connection loss notices", () => {
  test("suppresses the generic notice for an announced daemon restart", () => {
    expect(formatConnectionLostNotice("restart")).toBeNull();
  });

  test("keeps the generic notice for every other disconnect", () => {
    expect(formatConnectionLostNotice("stop")).toBe("✗ Lost connection to daemon.");
    expect(formatConnectionLostNotice(null)).toBe("✗ Lost connection to daemon.");
  });
});
