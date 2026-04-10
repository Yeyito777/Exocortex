import { createAbortError } from "../../abort";
import type { LoginCallbacks } from "../types";
import { AuthError } from "../errors";
import type { ClaudeAuthStatus } from "./types";

const CLAUDE_BINARY = process.env.CLAUDE_CODE_BIN || "claude";

export function getClaudeBinary(): string {
  return CLAUDE_BINARY;
}

export interface ClaudeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function combinedOutput(result: ClaudeCommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function commandMissingMessage(): string {
  return "Claude Code (`claude`) is not installed or not on PATH.";
}

function isLikelyCommandMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("enoent") || message.includes("not found") || message.includes("failed to spawn");
}

export async function runClaudeCommand(
  args: readonly string[],
  options: { signal?: AbortSignal; cwd?: string } = {},
): Promise<ClaudeCommandResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([CLAUDE_BINARY, ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
  } catch (error) {
    if (isLikelyCommandMissing(error)) {
      throw new AuthError(commandMissingMessage());
    }
    throw error;
  }

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // best-effort
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
      throw createAbortError();
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (options.signal?.aborted) throw createAbortError();
    return { stdout, stderr, exitCode };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function parseClaudeVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export async function getClaudeVersion(signal?: AbortSignal): Promise<string> {
  const result = await runClaudeCommand(["--version"], { signal });
  if (result.exitCode !== 0) {
    throw new AuthError(combinedOutput(result) || "Failed to determine Claude Code version.");
  }
  const version = parseClaudeVersion(combinedOutput(result));
  if (!version) {
    throw new AuthError("Claude Code is installed but its version output could not be parsed.");
  }
  return version;
}

export function parseClaudeAuthStatus(text: string): ClaudeAuthStatus {
  const trimmed = text.trim();
  if (!trimmed) return { loggedIn: false };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : undefined,
      apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      orgId: typeof parsed.orgId === "string" ? parsed.orgId : undefined,
      orgName: typeof parsed.orgName === "string" ? parsed.orgName : undefined,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined,
    };
  } catch {
    const lower = trimmed.toLowerCase();
    return {
      loggedIn: !(lower.includes("not logged in") || lower.includes("login required") || lower.includes("unauthenticated")),
    };
  }
}

export async function getClaudeAuthStatus(signal?: AbortSignal): Promise<ClaudeAuthStatus> {
  const result = await runClaudeCommand(["auth", "status", "--json"], { signal });
  if (result.exitCode !== 0) {
    const output = combinedOutput(result);
    if (output.toLowerCase().includes("not logged in")) {
      return { loggedIn: false };
    }
    throw new AuthError(output || "Failed to query Claude Code authentication status.");
  }
  return parseClaudeAuthStatus(result.stdout);
}

export function getClaudeAuthStatusSync(): ClaudeAuthStatus | null {
  try {
    const result = Bun.spawnSync([CLAUDE_BINARY, "auth", "status", "--json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0) {
      const output = `${stdout}\n${stderr}`.trim().toLowerCase();
      if (output.includes("not logged in")) return { loggedIn: false };
      return null;
    }
    return parseClaudeAuthStatus(stdout);
  } catch (error) {
    if (isLikelyCommandMissing(error)) return null;
    return null;
  }
}

export async function loginWithClaudeCli(callbacks?: LoginCallbacks): Promise<void> {
  callbacks?.onProgress?.("Launching Claude Code login...");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AuthError("Anthropic login is managed by Claude Code. Run `claude auth login` in a terminal, then return to Exocortex. If Exocortex still cannot make scripted requests afterward, run `claude setup-token` and put the resulting `CLAUDE_CODE_OAUTH_TOKEN` in Exocortex's secrets env.");
  }

  try {
    const result = Bun.spawnSync([CLAUDE_BINARY, "auth", "login", "--claudeai"], {
      cwd: process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new AuthError("Claude Code login failed.");
    }
  } catch (error) {
    if (isLikelyCommandMissing(error)) {
      throw new AuthError(commandMissingMessage());
    }
    throw error;
  }
}

export function logoutWithClaudeCliSync(): void {
  try {
    const result = Bun.spawnSync([CLAUDE_BINARY, "auth", "logout"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new AuthError(`${result.stdout.toString()}\n${result.stderr.toString()}`.trim() || "Claude Code logout failed.");
    }
  } catch (error) {
    if (isLikelyCommandMissing(error)) {
      throw new AuthError(commandMissingMessage());
    }
    throw error;
  }
}

