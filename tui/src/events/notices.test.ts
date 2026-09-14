import { describe, expect, test } from "bun:test";
import { formatConnectionLostNotice } from "./notices";

describe("connection loss notices", () => {
  test("shows the generic notice for an announced daemon restart", () => {
    expect(formatConnectionLostNotice("restart")).toBe("✗ Lost connection to daemon. Reconnecting…");
  });

  test("shows the generic notice for every other disconnect", () => {
    expect(formatConnectionLostNotice("stop")).toBe("✗ Lost connection to daemon. Reconnecting…");
    expect(formatConnectionLostNotice(null)).toBe("✗ Lost connection to daemon. Reconnecting…");
  });
});
