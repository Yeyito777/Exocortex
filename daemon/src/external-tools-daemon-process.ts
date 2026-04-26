import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { log } from "./log";

export function buildDaemonSpawnSpec(command: string): { cmd: string; args: string[] } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  return { cmd: "bash", args: ["-lc", trimmed] };
}

export function getDaemonStatePaths(toolDir: string): { configDir: string; logPath: string; pidPath: string } {
  const configDir = join(toolDir, "config");
  return {
    configDir,
    logPath: join(configDir, "service.log"),
    pidPath: join(configDir, "service.pid"),
  };
}

export function clearDaemonPidFile(toolDir: string): void {
  const { pidPath } = getDaemonStatePaths(toolDir);
  try {
    unlinkSync(pidPath);
  } catch {
    // already gone / best-effort cleanup
  }
}

function resolveExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function writeDaemonPidFile(toolDir: string, pid: number): void {
  const { configDir, pidPath } = getDaemonStatePaths(toolDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(pidPath, `${pid}\n`);
}

export function isLikelyManagedDaemonPid(pid: number, toolDir: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") return false;

  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const cwd = resolveExistingPath(readlinkSync(`/proc/${pid}/cwd`));
    if (cwd !== resolveExistingPath(toolDir)) return false;

    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return false;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const pgid = Number.parseInt(fields[2] ?? "", 10); // state, ppid, pgrp
    return Number.isInteger(pgid) && pgid === pid;
  } catch {
    return false;
  }
}

export function killProcessGroup(pid: number, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let bailTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (bailTimer) clearTimeout(bailTimer);
      resolve();
    };

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      settle();
      return;
    }

    pollTimer = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        settle();
      }
    }, 100);
    pollTimer.unref?.();

    forceKillTimer = setTimeout(() => {
      log("warn", `external-tools: force-killing ${label} (pgid ${pid})`);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already dead
      }
    }, 5_000);
    forceKillTimer.unref?.();

    bailTimer = setTimeout(() => {
      log("warn", `external-tools: giving up waiting for ${label} (pid ${pid})`);
      settle();
    }, 7_000);
    bailTimer.unref?.();
  });
}

export async function reapStaleManagedDaemonPid(toolDir: string, toolName: string): Promise<boolean> {
  const { pidPath } = getDaemonStatePaths(toolDir);
  if (!existsSync(pidPath)) return false;

  let pid: number | null = null;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  } catch {
    // Treat unreadable/corrupt files as stale.
  }

  if (!pid || !isLikelyManagedDaemonPid(pid, toolDir)) {
    clearDaemonPidFile(toolDir);
    return false;
  }

  log("warn", `external-tools: reaping stale daemon '${toolName}' from previous exocortexd run (pgid ${pid})`);
  await killProcessGroup(pid, `stale daemon '${toolName}'`);
  clearDaemonPidFile(toolDir);
  return true;
}
