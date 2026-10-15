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

describe("routing new work: soonest-expiring capacity first", () => {
  test("goes to the account whose weekly window resets soonest", () => {
    const accounts = [
      account("main", usage([20, 3 * HOUR], [40, 5 * DAY])),
      account("max2", usage([20, 3 * HOUR], [60, 1 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
    expect(routeConversation(conversation(), accounts, NOW)).toMatchObject({ account: "max2", reason: "new" });
  });

  test("an unstarted window loses nothing by waiting, so it is used last", () => {
    const accounts = [
      account("main", usage(null, [0, null])),
      account("max2", usage([5, 4 * HOUR], [30, 6 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
  });

  test("weekly resets within the tie window fall back to the soonest 5-hour reset", () => {
    const accounts = [
      account("main", usage([30, 4 * HOUR], [50, 3 * DAY])),
      account("max2", usage([30, 1 * HOUR], [50, 3 * DAY + 2 * HOUR])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
  });

  test("then the most headroom, then the fewest running turns, then account order", () => {
    const same = (util: number, extra: Partial<AccountRouteState> = {}) => (id: string) =>
      account(id, usage([util, 2 * HOUR], [util, 2 * DAY]), extra);
    expect(chooseAccountForNewWork([same(50)("main"), same(30)("max2")], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([same(30, { activeTurns: 3 })("main"), same(30)("max2")], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([same(30)("main"), same(30)("max2")], NOW)?.id).toBe("main");
  });

  test("an account soon to reset weekly but nearly out of 5-hour headroom does not get the work", () => {
    const accounts = [
      account("main", usage([95, 3 * HOUR], [40, 12 * HOUR])),
      account("max2", usage([10, 4 * HOUR], [40, 6 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("max2");
  });

  test("the weekly floor keeps an account from being driven into a weekly block", () => {
    const accounts = [
      account("main", usage([10, 3 * HOUR], [93, 1 * DAY])),
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
  });

  test("signed-out, blocked and limited accounts are skipped", () => {
    const soon = usage([10, 1 * HOUR], [10, 1 * DAY]);
    const later = usage([10, 1 * HOUR], [10, 6 * DAY]);
    expect(chooseAccountForNewWork([account("main", soon, { available: false }), account("max2", later)], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([account("main", soon, { limitedUntil: NOW + HOUR }), account("max2", later)], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([account("main", usage([100, HOUR], [10, DAY])), account("max2", later)], NOW)?.id).toBe("max2");
    expect(chooseAccountForNewWork([account("main", soon, { available: false })], NOW)).toBeNull();
  });

  test("a window past its reset counts as unused", () => {
    const accounts = [
      account("main", usage([100, -5 * MIN], [50, 2 * DAY])),
      account("max2", usage([10, 2 * HOUR], [50, 5 * DAY])),
    ];
    expect(chooseAccountForNewWork(accounts, NOW)?.id).toBe("main");
  });
});

describe("routing an existing conversation", () => {
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

  test("a cold cache moves when another account's weekly capacity expires clearly sooner", () => {
    const decision = routeConversation(cold("main"), accounts(), NOW);
    expect(decision).toMatchObject({ account: "max2", reason: "cold-move", movedFrom: "main" });
  });

  test("a cold cache stays when the accounts are about equal (no ping-pong)", () => {
    const close = [
      account("main", usage([40, 3 * HOUR], [50, 2 * DAY])),
      account("max2", usage([10, 1 * HOUR], [20, 2 * DAY - 3 * HOUR])),
    ];
    expect(routeConversation(cold("main"), close, NOW)).toMatchObject({ account: "main", reason: "sticky" });
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
      .toBe("its weekly limit resets soonest");
    expect(detail([account("main", usage([20, 4 * HOUR], [40, 2 * DAY])), account("max2", usage([20, 20 * MIN], [40, 2 * DAY + HOUR]))]))
      .toBe("its 5-hour limit resets soonest (weekly resets tie)");
    expect(detail([account("main", usage([50, HOUR], [40, DAY])), account("max2", usage([20, HOUR], [40, DAY]))]))
      .toBe("it has the most headroom (resets tie)");
    expect(detail([account("main", usage([20, HOUR], [40, DAY]), { activeTurns: 2 }), account("max2", usage([20, HOUR], [40, DAY]))]))
      .toBe("it runs the fewest turns (resets and headroom tie)");
    expect(detail([account("main", usage([20, HOUR], [40, DAY])), account("max2", usage([20, HOUR], [40, DAY]))]))
      .toBe("first in account order (resets and headroom tie)");
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
    expect(routeConversation(conversation(), accounts, NOW)).toEqual({ account: "max2", reason: "new", detail: "its weekly limit resets soonest" });
  });
});
