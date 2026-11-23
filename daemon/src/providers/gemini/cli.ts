/**
 * The Antigravity CLI (`agy`), Google's official agent CLI for Google AI
 * Pro/Ultra subscribers, which the gemini provider runs. It owns its Google
 * sign-in; Exocortex never reads its credentials.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readExocortexConfig } from "@exocortex/shared/config";
import { AuthError } from "../errors";
import type { LoginCallbacks } from "../types";

export const AGY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
export const AGY_LOGIN_COMMAND = "agy acp --login";

/**
 * Environment that would move the CLI off the subscription: a Gemini API key
 * or Vertex/Agent Platform credentials. Stripped, so turns always bill the
 * owner's Google AI plan.
 */
const NON_SUBSCRIPTION_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

export function agyBinary(): string {
  const override = process.env.EXOCORTEX_AGY_BIN?.trim();
  if (override) return override;
  const configured = readExocortexConfig().providers?.gemini?.binary?.trim();
  if (configured) return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  const local = join(homedir(), ".local", "bin", "agy");
  if (existsSync(local)) return local;
  return Bun.which("agy") ?? local;
}

export function hasAgyBinary(): boolean {
  const binary = agyBinary();
  return binary.includes("/") ? existsSync(binary) : Bun.which(binary) !== null;
}

export function agyMissingMessage(): string {
  return `The Antigravity CLI (agy) is not installed. Install it with \`${AGY_INSTALL_COMMAND}\`, then run \`exocortexd login gemini\`.`;
}

/** The CLI's environment: the daemon's, without anything that bills outside the subscription. */
export function agyEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of NON_SUBSCRIPTION_ENV) delete env[key];
  return { ...env, ...extra };
}

export interface AgyCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runAgy(args: string[], options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {}): Promise<AgyCommandResult> {
  if (!hasAgyBinary()) throw new AuthError(agyMissingMessage());
  const proc = Bun.spawn([agyBinary(), ...args], {
    cwd: options.cwd ?? homedir(),
    env: agyEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => { try { proc.kill(); } catch { /* gone */ } };
  const timer = setTimeout(kill, options.timeoutMs ?? 30_000);
  options.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
}

export async function getAgyVersion(): Promise<string | null> {
  try {
    const result = await runAgy(["--version"], { timeoutMs: 10_000 });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Sign in with Google through the CLI itself (`agy acp --login`): it prints a
 * Google sign-in link and reads back the code the page shows, so it needs a
 * terminal.
 */
export async function loginWithAgy(callbacks?: LoginCallbacks): Promise<void> {
  if (!hasAgyBinary()) throw new AuthError(agyMissingMessage());
  callbacks?.onProgress?.("Launching the Antigravity CLI sign-in (Google AI Pro/Ultra)...");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AuthError(`Signing in to Gemini needs a terminal: run \`exocortexd login gemini\` (or \`${AGY_LOGIN_COMMAND}\`) in one, open the link it prints, and paste back the code Google shows.`);
  }
  const result = Bun.spawnSync([agyBinary(), "acp", "--login"], { env: agyEnv(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new AuthError("The Antigravity CLI sign-in failed.");
}
