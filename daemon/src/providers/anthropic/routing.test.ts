import { describe, expect, test } from "bun:test";
import type { UsageData } from "../../messages";
import {
  accountSwitchNotice,
  chooseAccountForNewWork,
  DEFAULT_ROUTING_POLICY,
  routeConversation,
  routeNewWork,
  type AccountRouteState,
  type ConversationRouteState,
} from "./routing";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function usage(fiveHour: [number, number | null] | null, weekly: [number, number | null] | null): UsageData {
  return {
    fiveHour: fiveHour ? { utilization: fiveHour[0], resetsAt: fiveHour[1] === null ? null : NOW + fiveHour[1] } : null,
    sevenDay: weekly ? { utilization: weekly[0], resetsAt: weekly[1] === null ? null : NOW + weekly[1] } : null,
  };
}

function account(id: string, data: UsageData | null, extra: Partial<AccountRouteState> = {}): AccountRouteState {
  return { id, available: true, limitedUntil: null, usage: data, activeTurns: 0, ...extra };
}

function conversation(extra: Partial<ConversationRouteState> = {}): ConversationRouteState {
  return { account: null, lastUsedAt: null, liveProcess: false, backgroundWork: false, ...extra };
}

const cold = (id: string) => conversation({ account: id, lastUsedAt: NOW - 2 * HOUR });
const warm = (id: string) => conversation({ account: id, lastUsedAt: NOW - 10 * MIN });

describe("routing new work: furthest behind its weekly pace first", () => {
  test("an idle account whose 0% week is already counting down beats one burning slower than it needs (live case)", () => {
    // main: 100% left over 154 h (0.65 points/h needed); max2: 74% over 149 h (0.50).
    const accounts = [
      account("main", usage([0, null], [0, 154 * HOUR])),
      account("max2", usage([58, 3.8 * HOUR], [26, 149 * HOUR])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("main");
    expect(routeNewWork(accounts, NOW)).toEqual({
      account: "main",
      detail: "it is furthest behind its weekly pace (100% left over 6.4 days vs 74% over 6.2 days)",
    });
  });

  test("with equal headroom the sooner weekly reset wins", () => {
    const accounts = [
      account("main", usage([20, 3 * HOUR], [40, 5 * DAY])),
      account("max2", usage([20, 3 * HOUR], [40, 1 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
    expect(routeConversation(conversation(), accounts, NOW)).toMatchObject({ account: "max2", reason: "new" });
  });

  test("with equal resets the account with more headroom wins", () => {
    const accounts = [
      account("main", usage([20, 3 * HOUR], [50, 3 * DAY])),
      account("max2", usage([20, 3 * HOUR], [20, 3 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
  });

  test("a window not started yet counts as 100% over a full week from first use", () => {
    // 100/168 h = 0.60 points/h against 70/144 h = 0.49.
    const fresh = [account("main", usage(null, [0, null])), account("max2", usage([5, 4 * HOUR], [30, 6 * DAY]))];
    expect(routeNewWork(fresh, NOW)).toEqual({
      account: "main",
      detail: "it is furthest behind its weekly pace (100% left over 7 days vs 70% over 6 days)",
    });
    expect(chooseAccountForNewWork([account("main", null), fresh[1]], NOW)?.id).toBe("main");
    // A fresh week still waits behind capacity about to expire: 20% left in 12 h is 1.67 points/h.
    const expiring = [account("main", usage(null, [0, null])), account("max2", usage([5, 4 * HOUR], [80, 12 * HOUR]))];
    expect(chooseAccountForNewWork(expiring, NOW)?.id).toBe("max2");
  });

  test("an urgent account deep into its 5-hour window hands off, smoothly", () => {
    // main needs 2.5 points/h against max2's 0.42, but 12% 5-hour headroom damps it to 0.17.
    const deep = [
      account("main", usage([88, 2 * HOUR], [40, 1 * DAY])),
      account("max2", usage([10, 4 * HOUR], [40, 6 * DAY])),
    ];
    expect(routeNewWork(deep, NOW)).toEqual({ account: "max2", detail: "\"main\"'s 5-hour usage is at 88%" });
    // At 20% 5-hour headroom it is damped to a third (0.83): still ahead.
    const partial = [account("main", usage([80, 2 * HOUR], [40, 1 * DAY])), deep[1]];
    expect(chooseAccountForNewWork(partial, NOW)?.id).toBe("main");
  });

  test("a burst spreads across accounts whose pace ties, by running turns", () => {
    // 60/120 h = 0.50 and 56/120 h = 0.47: within 10%.
    const pair = (mainTurns: number, max2Turns: number) => [
      account("main", usage([20, 3 * HOUR], [40, 5 * DAY]), { activeTurns: mainTurns }),
      account("max2", usage([20, 3 * HOUR], [44, 5 * DAY]), { activeTurns: max2Turns }),
    ];
    const placed: string[] = [];
    const turns: Record<string, number> = { main: 0, max2: 0 };
    for (let i = 0; i < 4; i++) {
      const id = chooseAccountForNewWork(pair(turns.main, turns.max2), NOW)!.id;
      placed.push(id);
      turns[id] += 1;
    }
    expect(placed).toEqual(["main", "max2", "main", "max2"]);
    expect(routeNewWork(pair(2, 0), NOW)?.detail).toBe("it runs fewer turns (pace tie)");
    expect(routeNewWork(pair(0, 0), NOW)?.detail).toBe("it is furthest behind its weekly pace (60% left over 5 days vs 56% over 5 days)");
  });

  test("outside the tie, running turns do not matter", () => {
    // 60/120 h = 0.50 against 50/120 h = 0.42.
    const accounts = [
      account("main", usage([20, 3 * HOUR], [40, 5 * DAY]), { activeTurns: 3 }),
      account("max2", usage([20, 3 * HOUR], [50, 5 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("main");
  });

  test("an exact tie goes by account order", () => {
    const same = (id: string) => account(id, usage([30, 2 * HOUR], [30, 2 * DAY]));
    expect(routeNewWork([same("main"), same("max2")], NOW)).toEqual({ account: "main", detail: "first in account order (pace tie)" });
  });

  test("the weekly floor keeps an account from being driven into a weekly block", () => {
    const accounts = [
      account("main", usage([10, 3 * HOUR], [93, 1 * DAY])),
      account("max2", usage([10, 3 * HOUR], [40, 6 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
  });

  test("the 5-hour floor does the same for the 5-hour window", () => {
    const accounts = [
      account("main", usage([91, 3 * HOUR], [10, 1 * HOUR])),
      account("max2", usage([10, 3 * HOUR], [40, 6 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
  });

  test("below every floor it still runs, on the account with the most headroom", () => {
    const accounts = [
      account("main", usage([95, 3 * HOUR], [50, 1 * DAY])),
      account("max2", usage([20, 3 * HOUR], [94, 6 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
    // Equal smallest headroom: the weekly one decides, then account order.
    expect(chooseAccountForNewWork([account("main", usage([95, HOUR], [50, DAY])), account("max2", usage([95, HOUR], [80, DAY]))], NOW)?.id)
      .toBe("main");
    expect(chooseAccountForNewWork([account("main", usage([95, HOUR], [50, DAY])), account("max2", usage([95, HOUR], [50, DAY]))], NOW)?.id)
      .toBe("main");
  });

  test("signed-out, blocked and limited accounts are skipped", () => {
    const soon = usage([10, 1 * HOUR], [10, 1 * DAY]);
    const later = usage([10, 1 * HOUR], [10, 6 * DAY]);
    expect(chooseAccountForNewWork([account("main", soon, { available: false }), account("max2", later)], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([account("main", soon, { limitedUntil: NOW + HOUR }), account("max2", later)], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([account("main", usage([100, HOUR], [10, DAY])), account("max2", later)], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([account("main", soon, { available: false })], NOW)).toBeNull();
    // Below every floor and the only other account is limited: still the one that can run it.
    expect(chooseAccountForNewWork([account("main", usage([95, HOUR], [10, DAY])), account("max2", later, { limitedUntil: NOW + HOUR })], NOW)?.id)
      .toBe("main");
  });

  test("a window past its reset counts as unused", () => {
    const accounts = [
      account("main", usage([100, -5 * MIN], [50, 2 * DAY])),
      account("max2", usage([10, 2 * HOUR], [50, 5 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("main");
    // A passed weekly reset is a fresh week: 100/168 h against 50/120 h.
    const week = [account("main", usage([10, HOUR], [90, -MIN])), account("max2", usage([10, HOUR], [50, 5 * DAY]))];
    expect(chooseAccountForNewWork(week, NOW)?.id).toBe("main");
  });
});

describe("routing an existing conversation", () => {
  // main: 50/120 h = 0.42; max2: 80/24 h = 3.3.
  const accounts = () => [
    account("main", usage([40, 3 * HOUR], [50, 5 * DAY])),
    account("max2", usage([10, 3 * HOUR], [20, 1 * DAY])),
  ];

  test("a warm cache stays on its account even when another would be preferred", () => {
    expect(routeConversation(warm("main"), accounts(), NOW)).toMatchObject({ account: "main", reason: "cache-warm" });
  });

  test("the cache counts as warm for the one-hour TTL Claude Code uses on subscriptions", () => {
    expect(DEFAULT_ROUTING_POLICY.cacheTtlMs).toBe(HOUR);
    const almost = conversation({ account: "main", lastUsedAt: NOW - HOUR + MIN });
    expect(routeConversation(almost, accounts(), NOW).reason).toBe("cache-warm");
  });

  test("a live process or background tasks keep it on its account", () => {
    expect(routeConversation(conversation({ account: "main", liveProcess: true }), accounts(), NOW).reason).toBe("live-process");
    const limited = [account("main", null, { limitedUntil: NOW + HOUR }), accounts()[1]];
    expect(routeConversation(conversation({ account: "main", liveProcess: true, backgroundWork: true }), limited, NOW))
      .toMatchObject({ account: "main", reason: "background-tasks" });
  });

  test("a cold cache moves when another account is clearly further behind its pace", () => {
    const decision = routeConversation(cold("main"), accounts(), NOW);
    expect(decision).toMatchObject({ account: "max2", reason: "cold-move", movedFrom: "main" });
    expect(accountSwitchNotice(decision)).toBe("Claude account switched from \"main\" to \"max2\": "
      + "\"max2\" is further behind its weekly pace (80% left over 1 day vs 50% over 5 days), and the cache was cold.");
  });

  test("a cold cache moves only past the hysteresis margin (no ping-pong)", () => {
    // main 50/96 h = 0.52; max2 60/96 h = 0.63: max2 takes new work (1.2×) but a cold conversation stays.
    const close = [
      account("main", usage([20, 3 * HOUR], [50, 4 * DAY])),
      account("max2", usage([20, 3 * HOUR], [40, 4 * DAY])),
    ];
    expect(chooseAccountForNewWork(close, NOW)?.id).toBe("max2");
    expect(routeConversation(cold("main"), close, NOW)).toMatchObject({ account: "main", reason: "sticky" });
    expect(routeConversation(cold("max2"), close, NOW)).toMatchObject({ account: "max2", reason: "sticky" });
    // 65/96 h = 0.68 is 1.3×: now it moves.
    const apart = [close[0], account("max2", usage([20, 3 * HOUR], [35, 4 * DAY]))];
    expect(routeConversation(cold("main"), apart, NOW)).toMatchObject({ account: "max2", reason: "cold-move" });
  });

  test("a cold cache on an account deep into its 5-hour window moves before the floor", () => {
    const deep = [
      account("main", usage([80, 2 * HOUR], [50, 4 * DAY])),
      account("max2", usage([20, 3 * HOUR], [50, 4 * DAY])),
    ];
    const decision = routeConversation(cold("main"), deep, NOW);
    expect(decision).toMatchObject({ account: "max2", reason: "cold-move", movedFrom: "main" });
    expect(decision.detail).toBe("its 5-hour usage is at 80%, and the cache was cold");
  });

  test("a cold cache on an account near a limit moves to one with room", () => {
    const near = [
      account("main", usage([93, 3 * HOUR], [50, 1 * DAY])),
      account("max2", usage([10, 3 * HOUR], [20, 6 * DAY])),
    ];
    const decision = routeConversation(cold("main"), near, NOW);
    expect(decision).toMatchObject({ account: "max2", reason: "cold-move", movedFrom: "main" });
    expect(decision.detail).toContain("5-hour usage is at 93%");
  });

  test("a cold cache below a floor stays when no account is above both", () => {
    const low = [
      account("main", usage([95, 3 * HOUR], [50, 1 * DAY])),
      account("max2", usage([20, 3 * HOUR], [94, 6 * DAY])),
    ];
    expect(routeConversation(cold("main"), low, NOW)).toMatchObject({ account: "main", reason: "sticky" });
  });

  test("a warm cache near (but not at) a limit stays", () => {
    const near = [
      account("main", usage([93, 3 * HOUR], [50, 1 * DAY])),
      account("max2", usage([10, 3 * HOUR], [20, 6 * DAY])),
    ];
    expect(routeConversation(warm("main"), near, NOW).account).toBe("main");
  });

  test("an account at its limit or signed out moves even a warm conversation", () => {
    const limited = [account("main", usage([100, 2 * HOUR], [50, 5 * DAY])), accounts()[1]];
    expect(routeConversation(warm("main"), limited, NOW)).toMatchObject({ account: "max2", reason: "account-limited", movedFrom: "main" });
    const rejected = [account("main", null, { limitedUntil: NOW + HOUR }), accounts()[1]];
    expect(routeConversation(warm("main"), rejected, NOW).reason).toBe("account-limited");
    const signedOut = [account("main", null, { available: false }), accounts()[1]];
    expect(routeConversation(conversation({ account: "main", liveProcess: true }), signedOut, NOW))
      .toMatchObject({ account: "max2", reason: "account-unavailable" });
  });

  test("with nowhere to go it stays (the turn reports the limit)", () => {
    const both = [account("main", null, { limitedUntil: NOW + HOUR }), account("max2", null, { available: false })];
    expect(routeConversation(warm("main"), both, NOW)).toMatchObject({ account: "main", reason: "no-alternative" });
  });

  test("a conversation whose account was removed is routed as new and announced", () => {
    const decision = routeConversation(cold("gone"), accounts(), NOW);
    expect(decision).toMatchObject({ account: "max2", reason: "new", movedFrom: "gone" });
  });
});

describe("switch notice", () => {
  test("names both accounts and the reason", () => {
    expect(accountSwitchNotice({ account: "max2", movedFrom: "main", reason: "account-limited", detail: "\"main\" is at a usage limit" }))
      .toBe("Claude account switched from \"main\" to \"max2\": \"main\" is at a usage limit.");
  });
});

describe("why new work went where it did", () => {
  const detail = (accounts: AccountRouteState[]) => routeNewWork(accounts, NOW)?.detail;

  test("names the deciding rule", () => {
    expect(detail([account("main", usage([20, 3 * HOUR], [40, 5 * DAY])), account("max2", usage([20, 3 * HOUR], [40, 1 * DAY]))]))
      .toBe("it is furthest behind its weekly pace (60% left over 1 day vs 60% over 5 days)");
    expect(detail([account("main", usage([20, 3 * HOUR], [40, 30 * HOUR])), account("max2", usage([20, 3 * HOUR], [90, 3 * HOUR]))]))
      .toBe("it is furthest behind its weekly pace (10% left over 3 hours vs 60% over 1.3 days)");
    expect(detail([account("main", usage([20, 3 * HOUR], [40, 5 * DAY])), account("max2", usage([20, 3 * HOUR], [90, 30 * MIN]))]))
      .toBe("it is furthest behind its weekly pace (10% left over 30 minutes vs 60% over 5 days)");
  });

  test("names the accounts it skipped and why", () => {
    const later = usage([10, HOUR], [10, 6 * DAY]);
    expect(detail([account("main", usage([95, HOUR], [10, DAY])), account("max2", later)])).toBe("\"main\" is below the 5-hour floor");
    expect(detail([account("main", usage([10, HOUR], [95, DAY])), account("max2", later)])).toBe("\"main\" is below the weekly floor");
    expect(detail([account("main", later, { limitedUntil: NOW + HOUR }), account("max2", later)])).toBe("\"main\" is at a usage limit");
    expect(detail([account("main", later, { available: false }), account("max2", later)])).toBe("\"main\" is signed out or blocked");
  });

  test("says when every account is below a floor", () => {
    expect(detail([account("main", usage([97, HOUR], [40, HOUR])), account("max2", usage([93, HOUR], [40, 5 * DAY]))]))
      .toBe("every account is below a usage floor; \"max2\" has the most headroom");
  });

  test("a new conversation's decision carries the same reason", () => {
    const accounts = [account("main", usage([20, 3 * HOUR], [40, 5 * DAY])), account("max2", usage([20, 3 * HOUR], [40, 1 * DAY]))];
    expect(routeConversation(conversation(), accounts, NOW)).toEqual({
      account: "max2", reason: "new", detail: "it is furthest behind its weekly pace (60% left over 1 day vs 60% over 5 days)",
    });
  });
});
