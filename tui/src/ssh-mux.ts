/**
 * Connection reuse for /ssh and --ssh: every session to an alias shares one
 * OpenSSH connection through a private ControlMaster socket, kept for
 * SSH_CONTROL_PERSIST after its last session, so a later launch or reconnect
 * skips the handshake (most of a cold /ssh start).
 *
 * The socket lives in `<runtime>/ssh/` (mode 0700), or a private per-user
 * directory under the system temp dir when that path is too long for a Unix
 * socket. Anything running as this user can open sessions through it without
 * authenticating while it exists — which that user could already do with the
 * same SSH keys and agent. See docs/ssh-connection-reuse.md.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeDir } from "@exocortex/shared/paths";
import { spawnSshProxy, type SshConnectionReuse, type SshProbeFallback, type SshProcess } from "@exocortex/shared/ssh-transport";

export const SSH_CONTROL_PERSIST = "10m";
/** A session through an existing master without a pong by then also tries a fresh connection. */
export const SSH_MASTER_FALLBACK_MS = 2_500;
/**
 * ssh binds the master at the path plus a 17-character temporary suffix and
 * renames it; sun_path holds 104 bytes on macOS.
 */
const MAX_CONTROL_PATH_BYTES = 80;

/** A directory only this user can enter, or null when it can't be made so. */
function privateDirectory(path: string): string | null {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isDirectory() || (uid !== null && info.uid !== uid)) return null;
    if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700);
    return path;
  } catch {
    return null;
  }
}

/** The private control socket for `alias`, or null to connect without reuse. */
export function sshControlPath(alias: string, runtime = runtimeDir(), temp = tmpdir()): string | null {
  if (process.platform === "win32") return null;
  const preferred = join(runtime, "ssh", `${alias}.sock`);
  if (Buffer.byteLength(preferred) <= MAX_CONTROL_PATH_BYTES && !/[\s"'\\]/.test(preferred)) {
    return privateDirectory(join(runtime, "ssh")) ? preferred : null;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const directory = privateDirectory(join(temp, `exocortex-ssh-${uid}`));
  if (!directory) return null;
  const name = createHash("sha256").update(`${runtime}\0${alias}`).digest("hex").slice(0, 16);
  const path = join(directory, `${name}.sock`);
  return Buffer.byteLength(path) <= MAX_CONTROL_PATH_BYTES && !/[\s"'\\]/.test(path) ? path : null;
}

function reuseFor(alias: string): SshConnectionReuse | null {
  const controlPath = sshControlPath(alias);
  return controlPath ? { controlPath, persist: SSH_CONTROL_PERSIST } : null;
}

/** Sessions spawned onto a master that already existed (it may have lost its connection). */
const viaExistingMaster = new WeakSet<SshProcess>();

/** `ssh ALIAS exocortexd proxy` through this alias's shared connection, creating it if needed. */
export function spawnReusingSshProxy(alias: string): SshProcess {
  const reuse = reuseFor(alias);
  const existing = reuse !== null && existsSync(reuse.controlPath);
  const process = spawnSshProxy(alias, reuse ?? undefined);
  if (existing) viaExistingMaster.add(process);
  return process;
}

/** Ask this alias's master to exit; its sessions close. Fire and forget. */
export function closeSshMaster(alias: string): void {
  const controlPath = sshControlPath(alias);
  if (!controlPath || !existsSync(controlPath)) return;
  try {
    const child = spawn("ssh", ["-o", `ControlPath=${controlPath.replaceAll("%", "%%")}`, "-O", "exit", alias], {
      stdio: "ignore", detached: true, windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch { /* nothing to close */ }
}

/**
 * For a probe riding an existing master: a fresh, unshared connection after
 * SSH_MASTER_FALLBACK_MS. When it wins, the old master is told to exit so
 * the next connection makes a healthy one.
 */
export function sshProbeFallback(alias: string, primary: SshProcess): SshProbeFallback | null {
  if (!viaExistingMaster.has(primary)) return null;
  return {
    afterMs: SSH_MASTER_FALLBACK_MS,
    spawnProcess: target => spawnSshProxy(target),
    onUsed: () => closeSshMaster(alias),
  };
}
