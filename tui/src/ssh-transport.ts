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
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnSshProcess = (alias: string) => SshProcess;

export function sshProxyArgs(alias: string): string[] {
  return [
    "-T",
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

export interface SshProbe {
  promise: Promise<void>;
  cancel(reason: string): void;
}

export interface SshProbeOptions {
  spawnProcess?: SpawnSshProcess;
  timeoutMs?: number;
}

/**
 * Verify that an alias reaches an Exocortex daemon before replacing the TUI's
 * current route. The probe owns a short-lived SSH process and never exposes its
 * protocol stream to the application event handler.
 */
export function probeSshProxy(alias: string, options: SshProbeOptions = {}): SshProbe {
  const spawnProcess = options.spawnProcess ?? spawnSshProxy;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_PROBE_TIMEOUT_MS;
  let cancelProbe = (_reason: string): void => {};

  const promise = new Promise<void>((resolve, reject) => {
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
    const timer = setTimeout(() => finish(new Error(
      `timed out after ${Math.ceil(timeoutMs / 1000)}s${sshStderrSuffix(stderr)}`,
    )), timeoutMs);
    timer.unref?.();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.kill(); } catch { /* already gone */ }
      if (error) reject(error);
      else resolve();
    };

    cancelProbe = reason => finish(new Error(reason));
    process.stderr.on("data", chunk => { stderr = appendSshStderr(stderr, chunk); });
    process.stdout.on("data", chunk => {
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
    });
    process.once("error", error => finish(new Error(`${error.message}${sshStderrSuffix(stderr)}`)));
    process.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const result = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      finish(new Error(`SSH proxy closed before the daemon replied (${result})${sshStderrSuffix(stderr)}`));
    });
    process.stdin.once("error", error => finish(new Error(
      `cannot write SSH probe: ${error.message}${sshStderrSuffix(stderr)}`,
    )));
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
