/**
 * Claude's limit resets read from claude.ai, for accounts whose Claude Code
 * usage report leaves them out.
 *
 * Claude Code's `/usage` report carries the account's reset grants as
 * `cedar_ember`, but Claude Code 2.1.321 sends it null. claude.ai's own usage
 * page reads them from `GET /api/organizations/<org>/usage?cedar_ember=1`,
 * which answers to the account's claude.ai session cookie (`sessionKey`).
 * With `providers.anthropic.webResets.enabled` (off by default) the daemon
 * makes that one GET per account, at most every WEB_RESETS_POLL_MS, when the
 * usage is refreshed, and only while that account's own report has no resets
 * (Claude Code's wins whenever it carries them). Nothing else is called: no
 * other page, nothing that uses a reset or changes a setting.
 *
 * Each account's session lives in the `secrets` store as
 * CLAUDE_WEB_SESSION_<ACCOUNT> (webSessionSecretName), put there by
 * scripts/claude-web-session from a browser context signed in to it. The GET
 * is curl run under `secrets run`, which hands the session to curl's
 * environment only (curl reads it into the Cookie header itself), so it never
 * enters the daemon, its logs or its events, and goes nowhere but claude.ai.
 * curl rather than fetch: Cloudflare challenges Bun's fetch (Nov 9 2026).
 * The organization is the one Claude Code is signed in to (its auth status'
 * `orgId`), so a session of another account answers 404, not its resets.
 *
 * A failed poll (no secret, an expired session, another account's session,
 * an HTML or Cloudflare page, a network error or timeout) drops the account's
 * web resets at once: none show until a poll succeeds. The next try waits
 * the full interval. Each kind of failure logs one warning per account until
 * a poll succeeds again; the ones the owner fixes (webSessionProblem) show
 * quietly on the Accounts screen.
 */

import { existsSync } from "fs";
import { readExocortexConfig } from "@exocortex/shared/config";
import type { UsageData, UsageResetCredits } from "../../messages";
import type { ClaudeWebSessionProblem } from "@exocortex/shared/protocol";
import { log } from "../../log";
import { secretsBinary } from "./api-credits";
import { resetCreditsFromPlanRateLimits } from "./usage";

export const WEB_ORIGIN = "https://claude.ai";
/** The least time between two polls of one account. */
export const WEB_RESETS_POLL_MS = 15 * 60_000;
/** How long one poll may take. */
export const WEB_RESETS_TIMEOUT_MS = 10_000;
/** Time `secrets run` may take on top of curl's own limit. */
const SECRETS_TIMEOUT_MS = 10_000;
const PURPOSE = "exocortex: Claude limit resets from claude.ai";
const ORG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a cookie value can hold; anything else (a `;`, a newline) is not a session. */
const SESSION_RE = /^[A-Za-z0-9._~%+/=-]{16,4096}$/;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/** Why a poll failed: the first three need the owner (a session), the rest pass. */
export type WebResetsFailure = ClaudeWebSessionProblem | "blocked" | "network" | "http";

// ── Config ──────────────────────────────────────────────────────────

export interface WebResetsConfig {
  enabled: boolean;
  /** The accounts it polls; null: every account. */
  accounts: string[] | null;
}

export function webResetsConfig(): WebResetsConfig {
  const raw = readExocortexConfig().providers?.anthropic?.webResets;
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return { enabled: false, accounts: null };
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map(id => id.trim())
    : null;
  return { enabled: true, accounts };
}

function pollsAccount(config: WebResetsConfig, account: string): boolean {
  return config.enabled && (config.accounts === null || config.accounts.includes(account));
}

/** The account's claude.ai session in the secrets store: CLAUDE_WEB_SESSION_MAIN, CLAUDE_WEB_SESSION_MAX2, … */
export function webSessionSecretName(account: string): string {
  return `CLAUDE_WEB_SESSION_${account.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

// ── Parsing ─────────────────────────────────────────────────────────

/** The reset grants in a claude.ai usage answer (`cedar_ember`): null when it has none left. */
export function webResetCreditsFromUsage(body: unknown, now = Date.now()): UsageResetCredits | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return resetCreditsFromPlanRateLimits({ cedar_ember: (body as Record<string, unknown>).cedar_ember }, now);
}

// ── Fetching ────────────────────────────────────────────────────────

/** A claude.ai answer, or why there was none. */
export type WebUsageResponse =
  | { status: number; contentType: string; body: string }
  | { error: "missing" | "network"; detail: string };

export interface WebResetsDeps {
  /**
   * GET the organization's usage with the session in the secrets store
   * under `secretName`. The default runs curl under `secrets run`, which
   * puts the session in curl's environment only: it never enters this
   * process (Cloudflare challenges Bun's own fetch, not curl's).
   */
  request(secretName: string, org: string): Promise<WebUsageResponse>;
}

function curlBinary(): string | null {
  const configured = process.env.EXOCORTEX_CURL_BIN?.trim();
  if (configured) return configured;
  return Bun.which("curl", { PATH: process.env.PATH ?? "" }) ?? (existsSync("/usr/bin/curl") ? "/usr/bin/curl" : null);
}

/** curl's arguments for one GET; the session comes from the environment variable `variable`. */
export function curlArgs(variable: string, org: string): string[] {
  return [
    "-sS", "--max-time", String(WEB_RESETS_TIMEOUT_MS / 1000), "--proto", "=https",
    "--variable", `%${variable}`,
    "--expand-header", `Cookie: sessionKey={{${variable}}}`,
    "-H", `User-Agent: ${USER_AGENT}`,
    "-H", "Accept: */*",
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-H", "anthropic-client-platform: web_claude_ai",
    // The body on stdout; the status and type after it on stderr.
    "-o", "-", "-w", "%{stderr}\n%{http_code} %{content_type}",
    `${WEB_ORIGIN}/api/organizations/${org}/usage?cedar_ember=1&skip_spend=1`,
  ];
}

/** Run curl (`argv` starts with it, or with `secrets run … --`) and read its answer. */
export async function runCurl(argv: string[], env?: Record<string, string>): Promise<WebUsageResponse> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: WEB_RESETS_TIMEOUT_MS + SECRETS_TIMEOUT_MS,
      ...(env ? { env } : {}),
    });
    const [body, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (/secret not found/i.test(stderr)) return { error: "missing", detail: "not in the secrets store" };
    const trailer = stderr.trimEnd().split("\n").pop()?.match(/^(\d{3}) ?(.*)$/);
    if (exitCode !== 0 || !trailer || trailer[1] === "000") {
      // curl's own message names the host or the timeout, never a header.
      const reason = stderr.split("\n").find(line => line.startsWith("curl:"))?.slice(0, 120);
      return { error: "network", detail: reason ?? `exit ${exitCode}` };
    }
    return { status: Number(trailer[1]), contentType: trailer[2] ?? "", body };
  } catch {
    return { error: "network", detail: "could not run curl" };
  }
}

async function cliRequest(secretName: string, org: string): Promise<WebUsageResponse> {
  const secrets = secretsBinary();
  if (!secrets) return { error: "missing", detail: "no secrets CLI" };
  const curl = curlBinary();
  if (!curl) return { error: "network", detail: "no curl" };
  return runCurl([secrets, "run", "--allow", secretName, "--clean-env", "--purpose", PURPOSE, "--", curl, ...curlArgs(secretName, org)]);
}

const defaultDeps: WebResetsDeps = { request: cliRequest };
let deps: WebResetsDeps = defaultDeps;

export type WebResetsResult =
  | { ok: true; credits: UsageResetCredits | null }
  | { ok: false; failure: WebResetsFailure; detail: string };

/** One GET of the account's claude.ai usage, with its stored session. */
export async function fetchWebResets(account: string, org: string, now = Date.now()): Promise<WebResetsResult> {
  if (!ORG_RE.test(org)) return { ok: false, failure: "http", detail: "not an organization id" };
  const name = webSessionSecretName(account);
  const response = await deps.request(name, org.toLowerCase());
  if ("error" in response && response.error === "missing") return { ok: false, failure: "missing", detail: `no ${name}: ${response.detail}` };
  return classifyWebUsage(response, now);
}

/** One GET with a session this process holds (scripts/claude-web-session, before it stores one). */
export async function checkWebSession(session: string, org: string, now = Date.now()): Promise<WebResetsResult> {
  if (!SESSION_RE.test(session)) return { ok: false, failure: "expired", detail: "not a cookie value" };
  if (!ORG_RE.test(org)) return { ok: false, failure: "http", detail: "not an organization id" };
  const curl = curlBinary();
  if (!curl) return { ok: false, failure: "network", detail: "no curl" };
  const variable = "CLAUDE_WEB_SESSION";
  return classifyWebUsage(await runCurl([curl, ...curlArgs(variable, org.toLowerCase())], { [variable]: session }), now);
}

/** What a claude.ai answer means: the resets, or which kind of failure. */
export function classifyWebUsage(response: WebUsageResponse, now = Date.now()): WebResetsResult {
  if ("error" in response) return { ok: false, failure: response.error, detail: response.detail };
  const { status, contentType } = response;
  const json = contentType.includes("json");
  const type = contentType.split(";")[0] || "no content type";
  // Cloudflare's challenge is an HTML 403; claude.ai's own refusals are JSON.
  if (!json && (status === 403 || status === 503 || (status >= 200 && status < 300))) return { ok: false, failure: "blocked", detail: `HTTP ${status} ${type}` };
  if (status === 401 || status === 403) return { ok: false, failure: "expired", detail: `HTTP ${status}` };
  if (status >= 300 && status < 400) return { ok: false, failure: "expired", detail: `HTTP ${status} redirect` };
  if (status === 404 && json) return { ok: false, failure: "other_account", detail: "the organization is not this session's" };
  if (status < 200 || status >= 300) return { ok: false, failure: "http", detail: `HTTP ${status}` };
  try {
    return { ok: true, credits: webResetCreditsFromUsage(JSON.parse(response.body), now) };
  } catch {
    return { ok: false, failure: "blocked", detail: "unreadable JSON" };
  }
}

// ── State ───────────────────────────────────────────────────────────

interface AccountWebState {
  /** When the last poll started (ms). */
  checkedAt: number;
  credits: UsageResetCredits | null;
  problem: ClaudeWebSessionProblem | null;
  /** Failure kinds already logged since the last success. */
  warned: Set<WebResetsFailure>;
}

const states = new Map<string, AccountWebState>();
const polls = new Map<string, Promise<boolean>>();

function stateFor(account: string): AccountWebState {
  let state = states.get(account);
  if (!state) {
    state = { checkedAt: 0, credits: null, problem: null, warned: new Set() };
    states.set(account, state);
  }
  return state;
}

/** Whether this account's poll is due. */
export function webResetsDue(account: string, now = Date.now()): boolean {
  const state = states.get(account);
  return !state || now - state.checkedAt >= WEB_RESETS_POLL_MS;
}

function sameCredits(a: UsageResetCredits | null, b: UsageResetCredits | null): boolean {
  return a?.availableCount === b?.availableCount && a?.nextExpiresAt === b?.nextExpiresAt;
}

export interface WebResetsAccount {
  id: string;
  /** Its claude.ai organization (Claude Code's auth status `orgId`); unknown: not polled yet. */
  org: string | null | undefined;
  /** Its Claude Code report already has resets: not polled, and those show. */
  ownResets: boolean;
}

async function poll(account: WebResetsAccount, org: string, now: number): Promise<boolean> {
  const state = stateFor(account.id);
  state.checkedAt = now;
  const result = await fetchWebResets(account.id, org, now);
  const before = { credits: state.credits, problem: state.problem };
  if (result.ok) {
    if (state.warned.size > 0) log("info", `anthropic: claude.ai limit resets for "${account.id}" readable again`);
    state.warned.clear();
    state.credits = result.credits;
    state.problem = null;
  } else {
    if (!state.warned.has(result.failure)) {
      state.warned.add(result.failure);
      log("warn", `anthropic: claude.ai limit resets for "${account.id}" unavailable (${result.failure}): ${result.detail}`);
    }
    // Never shown as current past a failed poll.
    state.credits = null;
    state.problem = result.failure === "missing" || result.failure === "expired" || result.failure === "other_account" ? result.failure : null;
  }
  return !sameCredits(before.credits, state.credits) || before.problem !== state.problem;
}

/**
 * Poll the accounts that are due (refreshCombinedUsage). Returns whether any
 * account's resets or session problem changed. Off: does nothing.
 */
export async function refreshWebResets(accounts: WebResetsAccount[], now = Date.now()): Promise<boolean> {
  const config = webResetsConfig();
  if (!config.enabled) return false;
  const runs: Array<Promise<boolean>> = [];
  for (const account of accounts) {
    if (!pollsAccount(config, account.id) || account.ownResets) continue;
    if (typeof account.org !== "string" || !ORG_RE.test(account.org)) continue;
    const running = polls.get(account.id);
    if (running) { runs.push(running); continue; }
    if (!webResetsDue(account.id, now)) continue;
    const run = poll(account, account.org.toLowerCase(), now).catch(() => false).finally(() => polls.delete(account.id));
    polls.set(account.id, run);
    runs.push(run);
  }
  return (await Promise.all(runs)).some(Boolean);
}

/** The account's resets from claude.ai, while it is on and the last poll succeeded. */
export function webResetCredits(account: string, now = Date.now()): UsageResetCredits | null {
  // Nothing polled (always so while it is off): no config read on this hot path.
  const credits = states.get(account)?.credits ?? null;
  if (!credits || (credits.nextExpiresAt !== null && credits.nextExpiresAt <= now)) return null;
  return pollsAccount(webResetsConfig(), account) ? credits : null;
}

/** What the owner must fix for this account's web session, while it is on. */
export function webSessionProblem(account: string): ClaudeWebSessionProblem | null {
  const problem = states.get(account)?.problem ?? null;
  return problem && pollsAccount(webResetsConfig(), account) ? problem : null;
}

/** The account's usage with its claude.ai resets, where its own report has none. */
export function withWebResets(usage: UsageData | null, account: string, now = Date.now()): UsageData | null {
  if (!usage || usage.resetCredits) return usage;
  const credits = webResetCredits(account, now);
  return credits ? { ...usage, resetCredits: credits } : usage;
}

export function setWebResetsDepsForTests(next: Partial<WebResetsDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  states.clear();
  polls.clear();
}
