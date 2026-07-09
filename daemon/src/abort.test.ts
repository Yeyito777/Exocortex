import { describe, expect, test } from "bun:test";
import { DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE, formatToolAbortMessage, toolTimeoutReason } from "./abort";

describe("formatToolAbortMessage", () => {
  test("keeps normal user interrupts explicit", () => {
    const ac = new AbortController();
    ac.abort();

    expect(formatToolAbortMessage(ac.signal, "3.2")).toBe("User interrupted after 3.2s of execution.");
  });

  test("keeps watchdog timeouts explicit", () => {
    const ac = new AbortController();
    ac.abort("watchdog");

    expect(formatToolAbortMessage(ac.signal, "10.0")).toBe("Watchdog timed out after 10.0s (stream was inactive too long).");
  });

  test("identifies per-tool deadlines separately from user and stream aborts", () => {
    const ac = new AbortController();
    ac.abort(toolTimeoutReason("glob", 30_000));

    expect(formatToolAbortMessage(ac.signal, "30.0")).toBe(
      'Tool "glob" timed out after 30.0s (deadline 30s). Narrow the path/pattern or split the operation into smaller calls.',
    );
  });

  test("explains daemon restart tool interruption honestly", () => {
    const ac = new AbortController();
    ac.abort("daemon-restart");

    expect(formatToolAbortMessage(ac.signal, "1.0")).toBe(DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE);
    expect(formatToolAbortMessage(ac.signal, "1.0")).toBe(
      "Tool interrupted because the Exocortex daemon restarted. The tool call may have partially or fully completed before interruption; inspect current state and continue from there.",
    );
  });
});
