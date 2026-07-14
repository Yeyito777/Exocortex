import { describe, expect, test } from "bun:test";
import { codexRateLimitHeadersForTest } from "./responses-websocket";

describe("OpenAI websocket rate-limit events", () => {
  test("preserves window duration metadata", () => {
    const headers = codexRateLimitHeadersForTest({
      type: "codex.rate_limits",
      rate_limits: {
        primary: {
          used_percent: 53,
          window_minutes: 10080,
          reset_at: 1784499577,
        },
        secondary: null,
      },
    });

    expect(headers).not.toBeNull();
    expect(headers!.get("x-codex-primary-used-percent")).toBe("53");
    expect(headers!.get("x-codex-primary-window-minutes")).toBe("10080");
    expect(headers!.get("x-codex-primary-reset-at")).toBe("1784499577");
    expect(headers!.get("x-codex-secondary-used-percent")).toBeNull();
  });
});
