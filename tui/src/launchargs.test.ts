import { describe, expect, test } from "bun:test";
import { applyTuiLaunchOptions, parseTuiLaunchArgs } from "./launchargs";

describe("TUI launch arguments", () => {
  test("parses SSH aliases in separated and equals forms", () => {
    expect(parseTuiLaunchArgs(["--ssh", "whale"]).sshAlias).toBe("whale");
    expect(parseTuiLaunchArgs(["--ssh=workbox"]).sshAlias).toBe("workbox");
  });

  test("retains the startup profiler and help options", () => {
    expect(parseTuiLaunchArgs(["--profile-startup", "--help"])).toEqual({
      sshAlias: null,
      profileStartup: true,
      showHelp: true,
    });
  });

  test("rejects missing, invalid, duplicate, and unknown arguments", () => {
    expect(() => parseTuiLaunchArgs(["--ssh"])).toThrow("--ssh requires an SSH alias.");
    expect(() => parseTuiLaunchArgs(["--ssh", "--help"])).toThrow("--ssh requires an SSH alias.");
    expect(() => parseTuiLaunchArgs(["--ssh=bad alias"])).toThrow("Invalid --ssh alias");
    expect(() => parseTuiLaunchArgs(["--ssh", "whale", "--ssh=workbox"])).toThrow("--ssh may only be specified once.");
    expect(() => parseTuiLaunchArgs(["--wat"])).toThrow("Unknown option: --wat");
  });

  test("automatically invokes the same client route action as /ssh", () => {
    const calls: Array<{ action: string; alias: string }> = [];
    const daemon = {
      ssh(action: "connect", alias: string) {
        calls.push({ action, alias });
      },
    };

    applyTuiLaunchOptions(parseTuiLaunchArgs([]), daemon);
    applyTuiLaunchOptions(parseTuiLaunchArgs(["--ssh", "whale"]), daemon);

    expect(calls).toEqual([{ action: "connect", alias: "whale" }]);
  });
});
