import { afterEach, describe, expect, test } from "bun:test";
import {
  beginDaemonShutdown,
  resetDaemonShutdownModeForTest,
  resolveDaemonShutdownMode,
} from "./daemon-lifecycle";

afterEach(resetDaemonShutdownModeForTest);

describe("daemon shutdown mode", () => {
  test("any exit nobody asked to be a stop is a restart (systemctl stop, reboot, stray kill, crash)", () => {
    expect(resolveDaemonShutdownMode(false)).toBe("restart");
  });

  test("a fresh stop request from `exocortexd stop` makes the signal a real stop", () => {
    expect(resolveDaemonShutdownMode(true)).toBe("stop");
  });

  test("an already-selected mode wins over later signal inference", () => {
    beginDaemonShutdown("stop");
    expect(resolveDaemonShutdownMode(false)).toBe("stop");
    resetDaemonShutdownModeForTest();
    beginDaemonShutdown("restart");
    expect(resolveDaemonShutdownMode(true)).toBe("restart");
  });

  test("an explicit stop can cancel stale restart preparation", () => {
    beginDaemonShutdown("restart");
    expect(beginDaemonShutdown("stop")).toBe("stop");
  });
});
