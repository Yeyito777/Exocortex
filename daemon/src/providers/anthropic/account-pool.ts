/**
 * Claude accounts at runtime: which ones can run turns, which account each
 * conversation runs on, and the combined usage the bars show.
 *
 * routing.ts makes the decisions; this module feeds it the current state:
 * each account's cached sign-in status (auth-cache.ts), its usage and limits
 * (usage.ts), and each conversation's last account and when it last used it.
 */

import { isEphemeralConversation, isHiddenConversation } from "../../app-registry";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import type { UsageData } from "../../messages";
import type { AccountConversationInfo, ClaudeAccountInfo, ClaudeAccountsInfo, ClaudeAccountState } from "@exocortex/shared/protocol";
import { log } from "../../log";
import { isProviderProxied } from "../../provider-proxy/route";
import { emitClaudeAccountsChanged } from "./account-events";
import { claudeLoginCommand, displayPath, listClaudeAccounts, MAIN_ACCOUNT_ID, type ClaudeAccount } from "./accounts";
import { hasConfiguredCredentials } from "./auth";
import {
  cachedClaudeAuthStatus,
  claudeAccountBlock,
  freshClaudeAuthStatus,
  invalidateClaudeAuthStatus,
  lastClaudeAuthStatus,
  noteClaudeAccountAuthFailure,
} from "./auth-cache";
import { isSubscriptionAuth } from "./cli";
import {
  DEFAULT_ROUTING_POLICY,
  isAccountLimited,
  routeConversation,
  routeNewWork,
  type AccountRouteState,
  type RouteDecision,
} from "./routing";
import { applyDevRoutingOverrides } from "./routing-dev-overrides";
import type { ClaudeAuthStatus } from "./types";
import {
  aggregateUsage,
  applyUsageHeaders,
  clearUsage as clearAccountUsage,
  getAccountLimitedUntil,
  getAccountUsage,
  getAccountUsageUpdatedAt,
  refreshAccountUsage,
} from "./usage";

const ASSIGNMENTS_FILE_NAME = "anthropic-conversation-accounts.json";
/** Assignments unused this long are forgotten. */
const ASSIGNMENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SAVE_DELAY_MS = 2_000;
/** Idle usage checks per account at most this often; turns keep it current meanwhile. */
const USAGE_REFRESH_TTL_MS = 60_000;

interface Assignment {
  account: string;
  lastUsedAt: number;
}

let assignmentsFileOverride: string | null = null;
let assignments: Map<string, Assignment> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const activeTurns = new Map<string, number>();
/** Conversations with a turn running now, and the account it runs on. */
const runningConversations = new Map<string, string>();

export function setAssignmentsFileForTests(path: string | null): void {
  assignmentsFileOverride = path;
  assignments = null;
  activeTurns.clear();
  runningConversations.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function assignmentsFile(): string {
  return assignmentsFileOverride ?? join(runtimeDir(), ASSIGNMENTS_FILE_NAME);
}

function loadAssignments(): Map<string, Assignment> {
  if (assignments) return assignments;
  assignments = new Map();
  try {
    const path = assignmentsFile();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Assignment>;
      for (const [convId, entry] of Object.entries(parsed)) {
        if (typeof entry?.account === "string" && typeof entry.lastUsedAt === "number") assignments.set(convId, entry);
      }
    }
  } catch {
    // start empty
  }
  return assignments;
}

export function flushAssignments(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!assignments) return;
  const map = assignments;
  const cutoff = Date.now() - ASSIGNMENT_RETENTION_MS;
  const out: Record<string, Assignment> = {};
  for (const [convId, entry] of map) {
    if (entry.lastUsedAt < cutoff) map.delete(convId);
    // An ephemeral app conversation's account stays in memory only.
    else if (!isEphemeralConversation(convId)) out[convId] = entry;
  }
  try {
    const path = assignmentsFile();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, path);
  } catch (error) {
    log("debug", `anthropic: saving conversation accounts failed: ${error instanceof Error ? error.message : error}`);
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flushAssignments, SAVE_DELAY_MS);
  (saveTimer as { unref?: () => void }).unref?.();
}

/** A deleted app conversation's account record (app-api.ts). */
export function forgetConversationAccount(convId: string): void {
  runningConversations.delete(convId);
  if (loadAssignments().delete(convId)) flushAssignments();
}

export function getConversationAccount(convId: string): Assignment | null {
  return loadAssignments().get(convId) ?? null;
}

/** The conversation just made a request on `account` (keeps its cache-warm clock). */
export function touchConversationAccount(convId: string, account: string, now = Date.now()): void {
  loadAssignments().set(convId, { account, lastUsedAt: now });
  scheduleSave();
}

export function beginAccountTurn(account: string, convId?: string): () => void {
  activeTurns.set(account, (activeTurns.get(account) ?? 0) + 1);
  if (convId) runningConversations.set(convId, account);
  emitClaudeAccountsChanged();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (activeTurns.get(account) ?? 1) - 1;
    if (left > 0) activeTurns.set(account, left);
    else activeTurns.delete(account);
    if (convId && runningConversations.get(convId) === account) runningConversations.delete(convId);
    emitClaudeAccountsChanged();
  };
}

/** Whether the account can count toward capacity and take turns, as far as is known without spawning anything. */
function isAvailable(account: ClaudeAccount, now: number): boolean {
  if (claudeAccountBlock(account.id, now)) return false;
  const status = lastClaudeAuthStatus(account.id);
  if (status) return isSubscriptionAuth(status);
  // Before its first check, the main account counts as Exocortex last saw it.
  return account.id === MAIN_ACCOUNT_ID && hasConfiguredCredentials();
}

export function claudeAccountStates(now = Date.now()): AccountRouteState[] {
  return listClaudeAccounts().map(account => ({
    id: account.id,
    available: isAvailable(account, now),
    limitedUntil: getAccountLimitedUntil(account.id, now),
    usage: getAccountUsage(account.id),
    activeTurns: activeTurns.get(account.id) ?? 0,
  }));
}

/** Check the sign-in of every account whose cached status is stale. */
export async function refreshClaudeAccountStatuses(options: { signal?: AbortSignal; force?: boolean } = {}): Promise<void> {
  const accounts = listClaudeAccounts();
  await Promise.all(accounts.map(async (account) => {
    if (!options.force && freshClaudeAuthStatus(account.id)) return;
    // Nothing to learn about a blocked account until its block ends.
    if (!options.force && claudeAccountBlock(account.id)) return;
    try {
      await cachedClaudeAuthStatus(account.id, { signal: options.signal, ...(options.force ? { maxAgeMs: 0 } : {}) });
    } catch (error) {
      log("warn", `anthropic: checking Claude account "${account.id}" failed: ${error instanceof Error ? error.message : error}`);
    }
  }));
}

/**
 * A turn on this account failed authentication. With other accounts to use,
 * keep it out of routing for a while; either way check its sign-in again.
 */
export function noteAccountAuthFailure(account: string, reason: string): void {
  if (multipleClaudeAccounts()) noteClaudeAccountAuthFailure(account, reason);
  else invalidateClaudeAuthStatus(account);
}

export function multipleClaudeAccounts(): boolean {
  return listClaudeAccounts().length > 1;
}

export interface LiveProcessState {
  account: string;
  open: boolean;
  backgroundWork: boolean;
}

/**
 * Pick the account for a conversation's turn. With one account, or under
 * /proxy (the remote's login), that is always `main`, without checking
 * anything. `sessionAccount` is the account that wrote the Claude Code
 * session the turn resumes, for conversations this daemon has no record of.
 */
export async function routeClaudeTurn(
  convId: string | undefined,
  live: LiveProcessState | null,
  signal?: AbortSignal,
  sessionAccount: string | null = null,
): Promise<RouteDecision> {
  if (isProviderProxied("anthropic") || !multipleClaudeAccounts()) {
    return { account: MAIN_ACCOUNT_ID, reason: "new", detail: "single account" };
  }
  await refreshClaudeAccountStatuses({ signal });
  const now = Date.now();
  const { states: accounts, policy } = applyDevRoutingOverrides(claudeAccountStates(now), now);
  if (!convId) {
    const choice = routeNewWork(accounts, now, policy);
    return { account: choice?.account ?? MAIN_ACCOUNT_ID, reason: "new", detail: choice?.detail ?? "no account can take it" };
  }
  const assignment = getConversationAccount(convId);
  return routeConversation({
    account: live?.account ?? assignment?.account ?? sessionAccount,
    lastUsedAt: assignment && (!live || live.account === assignment.account) ? assignment.lastUsedAt : null,
    liveProcess: live?.open ?? false,
    backgroundWork: live?.backgroundWork ?? false,
  }, accounts, now, policy);
}

/** Accounts whose usage the bars combine: signed in and not blocked. */
function capacityAccounts(now: number): AccountRouteState[] {
  return claudeAccountStates(now).filter(state => state.available);
}

/** Combined usage of the usable accounts (one account: its own usage). */
export function getCombinedUsage(now = Date.now()): UsageData | null {
  const included = capacityAccounts(now);
  if (included.length === 0) {
    // Nothing known to be signed in yet: show the main account's last usage, as before.
    return multipleClaudeAccounts() ? null : getAccountUsage(MAIN_ACCOUNT_ID);
  }
  return aggregateUsage(included.map(state => state.usage), now);
}

/** Refresh stale statuses and idle usage of every account, then return the combined usage. */
export async function refreshCombinedUsage(): Promise<UsageData | null> {
  if (multipleClaudeAccounts()) await refreshClaudeAccountStatuses();
  const now = Date.now();
  const stale = capacityAccounts(now).filter(state => now - getAccountUsageUpdatedAt(state.id) >= USAGE_REFRESH_TTL_MS);
  await Promise.all(stale.map(async (state) => {
    try {
      await refreshAccountUsage(state.id);
    } catch (error) {
      log("debug", `anthropic: usage refresh for "${state.id}" failed: ${error instanceof Error ? error.message : error}`);
    }
  }));
  return getCombinedUsage();
}

// ── Provider usage surface (index.ts): the combined usage ──────────

export function getLastUsage(): UsageData | null {
  return getCombinedUsage();
}

export function refreshUsage(onUpdate: (usage: UsageData | null) => void): void {
  onUpdate(getCombinedUsage());
}

export function refreshRemoteUsage(): Promise<UsageData | null> {
  return refreshCombinedUsage();
}

export function handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void {
  if (!applyUsageHeaders(headers)) return;
  const usage = getCombinedUsage();
  if (usage) onUpdate(usage);
}

export function clearUsage(): void {
  clearAccountUsage();
}

export interface ClaudeAccountReport {
  account: ClaudeAccount;
  status: ClaudeAuthStatus | null;
  available: boolean;
  limited: boolean;
  limitedUntil: number | null;
  block: { until: number; reason: string } | null;
  usage: UsageData | null;
  activeTurns: number;
  conversations: number;
}

/** Everything `/account claude` shows, after a fresh check of every account. */
export async function claudeAccountReports(): Promise<ClaudeAccountReport[]> {
  await refreshClaudeAccountStatuses({ force: true });
  const now = Date.now();
  const states = claudeAccountStates(now);
  await Promise.all(states.filter(state => state.available).map(state => refreshAccountUsage(state.id).catch(() => null)));
  const counts = new Map<string, number>();
  const warmSince = now - DEFAULT_ROUTING_POLICY.cacheTtlMs;
  for (const entry of loadAssignments().values()) {
    if (entry.lastUsedAt >= warmSince) counts.set(entry.account, (counts.get(entry.account) ?? 0) + 1);
  }
  return listClaudeAccounts().map((account) => {
    const state = claudeAccountStates(now).find(entry => entry.id === account.id)!;
    return {
      account,
      status: lastClaudeAuthStatus(account.id),
      available: state.available,
      limited: isAccountLimited(state, now),
      limitedUntil: state.limitedUntil,
      block: claudeAccountBlock(account.id, now),
      usage: state.usage,
      activeTurns: state.activeTurns,
      conversations: counts.get(account.id) ?? 0,
    };
  });
}

function accountState(report: Pick<ClaudeAccountReport, "status" | "block" | "limited">): { state: ClaudeAccountState; detail: string | null } {
  if (report.block) return { state: "blocked", detail: report.block.reason };
  if (!report.status) return { state: "unchecked", detail: null };
  if (!report.status.loggedIn) return { state: "signed_out", detail: null };
  if (!isSubscriptionAuth(report.status)) return { state: "not_subscription", detail: report.status.authMethod ?? null };
  if (report.limited) return { state: "limited", detail: null };
  return { state: "ready", detail: null };
}

/**
 * The Accounts screen's Claude data, from what is already known (nothing is
 * checked or fetched here; refreshCombinedUsage does that). Accounts show
 * their real usage; where new work goes follows routing, dev overrides included.
 */
export function claudeAccountsInfo(currentConvId: string | null = null, now = Date.now()): ClaudeAccountsInfo {
  const states = claudeAccountStates(now);
  const routed = applyDevRoutingOverrides(states, now);
  const warmSince = now - routed.policy.cacheTtlMs;
  const byAccount = new Map<string, AccountConversationInfo[]>();
  for (const [convId, entry] of loadAssignments()) {
    // Hidden app conversations are never shown (docs/app-api.md).
    if (isHiddenConversation(convId)) continue;
    const running = runningConversations.get(convId) === entry.account;
    const warm = entry.lastUsedAt >= warmSince;
    if (!running && !warm) continue;
    const list = byAccount.get(entry.account) ?? [];
    list.push({ convId, lastUsedAt: entry.lastUsedAt, running, warm });
    byAccount.set(entry.account, list);
  }
  const accounts = listClaudeAccounts().map((account): ClaudeAccountInfo => {
    const state = states.find(entry => entry.id === account.id)!;
    const status = lastClaudeAuthStatus(account.id);
    const block = claudeAccountBlock(account.id, now);
    const { state: accountStateName, detail } = accountState({ status, block, limited: isAccountLimited(state, now) });
    const signedIn = status !== null && isSubscriptionAuth(status);
    const updatedAt = getAccountUsageUpdatedAt(account.id);
    return {
      id: account.id,
      email: status?.email ?? null,
      plan: status?.subscriptionType ?? null,
      configDir: displayPath(account.configDir),
      state: accountStateName,
      stateDetail: detail,
      limitedUntil: state.limitedUntil,
      blockedUntil: block?.until ?? null,
      usage: state.usage,
      usageUpdatedAt: updatedAt > 0 ? updatedAt : null,
      activeTurns: state.activeTurns,
      conversations: (byAccount.get(account.id) ?? []).sort((a, b) => Number(b.running) - Number(a.running) || b.lastUsedAt - a.lastUsedAt),
      loginCommand: !signedIn && !block && !state.available ? claudeLoginCommand(account) : null,
    };
  });
  const current = currentConvId ? getConversationAccount(currentConvId) : null;
  return {
    proxied: isProviderProxied("anthropic"),
    accounts,
    combined: getCombinedUsage(now),
    routing: { ...routed.policy },
    nextNewWork: accounts.length > 1 ? routeNewWork(routed.states, now, routed.policy) : null,
    ...(currentConvId ? {
      currentConversation: {
        convId: currentConvId,
        account: current?.account ?? null,
        lastUsedAt: current?.lastUsedAt ?? null,
        warm: current !== null && current.lastUsedAt >= warmSince,
      },
    } : {}),
  };
}
