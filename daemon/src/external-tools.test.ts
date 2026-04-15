import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LoadedTool, Manifest } from "./external-tools";
import {
  buildDaemonSpawnSpec,
  getDaemonStatePaths,
  getExternalToolWatchTargets,
  getToolReloadKey,
  isLikelyManagedDaemonPid,
  reapStaleManagedDaemonPid,
  rewriteExternalToolShellCommand,
} from "./external-tools";

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

async function waitForPidExit(pid: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

function spawnDetachedSleep(cwd: string): number {
  const child = spawn("bash", ["-lc", "exec sleep 30"], {
    cwd,
    stdio: "ignore",
    detached: true,
  });
  if (!child.pid) throw new Error("failed to spawn detached sleep");
  return child.pid;
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

describe("managed daemon state", () => {
  test("derives service log and pid file paths under config/", () => {
    expect(getDaemonStatePaths("/tmp/tools/discord")).toEqual({
      configDir: "/tmp/tools/discord/config",
      logPath: "/tmp/tools/discord/config/service.log",
      pidPath: "/tmp/tools/discord/config/service.pid",
    });
  });

  test("recognizes detached daemon pids rooted in a tool dir", async () => {
    if (process.platform === "win32") return;

    const root = mkdtempSync(join(tmpdir(), "exo-daemon-pid-"));
    const pid = spawnDetachedSleep(root);
    try {
      expect(isLikelyManagedDaemonPid(pid, root)).toBe(true);
      expect(isLikelyManagedDaemonPid(pid, join(root, "other"))).toBe(false);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
      await waitForPidExit(pid);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reaps stale daemon pids recorded in service.pid", async () => {
    if (process.platform === "win32") return;

    const root = mkdtempSync(join(tmpdir(), "exo-daemon-reap-"));
    const { configDir, pidPath } = getDaemonStatePaths(root);
    mkdirSync(configDir, { recursive: true });

    const pid = spawnDetachedSleep(root);
    writeFileSync(pidPath, `${pid}\n`);

    try {
      expect(await reapStaleManagedDaemonPid(root, "discord")).toBe(true);
      expect(existsSync(pidPath)).toBe(false);
      await waitForPidExit(pid);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
      rmSync(root, { recursive: true, force: true });
    }
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

  test("shell config changes invalidate the reload key", () => {
    const before = [makeTool({ manifest: { shell: { literalArgs: [{ subcommand: "send", kind: "tail" }] } } })];
    const after = [makeTool({ manifest: { shell: { literalArgs: [{ subcommand: "send", kind: "tail" }, { subcommand: "dm", kind: "flag", flag: "--send" }] } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });

  test("daemon config changes invalidate the reload key", () => {
    const before = [makeTool({ manifest: { daemon: { command: "node daemon.js" } } })];
    const after = [makeTool({ manifest: { daemon: { command: "node daemon.js", restart: "always" } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });
});

describe("getExternalToolWatchTargets", () => {
  test("watches only the root and immediate child directories", () => {
    const root = mkdtempSync(join(tmpdir(), "exo-tools-"));
    try {
      mkdirSync(join(root, "discord-cli", "config", "captcha", "chromium-profile"), { recursive: true });
      mkdirSync(join(root, "exo-cli"), { recursive: true });
      writeFileSync(join(root, "README.md"), "not a directory");

      expect(getExternalToolWatchTargets(root)).toEqual([
        root,
        join(root, "discord-cli"),
        join(root, "exo-cli"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("rewriteExternalToolShellCommand", () => {
  const discord = makeTool({
    manifest: {
      name: "discord",
      bin: "./bin/discord",
      display: { label: "Discord", color: "#5865F2" },
      shell: {
        literalArgs: [
          { subcommand: "send", kind: "tail" },
          { subcommand: "reply", kind: "tail" },
          { subcommand: "edit", kind: "tail" },
          { subcommand: "dm", kind: "flag", flag: "--send" },
        ],
      },
    },
    toolDir: "/tmp/tools/discord",
  });

  test("rewrites the trailing literal argument for configured tail rules", () => {
    const command = 'discord send general "```ts\nconst x = \\\"$HOME\\\"\n```"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord send general '```ts\nconst x = \"$HOME\"\n```'");
  });

  test("rewrites flagged literal arguments for configured commands", () => {
    const command = 'discord dm 123 --send "$HOME"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord dm 123 --send '$HOME'");
  });

  test("rewrites inline flag assignments for configured commands", () => {
    const command = 'discord dm 123 --send="$HOME"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord dm 123 --send='$HOME'");
  });

  test("preserves embedded single quotes in rewritten literals", () => {
    const command = 'discord reply 123 456 "it' + "'" + 's fine"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord reply 123 456 'it'\\''s fine'");
  });

  test("supports leading environment assignments", () => {
    const command = 'DEBUG=1 discord dm 123 --send "$USER"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("DEBUG=1 discord dm 123 --send '$USER'");
  });

  test("leaves unsupported complex shell commands alone", () => {
    const command = 'discord dm 123 --send "$HOME" | tee /tmp/out.txt';
    expect(rewriteExternalToolShellCommand(command, [discord])).toBe(command);
  });

  test("leaves unconfigured subcommands alone", () => {
    const command = 'discord react 123 456 👍';
    expect(rewriteExternalToolShellCommand(command, [discord])).toBe(command);
  });

  test("leaves flag rules alone when the flag has no value", () => {
    const command = 'discord dm 123 --send --file note.txt';
    expect(rewriteExternalToolShellCommand(command, [discord])).toBe(command);
  });
});
