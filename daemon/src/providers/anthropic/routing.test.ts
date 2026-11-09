import { describe, expect, test } from "bun:test";
import type { UsageData } from "../../messages";
import {
  accountSwitchNotice,
  accountUsableAt,
  chooseAccountForNewWork,
  DEFAULT_ROUTING_POLICY,
  fableAllowanceBackAt,
  fableAllowanceOpen,
  isAccountLimited,
  isFableLimited,
  routeConversation,
  routeNewWork,
  subscriptionsUsableAt,
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

describe("when the subscriptions can take turns again", () => {
  test("the soonest signed-in account, each at the last of its rejection and full windows", () => {
    const accounts = [
      // Weekly full for 2 days, though its rejection ends sooner.
      account("main", usage([40, HOUR], [100, 2 * DAY]), { limitedUntil: NOW + HOUR }),
      // 5-hour full for 3 hours.
      account("max2", usage([100, 3 * HOUR], [60, 4 * DAY])),
      // Signed out: not counted.
      account("max3", usage([100, 10 * MIN], null), { available: false }),
    ];
    expect(subscriptionsUsableAt(accounts, NOW)).toBe(NOW + 3 * HOUR);
  });

  test("now when one can already; null when no full window says when it resets", () => {
    expect(subscriptionsUsableAt([account("main", usage([20, HOUR], [30, DAY]))], NOW)).toBe(NOW);
    expect(subscriptionsUsableAt([account("main", usage([100, null], null))], NOW)).toBeNull();
    expect(subscriptionsUsableAt([account("main", usage([100, null], null)), account("max2", null, { limitedUntil: NOW + DAY })], NOW)).toBe(NOW + DAY);
  });
});

describe("an account with no 5-hour limit", () => {
  const verified = (weekly: [number, number | null]): UsageData => ({ ...usage(null, weekly), noFiveHourLimit: true });

  test("has full 5-hour headroom, and is not limited by it", () => {
    const state = account("main", verified([11, 6 * DAY]));
    expect(isAccountLimited(state, NOW)).toBe(false);
    expect(accountUsableAt(state, NOW)).toBe(NOW);
    expect(subscriptionsUsableAt([state], NOW)).toBe(NOW);
    expect(chooseAccountForNewWork([state], NOW)?.id).toBe("main");
  });

  test("takes the work an account near or at its 5-hour limit cannot", () => {
    const main = account("main", verified([90, 6 * DAY]));
    const near = account("max2", usage([95, HOUR], [10, 6 * DAY]));
    expect(routeNewWork([main, near], NOW)).toEqual({ account: "main", detail: "\"max2\" is below the 5-hour floor" });
    const full = account("max2", usage([100, HOUR], [10, 6 * DAY]));
    expect(routeNewWork([main, full], NOW)).toEqual({ account: "main", detail: "\"max2\" is at a usage limit" });
  });

  test("still ranks on its weekly pace, and its 5-hour figure is never the reason", () => {
    const main = account("main", verified([50, 6 * DAY]));
    const other = account("max2", usage([0, HOUR], [10, 6 * DAY]));
    const picked = routeNewWork([main, other], NOW)!;
    expect(picked.account).toBe("max2");
    expect(picked.detail).toContain("weekly pace");
    expect(picked.detail).not.toContain("5-hour usage");

    // The other way round: the account deep in its 5-hour window is the one named.
    const deep = account("max2", usage([85, HOUR], [10, 6 * DAY]));
    const reason = routeNewWork([account("main", verified([20, 6 * DAY])), deep], NOW)!;
    expect(reason.account).toBe("main");
    expect(reason.detail).toBe("\"max2\"'s 5-hour usage is at 85%");
  });

  test("counts as limited only for its weekly window or a rejection", () => {
    const weekly = account("main", verified([100, 6 * DAY]));
    expect(isAccountLimited(weekly, NOW)).toBe(true);
    expect(accountUsableAt(weekly, NOW)).toBe(NOW + 6 * DAY);
    const rejected = account("main", verified([11, 6 * DAY]), { limitedUntil: NOW + HOUR });
    expect(isAccountLimited(rejected, NOW)).toBe(true);
    expect(accountUsableAt(rejected, NOW)).toBe(NOW + HOUR);
    // Not every account is at a limit while this one has weekly room.
    const other = account("max2", usage([100, HOUR], [100, DAY]));
    expect(chooseAccountForNewWork([account("main", verified([50, 6 * DAY])), other], NOW)?.id).toBe("main");
    expect(chooseAccountForNewWork([weekly, other], NOW)).toBeNull();
  });
});

describe("Fable turns are routed by the Fable allowance too", () => {
  /** Plan usage with room everywhere, and a Fable allowance at `percent` resetting with the week. */
  function withFable(weekly: number, percent: number, extra: Partial<NonNullable<UsageData["fable"]>> = {}): UsageData {
    return { ...usage([10, 2 * HOUR], [weekly, 3 * DAY]), fable: { utilization: percent, resetsAt: NOW + 3 * DAY, allowanceOfWeekly: 50, ...extra } };
  }

  test("an account out of Fable allowance is limited for Fable only", () => {
    const out = account("main", withFable(40, 100));
    const refused = account("max2", withFable(40, 97, { limitedUntil: NOW + DAY }));
    expect(isFableLimited(out, NOW)).toBe(true);
    expect(isFableLimited(refused, NOW)).toBe(true);
    expect(isAccountLimited(out, NOW)).toBe(false);
    // Past its reset the allowance starts over; so does a refusal past its time.
    expect(isFableLimited(out, NOW + 3 * DAY + 1)).toBe(false);
    expect(isFableLimited(refused, NOW + DAY + 1)).toBe(false);
    // No Fable limit on the account, or nothing known of it: not limited.
    expect(isFableLimited(account("a", { ...usage([10, HOUR], [40, DAY]), fable: null }), NOW)).toBe(false);
    expect(isFableLimited(account("a", usage([10, HOUR], [40, DAY])), NOW)).toBe(false);
    expect(fableAllowanceOpen([out, refused], NOW)).toBe(false);
    expect(fableAllowanceBackAt([out, refused], NOW)).toBe(NOW + DAY);
    expect(fableAllowanceOpen([out, account("c", withFable(40, 20))], NOW)).toBe(true);
    // An account at a plan limit has no Fable to give either.
    expect(fableAllowanceOpen([out, account("c", withFable(100, 20))], NOW)).toBe(false);
  });

  test("a Fable conversation leaves an account out of Fable allowance, even with a warm cache; another model's stays", () => {
    const accounts = [account("main", withFable(40, 100)), account("max2", withFable(40, 30))];
    expect(routeConversation(warm("main"), accounts, NOW, DEFAULT_ROUTING_POLICY, true)).toEqual({
      account: "max2", reason: "account-limited", movedFrom: "main", detail: "\"main\" is out of Fable allowance",
    });
    expect(routeConversation(warm("main"), accounts, NOW)).toMatchObject({ account: "main", reason: "cache-warm" });
  });

  test("background tasks do not hold a Fable conversation on an account that cannot run its turn", () => {
    const accounts = [account("main", withFable(40, 100)), account("max2", withFable(40, 30))];
    const busy = conversation({ account: "main", lastUsedAt: NOW - MIN, liveProcess: true, backgroundWork: true });
    expect(routeConversation(busy, accounts, NOW, DEFAULT_ROUTING_POLICY, true)).toMatchObject({ account: "max2", movedFrom: "main" });
    // With allowance left they hold it, as for any turn.
    expect(routeConversation(busy, [account("main", withFable(40, 60)), accounts[1]], NOW, DEFAULT_ROUTING_POLICY, true)).toMatchObject({ account: "main", reason: "background-tasks" });
  });

  test("new Fable work skips an account out of allowance or under its floor, and says why", () => {
    const out = [account("main", withFable(10, 100)), account("max2", withFable(60, 30))];
    expect(routeNewWork(out, NOW, DEFAULT_ROUTING_POLICY, true)).toEqual({ account: "max2", detail: "\"main\" is out of Fable allowance" });
    // Any other model's new work still prefers main, which has far more of its week left.
    expect(routeNewWork(out, NOW)?.account).toBe("main");
    const low = [account("main", withFable(10, 95)), account("max2", withFable(60, 30))];
    expect(routeNewWork(low, NOW, DEFAULT_ROUTING_POLICY, true)).toEqual({ account: "max2", detail: "\"main\" is below the Fable floor" });
    expect(chooseAccountForNewWork(low, NOW, DEFAULT_ROUTING_POLICY, true)?.id).toBe("max2");
  });

  test("Fable work is paced by the tighter of the week and the allowance", () => {
    // main has more of its week left (90 vs 60 points) but less Fable: 20% of a 50-point allowance is 10 weekly points, max2's 80% is 40.
    const accounts = [account("main", withFable(10, 80)), account("max2", withFable(40, 20))];
    expect(routeNewWork(accounts, NOW)?.account).toBe("main");
    const fable = routeNewWork(accounts, NOW, DEFAULT_ROUTING_POLICY, true)!;
    expect(fable.account).toBe("max2");
    expect(fable.detail).toBe("it is furthest behind its weekly pace (40% left over 3 days vs 10% over 3 days)");
    // A cold Fable conversation moves for the same reason.
    expect(routeConversation(cold("main"), accounts, NOW, DEFAULT_ROUTING_POLICY, true)).toMatchObject({ account: "max2", reason: "cold-move", movedFrom: "main" });
  });

  test("with no Fable allowance anywhere a Fable-aware route has nowhere to go: the pool then routes it as another model", () => {
    const accounts = [account("main", withFable(40, 100)), account("max2", withFable(40, 100))];
    expect(routeNewWork(accounts, NOW, DEFAULT_ROUTING_POLICY, true)).toBeNull();
    expect(routeConversation(warm("main"), accounts, NOW, DEFAULT_ROUTING_POLICY, true)).toMatchObject({ account: "main", reason: "no-alternative" });
    expect(routeConversation(warm("main"), accounts, NOW)).toMatchObject({ account: "main", reason: "cache-warm" });
  });
});
