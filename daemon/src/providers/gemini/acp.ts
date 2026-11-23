/**
 * A minimal Agent Client Protocol (ACP) client over an `agy acp` child
 * process: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *
 * Exocortex is the client (the editor side). It sends initialize,
 * session/new|load, session/set_config_option, session/prompt and
 * session/cancel, and receives session/update notifications plus the agent's
 * own requests (session/request_permission), which `onRequest` answers.
 */

import type { Subprocess } from "bun";
import { log } from "../../log";

export interface AcpRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpError extends Error {
  constructor(readonly method: string, readonly rpc: AcpRpcError) {
    super(rpc.message || `${method} failed (${rpc.code})`);
    this.name = "AcpError";
  }
}

export class AcpClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpClosedError";
  }
}

export type AcpNotificationHandler = (method: string, params: Record<string, unknown>) => void;
export type AcpRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;

export interface AcpProcessOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onNotification: AcpNotificationHandler;
  onRequest: AcpRequestHandler;
  onExit?: (code: number | null, stderrTail: string) => void;
}

const STDERR_TAIL_CHARS = 4000;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class AcpProcess {
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = "";
  private closedError: Error | null = null;
  readonly exited: Promise<number>;

  constructor(private readonly options: AcpProcessOptions) {
    this.proc = Bun.spawn([options.binary, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.readStdout();
    void this.readStderr();
    this.exited = this.proc.exited.then((code) => {
      this.fail(new AcpClosedError(`Antigravity CLI exited (code ${code})${this.stderrTail() ? `: ${this.stderrTail()}` : ""}`));
      options.onExit?.(code, this.stderrTail());
      return code;
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  stderrTail(): string {
    return this.stderr.trim().split("\n").slice(-8).join("\n").slice(-1000);
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closedError) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Stop the process: SIGTERM, then SIGKILL if it lingers. */
  close(): void {
    if (this.proc.exitCode !== null || this.proc.signalCode) return;
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    try { this.proc.kill("SIGTERM"); } catch { /* gone */ }
    const timer = setTimeout(() => {
      try { this.proc.kill("SIGKILL"); } catch { /* gone */ }
    }, 3000);
    timer.unref?.();
    void this.proc.exited.finally(() => clearTimeout(timer));
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      this.proc.stdin.flush();
    } catch (error) {
      this.fail(new AcpClosedError(`Antigravity CLI input closed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch (error) {
      log("warn", `gemini: reading Antigravity CLI output failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.proc.stderr) {
        this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
      }
    } catch { /* closed */ }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log("warn", `gemini: ignoring a non-JSON line from the Antigravity CLI: ${line.slice(0, 200)}`);
      return;
    }
    const method = typeof message.method === "string" ? message.method : null;
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    if (method && message.id !== undefined && message.id !== null) {
      void this.answer(message.id, method, params);
      return;
    }
    if (method) {
      try {
        this.options.onNotification(method, params);
      } catch (error) {
        log("warn", `gemini: handling ${method} failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
      }
      return;
    }
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) pending.reject(new AcpError(pending.method, message.error as AcpRpcError));
    else pending.resolve(message.result ?? {});
  }

  private async answer(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}
