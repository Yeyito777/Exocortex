import { afterEach, describe, expect, test } from "bun:test";
import {
  beginDaemonShutdown,
  resetDaemonShutdownModeForTest,
  resolveDaemonShutdownMode,
} from "./daemon-lifecycle";

afterEach(resetDaemonShutdownModeForTest);

describe("daemon shutdown mode", () => {
  test("a normal signal without restart intent is an explicit stop", () => {
    expect(resolveDaemonShutdownMode(0, false)).toBe("stop");
  });

  test("prepared restarts and fatal exits preserve restart recovery", () => {
    expect(resolveDaemonShutdownMode(0, true)).toBe("restart");
    expect(resolveDaemonShutdownMode(1, false)).toBe("restart");
  });

  test("an already-selected mode wins over later signal inference", () => {
    beginDaemonShutdown("stop");
    expect(resolveDaemonShutdownMode(1, true)).toBe("stop");
  });

  test("an explicit stop can cancel stale restart preparation", () => {
    beginDaemonShutdown("restart");
    expect(beginDaemonShutdown("stop")).toBe("stop");
  });
});
