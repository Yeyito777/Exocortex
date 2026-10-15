/**
 * Which Claude account runs a turn. Pure decisions over account and
 * conversation snapshots; account-pool.ts gathers the snapshots.
 *
 * A conversation's prompt cache lives with the account (organization) that
 * wrote it, so a conversation stays on its account while that cache is warm,
 * while its Claude Code process is alive, and always while it has background
 * tasks. It moves only when its account cannot serve it (logged out, blocked,
 * or at a limit), or when its cache is already cold and moving clearly helps.
 *
 * New work goes first to the account whose capacity expires soonest
 * ("first expired, first out"): unused capacity is lost when a window resets,
 * so an account whose weekly window resets soon is burned first and the one
 * whose capacity lasts longer is saved. The weekly window, the scarcer one,
 * decides first; the 5-hour window breaks near-ties. Floors keep an account
 * out of new work before a window blocks it.
 */

import type { UsageData, UsageWindow } from "../../messages";

export interface AccountRouteState {
  id: string;
  /** Signed in with a Claude subscription and not blocked: it can count toward capacity. */
  available: boolean;
  /** Claude Code rejected requests on a usage window: no new turns until this time (ms). */
  limitedUntil: number | null;
  usage: UsageData | null;
  /** Turns running on this account now (ties only). */
  activeTurns: number;
}

export interface ConversationRouteState {
  /** Account the conversation last ran on, if any. */
  account: string | null;
  /** When its last request on that account was made (ms). */
  lastUsedAt: number | null;
  /** Its Claude Code process is still open. */
  liveProcess: boolean;
  /** Its Claude Code process has background tasks running (or a turn of its own pending). */
  backgroundWork: boolean;
}

export interface RoutingPolicy {
  /** How long an idle conversation's prompt cache stays warm. */
  cacheTtlMs: number;
  /** New work needs at least this much 5-hour headroom (percent points). */
  fiveHourFloor: number;
  /** New work needs at least this much weekly headroom (percent points). */
  weeklyFloor: number;
  /** Weekly resets closer together than this count as simultaneous. */
  weeklyResetTieMs: number;
  /** 5-hour resets closer together than this count as simultaneous. */
  fiveHourResetTieMs: number;
}

/**
 * Claude Code 2.1.x writes the main conversation's cache with a one-hour TTL
 * on a Claude subscription within its limits ("Unset = automatic: 1 hour on a
 * Claude subscription", its `promptCacheTtl` setting; SDK turns count as the
 * main conversation). It may use five minutes for some requests, so one hour
 * is the conservative bound: a conversation is never treated as cold early.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  cacheTtlMs: 60 * 60_000,
  fiveHourFloor: 10,
  weeklyFloor: 10,
  weeklyResetTieMs: 6 * 60 * 60_000,
  fiveHourResetTieMs: 30 * 60_000,
};

export type RouteReason =
  | "new"
  | "background-tasks"
  | "live-process"
  | "cache-warm"
  | "sticky"
  | "cold-move"
  | "account-unavailable"
  | "account-limited"
  | "no-alternative";

export interface RouteDecision {
  account: string;
  reason: RouteReason;
  /** Set when the conversation moves off the account it last ran on. */
  movedFrom?: string;
  /** Short human-readable explanation, for logs and the switch notice. */
  detail: string;
}

interface WindowView {
  /** Remaining percent points (100 − utilization), after a passed reset. */
  headroom: number;
  /** Time until the window resets, Infinity when unknown or not started. */
  resetsIn: number;
}

function windowView(window: UsageWindow | null | undefined, now: number): WindowView {
  if (!window) return { headroom: 100, resetsIn: Infinity };
  if (window.resetsAt !== null && window.resetsAt <= now) return { headroom: 100, resetsIn: Infinity };
  const headroom = Math.max(0, 100 - window.utilization);
  // A window with nothing used has not started; its capacity does not expire yet.
  const resetsIn = window.resetsAt === null || window.utilization <= 0 ? Infinity : window.resetsAt - now;
  return { headroom, resetsIn };
}

interface AccountView {
  state: AccountRouteState;
  index: number;
  fiveHour: WindowView;
  weekly: WindowView;
  /** Can take a turn at all. */
  usable: boolean;
  /** Usable and above both floors: can take new work. */
  eligible: boolean;
}

export function isAccountLimited(state: AccountRouteState, now: number): boolean {
  if (state.limitedUntil !== null && state.limitedUntil > now) return true;
  const usage = state.usage;
  for (const window of [usage?.fiveHour, usage?.sevenDay]) {
    if (window && window.utilization >= 100 && (window.resetsAt === null || window.resetsAt > now)) return true;
  }
  return false;
}

function viewOf(state: AccountRouteState, index: number, now: number, policy: RoutingPolicy): AccountView {
  const fiveHour = windowView(state.usage?.fiveHour, now);
  const weekly = windowView(state.usage?.sevenDay, now);
  const usable = state.available && !isAccountLimited(state, now);
  const eligible = usable && fiveHour.headroom >= policy.fiveHourFloor && weekly.headroom >= policy.weeklyFloor;
  return { state, index, fiveHour, weekly, usable, eligible };
}

/** Keep the candidates whose `key` is within `tie` of the smallest. */
function nearest(candidates: AccountView[], key: (view: AccountView) => number, tie: number): AccountView[] {
  const best = Math.min(...candidates.map(key));
  if (best === Infinity) return candidates.filter(view => key(view) === Infinity);
  return candidates.filter(view => key(view) - best <= tie);
}

/**
 * Rank candidates for new work: soonest weekly reset first (its capacity is
 * lost first), then among those resetting at about the same time the soonest
 * 5-hour reset, then the most headroom, then the fewest running turns, then
 * the account order.
 */
function rank(candidates: AccountView[], policy: RoutingPolicy): AccountView[] {
  let pool = nearest(candidates, view => view.weekly.resetsIn, policy.weeklyResetTieMs);
  pool = nearest(pool, view => view.fiveHour.resetsIn, policy.fiveHourResetTieMs);
  const headroom = (view: AccountView) => Math.min(view.fiveHour.headroom, view.weekly.headroom);
  const sorted = [...pool].sort((a, b) =>
    headroom(b) - headroom(a) || a.state.activeTurns - b.state.activeTurns || a.index - b.index);
  return [...sorted, ...candidates.filter(view => !sorted.includes(view))];
}

function best(views: AccountView[], policy: RoutingPolicy): AccountView | null {
  const eligible = views.filter(view => view.eligible);
  if (eligible.length > 0) return rank(eligible, policy)[0];
  // Every usable account is below a floor: still run, on the one with the
  // most headroom left (weekly first), rather than refuse.
  const usable = views.filter(view => view.usable);
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) =>
    Math.min(b.weekly.headroom, b.fiveHour.headroom) - Math.min(a.weekly.headroom, a.fiveHour.headroom)
    || b.weekly.headroom - a.weekly.headroom || a.index - b.index)[0];
}

function whyUnfit(view: AccountView, policy: RoutingPolicy): string {
  const id = `"${view.state.id}"`;
  if (!view.state.available) return `${id} is signed out or blocked`;
  if (!view.usable) return `${id} is at a usage limit`;
  if (view.weekly.headroom < policy.weeklyFloor) return `${id} is below the weekly floor`;
  return `${id} is below the 5-hour floor`;
}

/** Why `chosen` won over the other accounts, for logs and notices. */
function explainChoice(chosen: AccountView, views: AccountView[], policy: RoutingPolicy): string {
  const others = views.filter(view => view !== chosen);
  if (!chosen.eligible) return `every account is below a usage floor; "${chosen.state.id}" has the most headroom`;
  const unfit = others.filter(view => !view.eligible).map(view => whyUnfit(view, policy));
  const rivals = rank(others.filter(view => view.eligible), policy);
  let why: string | null = null;
  const runnerUp = rivals[0];
  if (runnerUp) {
    const headroom = (view: AccountView) => Math.min(view.fiveHour.headroom, view.weekly.headroom);
    if (runnerUp.weekly.resetsIn - chosen.weekly.resetsIn > policy.weeklyResetTieMs) why = "its weekly limit resets soonest";
    else if (runnerUp.fiveHour.resetsIn - chosen.fiveHour.resetsIn > policy.fiveHourResetTieMs) why = "its 5-hour limit resets soonest (weekly resets tie)";
    else if (headroom(chosen) > headroom(runnerUp)) why = "it has the most headroom (resets tie)";
    else if (chosen.state.activeTurns < runnerUp.state.activeTurns) why = "it runs the fewest turns (resets and headroom tie)";
    else why = "first in account order (resets and headroom tie)";
  }
  return [why, ...unfit].filter(Boolean).join("; ") || "the only account";
}

function describeWindowLimit(view: AccountView, policy: RoutingPolicy): string {
  if (view.weekly.headroom < policy.weeklyFloor) return `its weekly usage is at ${Math.round(100 - view.weekly.headroom)}%`;
  if (view.fiveHour.headroom < policy.fiveHourFloor) return `its 5-hour usage is at ${Math.round(100 - view.fiveHour.headroom)}%`;
  return "it is near a limit";
}

/** Pick the account for new work: a new conversation, a subagent, or a helper request. */
export function chooseAccountForNewWork(
  accounts: AccountRouteState[],
  now: number,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): AccountRouteState | null {
  const views = accounts.map((state, index) => viewOf(state, index, now, policy));
  return best(views, policy)?.state ?? null;
}

/** Like chooseAccountForNewWork, with why that account was picked. */
export function routeNewWork(
  accounts: AccountRouteState[],
  now: number,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): { account: string; detail: string } | null {
  const views = accounts.map((state, index) => viewOf(state, index, now, policy));
  const chosen = best(views, policy);
  return chosen ? { account: chosen.state.id, detail: explainChoice(chosen, views, policy) } : null;
}

/** Pick the account for a conversation's next turn. */
export function routeConversation(
  conversation: ConversationRouteState,
  accounts: AccountRouteState[],
  now: number,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RouteDecision {
  const views = accounts.map((state, index) => viewOf(state, index, now, policy));
  const fallback = views[0]?.state.id ?? "main";
  const current = conversation.account ? views.find(view => view.state.id === conversation.account) : undefined;
  const target = best(views, policy);

  if (!current) {
    // New to Claude, or its account was removed.
    const account = target?.state.id ?? fallback;
    const movedFrom = conversation.account && conversation.account !== account ? conversation.account : undefined;
    return {
      account,
      reason: "new",
      ...(movedFrom ? { movedFrom } : {}),
      detail: movedFrom
        ? `account "${movedFrom}" is no longer configured`
        : target ? explainChoice(target, views, policy) : "no account can take it",
    };
  }

  const id = current.state.id;
  // Moving would stop its running background tasks.
  if (conversation.backgroundWork) return { account: id, reason: "background-tasks", detail: "background tasks are running" };

  const stay = (reason: RouteReason, detail: string): RouteDecision => ({ account: id, reason, detail });
  const move = (to: AccountView, reason: RouteReason, detail: string): RouteDecision => ({
    account: to.state.id, reason, movedFrom: id, detail,
  });

  if (!current.usable) {
    const reason: RouteReason = current.state.available ? "account-limited" : "account-unavailable";
    const detail = current.state.available ? `"${id}" is at a usage limit` : `"${id}" is signed out or blocked`;
    if (!target || target.state.id === id) return stay("no-alternative", `${detail} and no other account can take it`);
    return move(target, reason, detail);
  }

  if (conversation.liveProcess) return stay("live-process", "its Claude Code process is still running");
  const warm = conversation.lastUsedAt !== null && now - conversation.lastUsedAt < policy.cacheTtlMs;
  if (warm) return stay("cache-warm", "its prompt cache is warm");

  // Cold cache: the next turn rewrites the cache wherever it runs, so moving
  // costs nothing extra. Move only when it clearly helps: its account is near
  // a limit, or another account's weekly capacity expires clearly sooner.
  if (!target || target.state.id === id) return stay("sticky", "its account is still the best choice");
  if (!current.eligible) {
    if (!target.eligible) return stay("sticky", "no other account has more room");
    return move(target, "cold-move", `${describeWindowLimit(current, policy)} and its cache was cold`);
  }
  if (target.weekly.resetsIn + policy.weeklyResetTieMs < current.weekly.resetsIn) {
    return move(target, "cold-move", `"${target.state.id}" resets its weekly limit sooner, and the cache was cold`);
  }
  return stay("sticky", "its account is still a good choice");
}

/** The transcript notice for a turn that moved to another account. */
export function accountSwitchNotice(decision: RouteDecision): string {
  return `Claude account switched from "${decision.movedFrom}" to "${decision.account}": ${decision.detail}.`;
}
