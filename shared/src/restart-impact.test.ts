import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { changesAffectDaemon, classifyChangedPath, daemonImportClosure, runtimeFingerprint } from "./restart-impact";

const root = resolve(dirname(import.meta.path), "../..");
const hasCommit = (sha: string) => {
  try { execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, stdio: "ignore" }); return true; } catch { return false; }
};

describe("path classification", () => {
  test.each([
    ["daemon/src/handler.ts", "source"],
    ["shared/src/config.ts", "source"],
    ["tui/src/sidebar.ts", "source"],
    ["daemon/src/handler.test.ts", "ignore"],
    ["tui/src/sidebar-tree.test.ts", "ignore"],
    ["test/setup-config.ts", "ignore"],
    ["docs/README.md", "ignore"],
    ["README.md", "ignore"],
    ["tui/package.json", "ignore"],
    ["scripts/dev/exotest", "ignore"],
    ["scripts/windows/exocortex.bat", "ignore"],
    ["package.json", "restart"],
    ["bun.lock", "restart"],
    ["bunfig.toml", "restart"],
    ["daemon/package.json", "restart"],
    ["shared/package.json", "restart"],
    ["daemon/src/prompt.md", "restart"],
    ["config/system.md", "restart"],
    ["bin/exocortexd", "restart"],
    ["external-tools/foo/bin/foo", "restart"],
    ["helper-tools/bar/tool", "restart"],
    ["scripts/setup/run-daemon.sh", "restart"],
    ["something/unknown.bin", "restart"],
  ])("%s -> %s", (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected as ReturnType<typeof classifyChangedPath>);
  });
});

describe("runtime fingerprint", () => {
  test("ignores type-only and comment-only edits", () => {
    const before = "export interface A { x: number }\nexport const y = 1;\n";
    const after = "/** doc */\nexport interface A { x: number; z?: \"a\" | \"b\" } // new\nexport const y = 1;\n";
    expect(runtimeFingerprint("a.ts", after)).toBe(runtimeFingerprint("a.ts", before));
  });
  test("sees value, import and enum changes", () => {
    const base = runtimeFingerprint("a.ts", "export const y = 1;\n");
    expect(runtimeFingerprint("a.ts", "export const y = 2;\n")).not.toBe(base);
    expect(runtimeFingerprint("a.ts", "export const y = 1;\nexport enum E { A }\n")).not.toBe(base);
  });
});

describe("daemon import closure", () => {
  test("follows daemon imports into shared, never into tui", async () => {
    const closure = await daemonImportClosure(root);
    expect(closure.has("daemon/src/main.ts")).toBe(true);
    expect(closure.has("shared/src/config.ts")).toBe(true);
    expect(closure.has("shared/src/updatecheck.ts")).toBe(true);
    // Reached only through a relative import from shared/src/work-timer.
    expect(closure.has("shared/src/work-timer.ts")).toBe(true);
    expect([...closure].some(file => file.startsWith("tui/") || file.endsWith(".test.ts"))).toBe(false);
  });
});

describe("real commits", () => {
  const real = hasCommit("dcf225f3") && hasCommit("5f684e06") && hasCommit("72620648") && hasCommit("c0fcf8df");
  const check = real ? test : test.skip;
  check("TUI folder tree merge (type-only shared/config.ts change) needs no daemon restart", async () => {
    const closure = await daemonImportClosure(root);
    expect(await changesAffectDaemon(root, "5f684e06", "dcf225f3", closure)).toBe(false);
  });
  check("Claude multi-account merge restarts the daemon", async () => {
    const closure = await daemonImportClosure(root);
    expect(await changesAffectDaemon(root, "72620648", "c0fcf8df", closure)).toBe(true);
  });
  test("an unknown commit or identical commits", async () => {
    const closure = await daemonImportClosure(root);
    expect(await changesAffectDaemon(root, "0".repeat(40), "HEAD", closure)).toBe(true);
    expect(await changesAffectDaemon(root, "HEAD", "HEAD", closure)).toBe(false);
  });
});
