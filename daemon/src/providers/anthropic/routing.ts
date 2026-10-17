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
 * New work goes by weekly pace: each account's urgency is the weekly headroom
 * it has left divided by the time until that window resets, the burn rate it
 * needs to use its budget up by its reset. The account furthest behind its
 * pace takes the work, so the accounts converge to the same pace and run out
 * near their own resets, together rather than one after the other. Urgency is
 * damped as an account nears its 5-hour floor, so bursts hand off before a
 * 5-hour window blocks. Near-ties go to the account running fewer turns,
 * since usage readings lag a burst. Floors keep an account out of new work
 * before a window blocks it.
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
  /** 5-hour headroom from which weekly urgency counts in full; it fades linearly to 0 at the floor. */
  fiveHourComfort: number;
  /** Scores within this fraction of the best tie, broken by fewer running turns. */
  scoreTie: number;
  /** A cold conversation moves only to an account scoring at least this many times its own. */
  coldMoveRatio: number;
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
  fiveHourComfort: 40,
  scoreTie: 0.1,
  coldMoveRatio: 1.25,
};

const HOUR = 60 * 60_000;
/** A weekly window that has not started yet runs this long from first use. */
const WEEK = 7 * 24 * HOUR;

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
  /** Time until the window resets, null when unknown or passed. A window at 0% still counts down. */
  resetsIn: number | null;
}

function windowView(window: UsageWindow | null | undefined, now: number): WindowView {
  if (!window) return { headroom: 100, resetsIn: null };
  if (window.resetsAt !== null && window.resetsAt <= now) return { headroom: 100, resetsIn: null };
  return { headroom: Math.max(0, 100 - window.utilization), resetsIn: window.resetsAt === null ? null : window.resetsAt - now };
}

interface AccountView {
  state: AccountRouteState;
  index: number;
  fiveHour: WindowView;
  weekly: WindowView;
  /** Time left to use the weekly headroom: until its reset, or a full week from first use. */
  weeklySpan: number;
  /** Weekly headroom per hour left: the pace that uses it up right at its reset. */
  urgency: number;
  /** Urgency damped near the 5-hour floor; the highest takes new work. */
  score: number;
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

/** 0 at the 5-hour floor, rising linearly to 1 at the comfort level. */
function fiveHourDamping(headroom: number, policy: RoutingPolicy): number {
  const span = policy.fiveHourComfort - policy.fiveHourFloor;
  if (span <= 0) return headroom >= policy.fiveHourFloor ? 1 : 0;
  return Math.min(1, Math.max(0, (headroom - policy.fiveHourFloor) / span));
}

function viewOf(state: AccountRouteState, index: number, now: number, policy: RoutingPolicy): AccountView {
  const fiveHour = windowView(state.usage?.fiveHour, now);
  const weekly = windowView(state.usage?.sevenDay, now);
  const usable = state.available && !isAccountLimited(state, now);
  const eligible = usable && fiveHour.headroom >= policy.fiveHourFloor && weekly.headroom >= policy.weeklyFloor;
  // A window not started yet begins a full week at first use; at least a
  // minute, so an imminent reset ranks high without dividing by zero.
  const weeklySpan = Math.max(60_000, weekly.resetsIn ?? WEEK);
  const urgency = weekly.headroom / (weeklySpan / HOUR);
  const score = urgency * fiveHourDamping(fiveHour.headroom, policy);
  return { state, index, fiveHour, weekly, weeklySpan, urgency, score, usable, eligible };
}

/**
 * Rank candidates for new work: the highest score first, except that scores
 * within `scoreTie` of the best count as a tie, broken by the fewest running
 * turns (usage readings lag, so a burst would otherwise all land on one
 * account), then the higher score, then the account order.
 */
function rank(candidates: AccountView[], policy: RoutingPolicy): AccountView[] {
  const byScore = [...candidates].sort((a, b) => b.score - a.score || a.index - b.index);
  const top = byScore[0]?.score ?? 0;
  const tied = byScore.filter(view => view.score >= top * (1 - policy.scoreTie))
    .sort((a, b) => a.state.activeTurns - b.state.activeTurns || b.score - a.score || a.index - b.index);
  return [...tied, ...byScore.filter(view => !tied.includes(view))];
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

/** "6.2 days", "5 hours", "40 minutes". */
function formatSpan(ms: number): string {
  const [value, unit] = ms >= 24 * HOUR ? [ms / (24 * HOUR), "day"] : ms >= HOUR ? [ms / HOUR, "hour"] : [ms / 60_000, "minute"];
  const shown = Number(value.toFixed(unit === "minute" ? 0 : 1));
  return `${shown} ${unit}${shown === 1 ? "" : "s"}`;
}

/**
 * Why `ahead` scores above `behind`: further behind its weekly pace, or else
 * `behind` is deep into its 5-hour window. `subject` names `ahead`
 * ("it is furthest", "\"max2\" is further"), `fiveHourOf` is `behind`'s
 * possessive ("its", "\"main\"'s").
 */
function paceReason(ahead: AccountView, behind: AccountView, subject: string, fiveHourOf: string): string {
  if (ahead.urgency > behind.urgency) {
    const pace = (view: AccountView) => `${Math.round(view.weekly.headroom)}%`;
    return `${subject} behind its weekly pace (${pace(ahead)} left over ${formatSpan(ahead.weeklySpan)} vs ${pace(behind)} over ${formatSpan(behind.weeklySpan)})`;
  }
  return `${fiveHourOf} 5-hour usage is at ${Math.round(100 - behind.fiveHour.headroom)}%`;
}

/** Why `chosen` won over the other accounts, for logs and notices. */
function explainChoice(chosen: AccountView, views: AccountView[], policy: RoutingPolicy): string {
  const others = views.filter(view => view !== chosen);
  if (!chosen.eligible) return `every account is below a usage floor; "${chosen.state.id}" has the most headroom`;
  const unfit = others.filter(view => !view.eligible).map(view => whyUnfit(view, policy));
  const runnerUp = rank(others.filter(view => view.eligible), policy)[0];
  let why: string | null = null;
  if (runnerUp) {
    const tie = runnerUp.score >= Math.max(chosen.score, runnerUp.score) * (1 - policy.scoreTie);
    if (tie && chosen.state.activeTurns < runnerUp.state.activeTurns) why = "it runs fewer turns (pace tie)";
    else if (chosen.score > runnerUp.score) why = paceReason(chosen, runnerUp, "it is furthest", `"${runnerUp.state.id}"'s`);
    else why = "first in account order (pace tie)";
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
  // a limit, or another account scores clearly higher (the margin keeps
  // conversations from ping-ponging between accounts at about the same pace).
  if (!target || target.state.id === id) return stay("sticky", "its account is still the best choice");
  if (!current.eligible) {
    if (!target.eligible) return stay("sticky", "no other account has more room");
    return move(target, "cold-move", `${describeWindowLimit(current, policy)} and its cache was cold`);
  }
  if (target.score > current.score && target.score >= policy.coldMoveRatio * current.score) {
    const why = paceReason(target, current, `"${target.state.id}" is further`, "its");
    return move(target, "cold-move", `${why}, and the cache was cold`);
  }
  return stay("sticky", "its account is still a good choice");
}

/** The transcript notice for a turn that moved to another account. */
export function accountSwitchNotice(decision: RouteDecision): string {
  return `Claude account switched from "${decision.movedFrom}" to "${decision.account}": ${decision.detail}.`;
}
