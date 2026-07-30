import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LoadedTool, Manifest } from "./external-tools";
import {
  buildDaemonSpawnSpec,
  getDaemonStatePaths,
  getExternalToolHints,
  getExternalToolWatchTargets,
  getToolReloadKey,
  isLikelyManagedDaemonPid,
  killProcessGroup,
  reapStaleManagedDaemonPid,
  shouldSuperviseExternalToolDaemons,
} from "./external-tools";
import { rewriteExternalToolShellCommandForToolsWithAuth } from "./external-tools-shell";
import { ExternalToolDaemonSupervisor } from "./external-tools-daemon";

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

  test("executes daemon commands through bash -lc and replaces the wrapper", () => {
    expect(buildDaemonSpawnSpec('python -m app --name "my bot"')).toEqual({
      cmd: "bash",
      args: ["-lc", 'exec python -m app --name "my bot"'],
    });
  });

  test("tracks the daemon process instead of a persistent shell wrapper", async () => {
    if (process.platform !== "linux") return;

    const spec = buildDaemonSpawnSpec("sleep 30");
    if (!spec) throw new Error("missing daemon spawn spec");
    const child = spawn(spec.cmd, spec.args, { stdio: "ignore", detached: true });
    if (!child.pid) throw new Error("failed to spawn daemon command");

    try {
      await Bun.sleep(50);
      expect(readFileSync(`/proc/${child.pid}/comm`, "utf-8").trim()).toBe("sleep");
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already dead */ }
      await waitForPidExit(child.pid);
    }
  });
});

describe("external-tool daemon supervision scope", () => {
  test("main instance supervises daemons by default", () => {
    expect(shouldSuperviseExternalToolDaemons(null, undefined)).toBe(true);
  });

  test("linked worktrees leave shared daemons to the main instance", () => {
    expect(shouldSuperviseExternalToolDaemons("feature-preview", undefined)).toBe(false);
  });

  test("explicit environment override wins", () => {
    expect(shouldSuperviseExternalToolDaemons("feature-preview", "1")).toBe(true);
    expect(shouldSuperviseExternalToolDaemons(null, "0")).toBe(false);
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

  test("waits for and force-kills descendants after the group leader exits", async () => {
    if (process.platform !== "linux") return;

    const root = mkdtempSync(join(tmpdir(), "exo-daemon-descendant-"));
    const childPidPath = join(root, "child.pid");
    const leader = spawn("bash", ["-c", [
      'trap "exit 0" TERM',
      `bash -c 'trap "" TERM; echo $$ > "${childPidPath}"; exec sleep 30' &`,
      "wait",
    ].join("\n")], {
      cwd: root,
      stdio: "ignore",
      detached: true,
    });
    if (!leader.pid) throw new Error("failed to spawn descendant test group");

    try {
      const deadline = Date.now() + 2_000;
      while (!existsSync(childPidPath) && Date.now() < deadline) await Bun.sleep(10);
      const descendantPid = Number.parseInt(readFileSync(childPidPath, "utf-8").trim(), 10);

      await killProcessGroup(leader.pid, "test daemon group", {
        pollMs: 10,
        forceKillMs: 50,
        bailMs: 1_000,
      });

      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try { process.kill(-leader.pid, "SIGKILL"); } catch { /* already dead */ }
      try { await waitForPidExit(leader.pid); } catch { /* leader already reaped by Bun */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supervisor cleans orphaned descendants before leaving an exited daemon stopped", async () => {
    if (process.platform !== "linux") return;

    const root = mkdtempSync(join(tmpdir(), "exo-daemon-exit-cleanup-"));
    const childPidPath = join(root, "child.pid");
    const supervisor = new ExternalToolDaemonSupervisor();
    const tool = makeTool({
      toolDir: root,
      manifest: {
        name: "orphan-test",
        daemon: {
          command: `bash -c 'sleep 30 & echo $! > "${childPidPath}"; exit 1'`,
          restart: "never",
        },
      },
    });

    try {
      supervisor.setInitialTools([tool]);
      supervisor.startConfiguredDaemons();

      const deadline = Date.now() + 2_000;
      while (!existsSync(childPidPath) && Date.now() < deadline) await Bun.sleep(10);
      const descendantPid = Number.parseInt(readFileSync(childPidPath, "utf-8").trim(), 10);
      await waitForPidExit(descendantPid, 2_000);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      await supervisor.stopAll();
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

  test("daemon config changes invalidate the reload key", () => {
    const before = [makeTool({ manifest: { daemon: { command: "node daemon.js" } } })];
    const after = [makeTool({ manifest: { daemon: { command: "node daemon.js", restart: "always" } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });

  test("auth config changes invalidate the reload key", () => {
    const before = [makeTool()];
    const after = [makeTool({ manifest: { auth: { providers: ["openai"] } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });
});

describe("getExternalToolHints", () => {
  test("prefixes every external tool hint with its tool name", () => {
    const hints = getExternalToolHints([
      makeTool({ manifest: { name: "gmail", systemHint: "Gmail hint" } }),
      makeTool({ manifest: { name: "image", systemHint: "Image hint" } }),
    ]);

    expect(hints).toBe([
      "#gmail",
      "Gmail hint",
      "#image",
      "Image hint",
    ].join("\n"));
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

describe("external-tool auth arg injection", () => {
  const image = makeTool({
    manifest: {
      name: "image",
      bin: "./bin/image",
      display: { label: "Image", color: "#ffb86c" },
      auth: { providers: ["openai"] },
    },
    toolDir: "/tmp/tools/image",
  });

  test("injects quoted auth args after the external-tool command", async () => {
    await expect(rewriteExternalToolShellCommandForToolsWithAuth(
      "image generate --json",
      [image],
      async () => ["--exocortex-auth-openai", "token with spaces"],
    )).resolves.toBe("image '--exocortex-auth-openai' 'token with spaces' generate --json");
  });

  test("injects auth args in chains while leaving other commands unchanged", async () => {
    await expect(rewriteExternalToolShellCommandForToolsWithAuth(
      "echo setup && image generate --json >/tmp/result.json",
      [image],
      async () => ["--exocortex-auth-openai", "token"],
    )).resolves.toBe(
      "echo setup && image '--exocortex-auth-openai' 'token' generate --json >/tmp/result.json",
    );
  });

  test("does not rewrite tools when no auth args are requested", async () => {
    const command = "image generate --json";
    await expect(rewriteExternalToolShellCommandForToolsWithAuth(
      command,
      [image],
      async () => [],
    )).resolves.toBe(command);
  });
});
