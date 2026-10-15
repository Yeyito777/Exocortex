/**
 * Per-account cache of `claude auth status`.
 *
 * Every `claude auth status` is a short-lived Claude Code process, and one
 * that starts an OAuth refresh can exit before saving the rotated tokens,
 * which leaves the login expired (anthropics/claude-code#95822). So the status
 * is checked at most once per TTL per account, not before every turn, and a
 * Claude Code process that is working for an account counts as a fresh check.
 */

import { log } from "../../log";
import { emitClaudeAccountsChanged } from "./account-events";
import { getClaudeAuthStatus, isSubscriptionAuth } from "./cli";
import type { ClaudeAuthStatus } from "./types";

/** A signed-in account is checked again after this long without a working turn. */
export const SIGNED_IN_STATUS_TTL_MS = 10 * 60_000;
/** A signed-out account is checked again sooner, so a new login shows up. */
export const SIGNED_OUT_STATUS_TTL_MS = 60_000;
/** An account whose requests fail authentication sits out this long before it is checked again. */
export const AUTH_FAILURE_BLOCK_MS = 15 * 60_000;

interface Entry {
  status: ClaudeAuthStatus | null;
  checkedAt: number;
  blockedUntil: number | null;
  blockReason: string | null;
  pending: Promise<ClaudeAuthStatus> | null;
  /** Bumped by invalidation so a probe started before it does not overwrite it. */
  generation: number;
}

type Probe = (account: string, signal?: AbortSignal) => Promise<ClaudeAuthStatus>;

const entries = new Map<string, Entry>();
const defaultProbe: Probe = (account, signal) => getClaudeAuthStatus(signal, account);
let probe = defaultProbe;
let probes = 0;

export function setClaudeAuthProbeForTests(next: Probe | null): void {
  probe = next ?? defaultProbe;
  entries.clear();
  probes = 0;
}

/** How many `claude auth status` processes the cache has started (tests). */
export function claudeAuthProbeCount(): number {
  return probes;
}

function entryFor(account: string): Entry {
  let entry = entries.get(account);
  if (!entry) {
    entry = { status: null, checkedAt: 0, blockedUntil: null, blockReason: null, pending: null, generation: 0 };
    entries.set(account, entry);
  }
  return entry;
}

function ttlFor(status: ClaudeAuthStatus | null): number {
  return status && isSubscriptionAuth(status) ? SIGNED_IN_STATUS_TTL_MS : SIGNED_OUT_STATUS_TTL_MS;
}

/** The cached status, if one was checked within its TTL (or `maxAgeMs`). */
export function freshClaudeAuthStatus(account: string, now = Date.now(), maxAgeMs?: number): ClaudeAuthStatus | null {
  const entry = entries.get(account);
  if (!entry?.status) return null;
  return now - entry.checkedAt < (maxAgeMs ?? ttlFor(entry.status)) ? entry.status : null;
}

/** The last known status, however old. */
export function lastClaudeAuthStatus(account: string): ClaudeAuthStatus | null {
  return entries.get(account)?.status ?? null;
}

/**
 * The account's `claude auth status`, from the cache when fresh. `maxAgeMs: 0`
 * forces a check (logins, explicit status commands).
 */
export async function cachedClaudeAuthStatus(
  account: string,
  options: { signal?: AbortSignal; maxAgeMs?: number; now?: () => number } = {},
): Promise<ClaudeAuthStatus> {
  const now = options.now ?? Date.now;
  const fresh = freshClaudeAuthStatus(account, now(), options.maxAgeMs);
  if (fresh) return fresh;
  const entry = entryFor(account);
  if (entry.pending) return entry.pending;
  const generation = entry.generation;
  probes += 1;
  log("info", `anthropic: checking Claude account ${account} with claude auth status`);
  const pending = probe(account, options.signal).then((status) => {
    if (entry.generation === generation) {
      entry.status = status;
      entry.checkedAt = now();
      // A fresh signed-in check ends an authentication block.
      if (isSubscriptionAuth(status)) {
        entry.blockedUntil = null;
        entry.blockReason = null;
      }
      emitClaudeAccountsChanged();
    }
    return status;
  }).finally(() => {
    if (entry.pending === pending) entry.pending = null;
  });
  entry.pending = pending;
  return pending;
}

/**
 * A Claude Code process is working for this account (it reported usage or
 * finished a turn): that is as good as a fresh signed-in check.
 */
export function noteClaudeAccountWorking(account: string, now = Date.now()): void {
  const entry = entries.get(account);
  if (!entry?.status || !isSubscriptionAuth(entry.status)) return;
  entry.checkedAt = now;
  entry.blockedUntil = null;
  entry.blockReason = null;
}

/** Requests on this account failed authentication: keep it out of routing for a while, then check again. */
export function noteClaudeAccountAuthFailure(account: string, reason: string, now = Date.now()): void {
  const entry = entryFor(account);
  entry.generation += 1;
  entry.checkedAt = 0;
  entry.pending = null;
  entry.blockedUntil = now + AUTH_FAILURE_BLOCK_MS;
  entry.blockReason = reason;
  emitClaudeAccountsChanged();
}

export function claudeAccountBlock(account: string, now = Date.now()): { until: number; reason: string } | null {
  const entry = entries.get(account);
  if (!entry || entry.blockedUntil === null || entry.blockedUntil <= now) return null;
  return { until: entry.blockedUntil, reason: entry.blockReason ?? "authentication failed" };
}

/** Forget cached statuses; one account's, or all. */
export function invalidateClaudeAuthStatus(account?: string): void {
  const targets = account ? [entries.get(account)].filter((entry): entry is Entry => entry !== undefined) : [...entries.values()];
  for (const entry of targets) {
    entry.generation += 1;
    entry.checkedAt = 0;
    entry.pending = null;
  }
}
