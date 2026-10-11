import { describe, expect, test } from "bun:test";
import { FAST_LOCAL_RECONNECT_ATTEMPTS, FAST_LOCAL_RECONNECT_MS, reconnectDelayMs, SLOW_RECONNECT_MS } from "./reconnect-delay";

describe("reconnectDelayMs", () => {
  test("retries a local daemon briskly while a restart is likely in progress", () => {
    expect(reconnectDelayMs(0, false)).toBe(FAST_LOCAL_RECONNECT_MS);
    expect(reconnectDelayMs(FAST_LOCAL_RECONNECT_ATTEMPTS - 1, false)).toBe(FAST_LOCAL_RECONNECT_MS);
  });

  test("backs off to the slow step for a daemon that stays down", () => {
    expect(reconnectDelayMs(FAST_LOCAL_RECONNECT_ATTEMPTS, false)).toBe(SLOW_RECONNECT_MS);
  });

  test("keeps SSH reconnects at the slow step since each spawns ssh", () => {
    expect(reconnectDelayMs(0, true)).toBe(SLOW_RECONNECT_MS);
  });
});
