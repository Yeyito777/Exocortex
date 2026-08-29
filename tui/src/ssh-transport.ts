/** TUI-owned SSH transport for connecting directly to a remote daemon proxy. */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const STDERR_LIMIT = 8 * 1024;
const PROBE_OUTPUT_LIMIT = 1024 * 1024;
export const DEFAULT_SSH_PROBE_TIMEOUT_MS = 15_000;

export interface SshProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnSshProcess = (alias: string) => SshProcess;

export function sshProxyArgs(alias: string): string[] {
  return [
    "-T",
    // The protocol is large, repetitive JSON (a real sidebar can exceed 1 MB).
    // Let the persistent SSH transport compress it instead of paying that cost
    // on every bootstrap, conversation open, and legacy snapshot.
    "-C",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    alias,
    "exocortexd", "proxy",
  ];
}

export function spawnSshProxy(alias: string): SshProcess {
  return spawn("ssh", sshProxyArgs(alias), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}

export function validateSshAlias(alias: string): string | null {
  if (!alias) return "SSH alias cannot be empty.";
  if (alias.length > 255) return "SSH alias is too long.";
  // Destinations are deliberately narrower than arbitrary ssh arguments. This
  // blocks option injection and keeps /ssh tied to named OpenSSH config hosts.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    return "SSH alias may contain only letters, numbers, dots, underscores, and hyphens.";
  }
  return null;
}

export function appendSshStderr(current: string, chunk: Buffer | string): string {
  const next = current + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  return next.length <= STDERR_LIMIT ? next : next.slice(next.length - STDERR_LIMIT);
}

export function sshStderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? `: ${trimmed}` : "";
}

export interface ProbedSshConnection {
  process: SshProcess;
  /** Protocol bytes received after the matching pong in the same data chunk. */
  bufferedStdout: string;
  stderr: string;
}

export interface SshProbe {
  promise: Promise<ProbedSshConnection>;
  cancel(reason: string): void;
}

export interface SshProbeOptions {
  spawnProcess?: SpawnSshProcess;
  timeoutMs?: number;
}

/**
 * Verify that an alias reaches an Exocortex daemon before replacing the TUI's
 * current route. On success ownership of the already-authenticated process is
 * transferred to the caller so switching routes does not pay a second SSH
 * handshake. The stream is paused and detached from the probe before resolving.
 */
export function probeSshProxy(alias: string, options: SshProbeOptions = {}): SshProbe {
  const spawnProcess = options.spawnProcess ?? spawnSshProxy;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_PROBE_TIMEOUT_MS;
  let cancelProbe = (_reason: string): void => {};

  const promise = new Promise<ProbedSshConnection>((resolve, reject) => {
    let process: SshProcess;
    try {
      process = spawnProcess(alias);
    } catch (error) {
      reject(error);
      return;
    }

    const reqId = `ssh_probe_${randomUUID()}`;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const onStderr = (chunk: Buffer | string) => { stderr = appendSshStderr(stderr, chunk); };
    const onStdout = (chunk: Buffer | string) => {
      if (settled) return;
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdout.length > PROBE_OUTPUT_LIMIT) {
        finish(new Error("remote daemon returned too much data before the probe response"));
        return;
      }
      let newline: number;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type === "pong" && event.reqId === reqId) {
            finish();
            return;
          }
        } catch {
          finish(new Error("remote proxy wrote non-protocol data to stdout"));
          return;
        }
      }
    };
    const onProcessError = (error: Error) => finish(new Error(`${error.message}${sshStderrSuffix(stderr)}`));
    const onProcessClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const result = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      finish(new Error(`SSH proxy closed before the daemon replied (${result})${sshStderrSuffix(stderr)}`));
    };
    const onStdinError = (error: Error) => finish(new Error(
      `cannot write SSH probe: ${error.message}${sshStderrSuffix(stderr)}`,
    ));

    const detach = () => {
      process.stderr.off("data", onStderr);
      process.stdout.off("data", onStdout);
      process.off("error", onProcessError);
      process.off("close", onProcessClose);
      process.stdin.off("error", onStdinError);
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      if (error) {
        try { process.kill(); } catch { /* already gone */ }
        reject(error);
        return;
      }
      process.stdout.pause();
      process.stderr.pause();
      resolve({ process, bufferedStdout: stdout, stderr });
    };

    cancelProbe = reason => finish(new Error(reason));
    process.stderr.on("data", onStderr);
    process.stdout.on("data", onStdout);
    process.once("error", onProcessError);
    process.once("close", onProcessClose);
    process.stdin.once("error", onStdinError);
    timer = setTimeout(() => finish(new Error(
      `timed out after ${Math.ceil(timeoutMs / 1000)}s${sshStderrSuffix(stderr)}`,
    )), timeoutMs);
    timer.unref?.();
    try {
      process.stdin.write(`${JSON.stringify({ type: "ping", reqId })}\n`);
    } catch (error) {
      finish(new Error(
        `cannot write SSH probe: ${error instanceof Error ? error.message : String(error)}${sshStderrSuffix(stderr)}`,
      ));
    }
  });

  return {
    promise,
    cancel: reason => cancelProbe(reason),
  };
}
