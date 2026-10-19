import { describe, expect, test } from "bun:test";

import { handleFatalError } from "./fatal";

describe("fatal error handling", () => {
  test("logs the stack and restores the terminal before printing, so the trace stays visible", () => {
    const calls: string[] = [];
    const error = new Error("boom in a key handler");
    handleFatalError("uncaught exception", error, {
      log: message => calls.push(`log:${message}`),
      restoreTerminal: () => calls.push("restore"),
      writeStderr: text => calls.push(`stderr:${text}`),
      exit: code => calls.push(`exit:${code}`),
      logPath: "/tmp/exocortex-tui.log",
    });
    expect(calls.map(call => call.split(":")[0])).toEqual(["log", "restore", "stderr", "exit"]);
    expect(calls[0]).toContain("boom in a key handler");
    expect(calls[0]).toContain("fatal.test.ts");
    expect(calls[2]).toContain("Exocortex TUI crashed (uncaught exception)");
    expect(calls[2]).toContain("/tmp/exocortex-tui.log");
    expect(calls[3]).toBe("exit:1");
  });

  test("still prints and exits when logging or restoring throws", () => {
    const calls: string[] = [];
    handleFatalError("unhandled rejection", "plain reason", {
      log: () => { throw new Error("disk full"); },
      restoreTerminal: () => { throw new Error("EIO"); },
      writeStderr: text => calls.push(text),
      exit: code => calls.push(`exit:${code}`),
      logPath: "x",
    });
    expect(calls[0]).toContain("plain reason");
    expect(calls[1]).toBe("exit:1");
  });
});
