/**
 * Long-lived tokens of Claude accounts (`claude setup-token`).
 *
 * Anthropic ends a Claude Code login about four weeks after sign-in. A
 * setup-token lasts a year, bills the same subscription and runs the same
 * turns, so an account that has one (accounts.ts `token`) runs its Claude
 * Code processes on it: `CLAUDE_CODE_OAUTH_TOKEN` in the process environment,
 * which Claude Code prefers to the login in its configuration directory and
 * never passes on to the commands its tools run.
 *
 * The token carries the inference scope only. It cannot read the plan's usage
 * report or say whose it is, so:
 * - whether it works is asked with one 1-token request (probeClaudeToken),
 *   whose answer also carries the plan's limits in its headers (usage.ts
 *   reads them) and the organization it belongs to;
 * - a token Anthropic refuses, or one of another organization than the
 *   account's, is set aside (until the secret changes, or a later check
 *   passes) and the account goes back to its own login, if it still has one.
 *
 * The value lives in the secrets store and in this process's memory; it is
 * never logged, written to a file or sent over a /proxy link.
 */

import { createHash } from "node:crypto";
import { log } from "../../log";
import { CLAUDE_TOKEN_WARNING_MS, claudeTokenExpiresAt, getClaudeAccount, type ClaudeAccountToken } from "./accounts";
import { readStoredSecret } from "./api-credits";
import { FALLBACK_ANTHROPIC_MODELS, isFableModel } from "./models";

/** The variable Claude Code reads a setup-token from. */
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** The stored value is read again after this long (at once after a refusal). */
const VALUE_TTL_MS = 5 * 60_000;
/** A refused token is not asked about again for this long, unless the secret changed. */
export const TOKEN_REJECTION_RECHECK_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PURPOSE = "exocortex: Claude turns on a long-lived token";
/** Anthropic serves a subscription token only to requests that open as Claude Code does. */
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const PROBE_MODEL = "claude-haiku-5-5";
const DAY_MS = 86_400_000;

export type ClaudeTokenProbe =
  /** Anthropic took the token (a request at a usage limit counts: it was let in and refused by the plan). */
  | { outcome: "ok"; status: number; headers: Headers; orgId: string | null }
  /** Anthropic refused the token, or it is another organization's. */
  | { outcome: "rejected"; detail: string }
  /** No answer that says either way (network, an overloaded API): what was known before stands. */
  | { outcome: "unknown"; detail: string }
  /** The account has no token, or its secret cannot be read. */
  | { outcome: "no_token"; detail: string };

/** Where the value and Anthropic's answer come from; tests substitute these. */
export interface ClaudeTokenDeps {
  secret(name: string): Promise<string | null>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** The installed Claude Code's version, for the User-Agent. */
  claudeVersion(): Promise<string | null>;
}

let versionLookup: Promise<string | null> | null = null;

const defaultDeps: ClaudeTokenDeps = {
  secret: name => readStoredSecret(name, PURPOSE),
  fetch: (url, init) => fetch(url, init),
  claudeVersion: () => versionLookup ??= import("./cli").then(cli => cli.getClaudeVersion()).catch(() => null),
};

let deps = defaultDeps;
const values = new Map<string, { value: string; at: number }>();
const loads = new Map<string, Promise<string | null>>();
/** Refused tokens by account: the value's hash, so a new secret is tried at once. */
const rejections = new Map<string, { hash: string; at: number; detail: string }>();
const expiryWarnings = new Map<string, number>();
const rejectionListeners = new Set<(account: string) => void>();

export function setClaudeTokenDepsForTests(next: Partial<ClaudeTokenDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  values.clear();
  loads.clear();
  rejections.clear();
  expiryWarnings.clear();
}

/** Called when an account's token is set aside (auth-cache.ts checks the account's sign-in again). */
export function onClaudeTokenRejected(listener: (account: string) => void): void {
  rejectionListeners.add(listener);
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenOf(account: string): ClaudeAccountToken | null {
  return getClaudeAccount(account)?.token ?? null;
}

function rejectionOf(account: string, value: string, now: number): { at: number; detail: string } | null {
  const rejection = rejections.get(account);
  if (!rejection || rejection.hash !== hashOf(value)) return null;
  return now - rejection.at < TOKEN_REJECTION_RECHECK_MS ? rejection : null;
}

async function loadValue(secret: string, fresh: boolean, now: number): Promise<string | null> {
  const cached = values.get(secret);
  if (cached && !fresh && now - cached.at < VALUE_TTL_MS) return cached.value;
  let load = loads.get(secret);
  if (!load) {
    load = deps.secret(secret).then((value) => {
      // A store that cannot be read just now does not take a working token away.
      if (value) values.set(secret, { value, at: Date.now() });
      return value ?? values.get(secret)?.value ?? null;
    }).catch(() => values.get(secret)?.value ?? null).finally(() => { loads.delete(secret); });
    loads.set(secret, load);
  }
  return load;
}

/** Whether the account has a token (usable or not). */
export function hasClaudeToken(account: string | undefined): boolean {
  return account !== undefined && tokenOf(account) !== null;
}

/**
 * The account's token, if it has one that Anthropic has not refused: read
 * from the secrets store when not in memory yet (or `fresh`).
 */
export async function loadClaudeToken(account: string, options: { fresh?: boolean; now?: number } = {}): Promise<string | null> {
  const token = tokenOf(account);
  if (!token) return null;
  const now = options.now ?? Date.now();
  // After a refusal the secret is read again each time: a new token is tried at once.
  const value = await loadValue(token.secret, options.fresh === true || rejections.has(account), now);
  if (!value) return null;
  return rejectionOf(account, value, now) ? null : value;
}

/** The same from memory alone, for code that cannot wait; starts a read when nothing is there yet. */
export function usableClaudeToken(account: string | undefined, now = Date.now()): string | null {
  if (!account) return null;
  const token = tokenOf(account);
  if (!token) return null;
  const value = values.get(token.secret)?.value;
  if (!value) {
    void loadValue(token.secret, false, now);
    return null;
  }
  return rejectionOf(account, value, now) ? null : value;
}

/** Environment that runs a Claude Code process on the account's token; empty without a usable one (its own login then). */
export function claudeTokenEnv(account: string | undefined): Record<string, string> {
  const value = usableClaudeToken(account);
  return value ? { [CLAUDE_TOKEN_ENV]: value } : {};
}

/** When the account's token was last refused, if it still is set aside. */
export function claudeTokenRejection(account: string, now = Date.now()): { at: number; detail: string } | null {
  const token = tokenOf(account);
  const value = token ? values.get(token.secret)?.value : undefined;
  return value ? rejectionOf(account, value, now) : null;
}

/** Anthropic refused a request signed with the account's token: set it aside. */
export function noteClaudeTokenRejected(account: string, detail: string, now = Date.now()): void {
  const token = tokenOf(account);
  const value = token ? values.get(token.secret)?.value : undefined;
  if (!token || !value) return;
  const hash = hashOf(value);
  const known = rejections.get(account);
  rejections.set(account, { hash, at: now, detail });
  if (known?.hash === hash) return;
  log("warn", `anthropic: Claude account "${account}"'s long-lived token (${token.secret}) was refused: ${detail}. Mint a new one with \`claude setup-token\` and run scripts/claude-account-token ${account}.`);
  for (const listener of rejectionListeners) {
    try { listener(account); } catch { /* best-effort */ }
  }
}

function fableModel(): string | null {
  return FALLBACK_ANTHROPIC_MODELS.find(model => isFableModel(model.id))?.id ?? null;
}

async function errorSummary(response: Response): Promise<{ type: string | null; message: string }> {
  const text = await response.text().catch(() => "");
  try {
    const error = (JSON.parse(text) as { error?: { type?: unknown; message?: unknown } }).error;
    return { type: typeof error?.type === "string" ? error.type : null, message: typeof error?.message === "string" ? error.message.slice(0, 200).replace(/\.+$/, "") : "" };
  } catch {
    return { type: null, message: "" };
  }
}

/** Anthropic's answer to one 1-token request signed with `value`. */
type TokenAnswer =
  | { outcome: "ok"; status: number; headers: Headers; orgId: string | null }
  | { outcome: "rejected"; detail: string; orgId: string | null }
  | { outcome: "unknown"; detail: string };

async function askAnthropic(value: string, model: string, signal?: AbortSignal): Promise<TokenAnswer> {
  let response: Response;
  try {
    const version = await deps.claudeVersion();
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    response = await deps.fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${value}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": `claude-cli/${version ?? "2.1.0"} (external, sdk-ts)`,
        "x-app": "cli",
      },
      body: JSON.stringify({ model, max_tokens: 1, system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }], messages: [{ role: "user", content: "quota" }] }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    return { outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
  const orgId = response.headers.get("anthropic-organization-id");
  // Let in and answered, or let in and refused by the plan's limiter: either way the token was taken.
  if (response.ok || response.headers.has("anthropic-ratelimit-unified-status")) {
    await response.body?.cancel().catch(() => {});
    return { outcome: "ok", status: response.status, headers: response.headers, orgId };
  }
  const error = await errorSummary(response);
  const detail = `HTTP ${response.status}${error.message ? ` ${error.message}` : ""}`;
  if (response.status === 401 || (response.status === 403 && (error.type === "authentication_error" || error.type === "permission_error"))) {
    return { outcome: "rejected", detail, orgId };
  }
  return { outcome: "unknown", detail };
}

const OTHER_ORGANIZATION = "it belongs to another organization than the account's";

function otherOrganization(expected: string | undefined, actual: string | null): boolean {
  return !!expected && !!actual && expected.toLowerCase() !== actual.toLowerCase();
}

/**
 * Ask Anthropic about a token value that is not an account's yet
 * (scripts/claude-account-token, before it records one): whether it is taken,
 * and for which organization.
 */
export async function checkClaudeTokenValue(value: string, expectedOrgId?: string): Promise<TokenAnswer> {
  const answer = await askAnthropic(value, PROBE_MODEL);
  if (answer.outcome === "ok" && otherOrganization(expectedOrgId, answer.orgId)) return { outcome: "rejected", detail: OTHER_ORGANIZATION, orgId: answer.orgId };
  return answer;
}

/**
 * Ask Anthropic whether the account's token works, with one request of one
 * output token (Haiku; the Fable model with `fable`, whose answer carries the
 * Fable allowance). A token already refused is not asked about again within
 * TOKEN_REJECTION_RECHECK_MS.
 */
export async function probeClaudeToken(account: string, options: { fable?: boolean; signal?: AbortSignal; now?: number } = {}): Promise<ClaudeTokenProbe> {
  const token = tokenOf(account);
  if (!token) return { outcome: "no_token", detail: "no long-lived token" };
  const now = options.now ?? Date.now();
  const value = await loadValue(token.secret, rejections.has(account), now);
  if (!value) return { outcome: "no_token", detail: `${token.secret} is not in the secrets store` };
  const rejected = rejectionOf(account, value, now);
  if (rejected) return { outcome: "rejected", detail: rejected.detail };
  const model = options.fable ? fableModel() : PROBE_MODEL;
  if (!model) return { outcome: "unknown", detail: "no Fable model" };
  const answer = await askAnthropic(value, model, options.signal);
  if (answer.outcome === "unknown") return answer;
  if (answer.outcome === "ok" && !otherOrganization(token.orgId, answer.orgId)) {
    // A Fable request says nothing new about the token itself.
    if (!options.fable) rejections.delete(account);
    return answer;
  }
  const detail = answer.outcome === "rejected" ? answer.detail : OTHER_ORGANIZATION;
  noteClaudeTokenRejected(account, detail, now);
  return { outcome: "rejected", detail };
}

/** Days until the account's token ends, once that is within the warning time (negative: past it); null otherwise. */
export function claudeTokenDaysLeft(account: string, now = Date.now()): number | null {
  const token = tokenOf(account);
  if (!token) return null;
  const left = claudeTokenExpiresAt(token) - now;
  return left <= CLAUDE_TOKEN_WARNING_MS ? Math.floor(left / DAY_MS) : null;
}

/** Say in the log, at most daily, that an account's token is about to end. */
export function warnClaudeTokenExpiry(account: string, now = Date.now()): void {
  const days = claudeTokenDaysLeft(account, now);
  if (days === null || now - (expiryWarnings.get(account) ?? 0) < DAY_MS) return;
  expiryWarnings.set(account, now);
  const when = days < 0 ? "is past the year it was issued for" : `ends in ${days} day${days === 1 ? "" : "s"}`;
  log("warn", `anthropic: Claude account "${account}"'s long-lived token ${when}. Mint a new one with \`claude setup-token\` and run scripts/claude-account-token ${account}.`);
}
