/**
 * Thin wrappers around the Claude Code CLI (`claude`).
 *
 * Authentication stays owned by Claude Code. Exocortex only inspects it and
 * makes sure every spawned process bills the Claude subscription rather than
 * an API key that happens to be present in the daemon environment.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createAbortError } from "../../abort";
import type { LoginCallbacks } from "../types";
import { AuthError } from "../errors";
import type { ClaudeAuthStatus } from "./types";

/**
 * The daemon usually runs as a systemd user service whose PATH lacks
 * ~/.local/bin, so also check Claude Code's standard install locations.
 */
function resolveClaudeBinary(): string {
  if (process.env.CLAUDE_CODE_BIN) return process.env.CLAUDE_CODE_BIN;
  const onPath = Bun.which("claude");
  if (onPath) return onPath;
  const home = homedir();
  for (const candidate of [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")]) {
    if (existsSync(candidate)) return candidate;
  }
  return "claude";
}

const CLAUDE_BINARY = resolveClaudeBinary();
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Environment variables that would make Claude Code authenticate with an API
 * key, a third-party cloud, or a proxy instead of the claude.ai subscription.
 */
const NON_SUBSCRIPTION_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export function getClaudeBinary(): string {
  return CLAUDE_BINARY;
}

/** Process environment for Claude Code with API-billing overrides removed. */
export function claudeSubscriptionEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const name of NON_SUBSCRIPTION_ENV_VARS) delete env[name];
  return env;
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
  return "Claude Code (`claude`) is not installed or not on PATH. Install it or set CLAUDE_CODE_BIN.";
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
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([CLAUDE_BINARY, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: claudeSubscriptionEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (isLikelyCommandMissing(error)) throw new AuthError(commandMissingMessage());
    throw error;
  }

  const onAbort = () => {
    try { proc.kill(); } catch { /* best-effort */ }
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
  return output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

export async function getClaudeVersion(signal?: AbortSignal): Promise<string> {
  const result = await runClaudeCommand(["--version"], { signal });
  if (result.exitCode !== 0) {
    throw new AuthError(combinedOutput(result) || "Failed to determine Claude Code version.");
  }
  const version = parseClaudeVersion(combinedOutput(result));
  if (!version) throw new AuthError("Claude Code is installed but its version output could not be parsed.");
  return version;
}

export function parseClaudeAuthStatus(text: string): ClaudeAuthStatus {
  const trimmed = text.trim();
  if (!trimmed) return { loggedIn: false };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const str = (value: unknown) => typeof value === "string" ? value : undefined;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: str(parsed.authMethod),
      apiProvider: str(parsed.apiProvider),
      email: str(parsed.email),
      orgId: str(parsed.orgId),
      orgName: str(parsed.orgName),
      subscriptionType: str(parsed.subscriptionType),
    };
  } catch {
    const lower = trimmed.toLowerCase();
    return { loggedIn: !(lower.includes("not logged in") || lower.includes("login required") || lower.includes("unauthenticated")) };
  }
}

/** True when Claude Code is signed in with a claude.ai subscription (not an API key or cloud provider). */
export function isSubscriptionAuth(status: ClaudeAuthStatus): boolean {
  return status.loggedIn
    && status.authMethod === "claude.ai"
    && (status.apiProvider === undefined || status.apiProvider === "firstParty");
}

export async function getClaudeAuthStatus(signal?: AbortSignal): Promise<ClaudeAuthStatus> {
  const result = await runClaudeCommand(["auth", "status", "--json"], { signal });
  // `claude auth status` exits non-zero when logged out but still prints JSON.
  const parsed = parseClaudeAuthStatus(result.stdout);
  if (result.exitCode === 0 || result.stdout.trim().startsWith("{")) return parsed;
  if (combinedOutput(result).toLowerCase().includes("not logged in")) return { loggedIn: false };
  throw new AuthError(combinedOutput(result) || "Failed to query Claude Code authentication status.");
}

export function getClaudeAuthStatusSync(): ClaudeAuthStatus | null {
  try {
    const result = Bun.spawnSync([CLAUDE_BINARY, "auth", "status", "--json"], {
      cwd: process.cwd(),
      env: claudeSubscriptionEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    if (result.exitCode === 0 || stdout.trim().startsWith("{")) return parseClaudeAuthStatus(stdout);
    return null;
  } catch {
    return null;
  }
}

const URL_RE = /https:\/\/\S+/;

/**
 * Run `claude auth login --claudeai`. In a terminal the CLI runs
 * interactively; otherwise its sign-in URL is forwarded to the caller.
 */
export async function loginWithClaudeCli(callbacks?: LoginCallbacks): Promise<void> {
  callbacks?.onProgress?.("Launching Claude Code login (Claude subscription)...");
  const args = [CLAUDE_BINARY, "auth", "login", "--claudeai"];

  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const result = Bun.spawnSync(args, { env: claudeSubscriptionEnv(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      if (result.exitCode !== 0) throw new AuthError("Claude Code login failed.");
      return;
    } catch (error) {
      if (isLikelyCommandMissing(error)) throw new AuthError(commandMissingMessage());
      throw error;
    }
  }

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(args, { env: claudeSubscriptionEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    if (isLikelyCommandMissing(error)) throw new AuthError(commandMissingMessage());
    throw error;
  }

  let urlSent = false;
  const output: string[] = [];
  const watch = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output.push(text);
      const url = urlSent ? null : URL_RE.exec(text)?.[0];
      if (url) {
        urlSent = true;
        const opened = await callbacks?.onOpenUrl?.(url);
        if (opened !== true) callbacks?.onProgress?.(`Open this URL to sign in to Claude: ${url}`);
      }
    }
  };
  const timeout = setTimeout(() => { try { proc.kill(); } catch { /* best-effort */ } }, LOGIN_TIMEOUT_MS);
  try {
    const [, , exitCode] = await Promise.all([watch(proc.stdout), watch(proc.stderr), proc.exited]);
    if (exitCode !== 0) {
      throw new AuthError(`Claude Code login failed. Run \`claude auth login\` in a terminal instead.\n${output.join("").trim()}`.trim());
    }
  } finally {
    clearTimeout(timeout);
  }
}
