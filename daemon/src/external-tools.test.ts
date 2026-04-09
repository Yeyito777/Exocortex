import { describe, expect, test } from "bun:test";
import type { LoadedTool, Manifest } from "./external-tools";
import { buildDaemonSpawnSpec, getToolReloadKey } from "./external-tools";

function makeTool(overrides: {
  manifest?: Partial<Manifest>;
  binDir?: string;
  toolDir?: string;
} = {}): LoadedTool {
  return {
    manifest: {
      name: "gmail",
      bin: "./bin/gmail",
      systemHint: "hint",
      display: { label: "Gmail", color: "#4ddbb7" },
      ...overrides.manifest,
    },
    binDir: overrides.binDir ?? "/tmp/tools/bin",
    toolDir: overrides.toolDir ?? "/tmp/tools/gmail",
  };
}

describe("buildDaemonSpawnSpec", () => {
  test("returns null for blank commands", () => {
    expect(buildDaemonSpawnSpec("")).toBeNull();
    expect(buildDaemonSpawnSpec("   ")).toBeNull();
  });

  test("executes daemon commands through bash -lc", () => {
    expect(buildDaemonSpawnSpec('python -m app --name "my bot"')).toEqual({
      cmd: "bash",
      args: ["-lc", 'python -m app --name "my bot"'],
    });
  });
});

describe("getToolReloadKey", () => {
  test("same tool metadata produces the same reload key", () => {
    const a = [makeTool()];
    const b = [makeTool()];
    expect(getToolReloadKey(a)).toBe(getToolReloadKey(b));
  });

  test("style changes invalidate the reload key", () => {
    const before = [makeTool()];
    const after = [makeTool({ manifest: { display: { label: "Mail", color: "#ff00ff" } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });

  test("daemon config changes invalidate the reload key", () => {
    const before = [makeTool({ manifest: { daemon: { command: "node daemon.js" } } })];
    const after = [makeTool({ manifest: { daemon: { command: "node daemon.js", restart: "always" } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });
});
