import { afterEach, describe, expect, test } from "bun:test";
import { usageBlock } from "./usage";
import { createInitialState } from "../state";
import { stripAnsi } from "../historycursor";
import { theme } from "../theme";

const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
});

describe("usage status block", () => {
  test("shows now when a zeroed window has no next reset timestamp yet", () => {
    Date.now = () => 1_700_000_000_000;

    const state = createInitialState();
    state.provider = "openai";
    state.authByProvider.openai = true;
    state.usageByProvider.openai = {
      fiveHour: {
        utilization: 0,
        resetsAt: null,
      },
      sevenDay: {
        utilization: 42,
        resetsAt: 1_700_000_000_000 + 2 * 60 * 60 * 1000,
      },
    };

    const block = usageBlock(state);
    expect(block).not.toBeNull();
    expect(stripAnsi(block!.rows[0])).toContain("5-Hour: [");
    expect(stripAnsi(block!.rows[0])).toContain("0% resets in now");
  });

  test("keeps unknown resets as ? when the window still has nonzero utilization", () => {
    Date.now = () => 1_700_000_000_000;

    const state = createInitialState();
    state.provider = "openai";
    state.authByProvider.openai = true;
    state.usageByProvider.openai = {
      fiveHour: {
        utilization: 17,
        resetsAt: null,
      },
      sevenDay: null,
    };

    const block = usageBlock(state);
    expect(block).not.toBeNull();
    expect(stripAnsi(block!.rows[0])).toContain("17% resets in ?");
  });

  test("dims a crossed-out 5-hour bar when only the weekly limit applies", () => {
    Date.now = () => 1_700_000_000_000;

    const state = createInitialState();
    state.provider = "openai";
    state.authByProvider.openai = true;
    state.usageByProvider.openai = {
      fiveHour: null,
      sevenDay: {
        utilization: 42,
        resetsAt: 1_700_000_000_000 + 2 * 60 * 60 * 1000,
      },
    };

    const block = usageBlock(state);
    expect(block).not.toBeNull();
    expect(stripAnsi(block!.rows[0])).toContain("5-Hour: [XXXXXXXXXXXXXXXXXXXX] not applicable");
    expect(stripAnsi(block!.rows[0])).not.toContain("resets in");
    expect(block!.rows[0]).toContain(`${theme.dim}${"X".repeat(20)}`);
    expect(block!.rows[0]).toContain(`${theme.dim}${theme.text}not applicable`);
    expect(stripAnsi(block!.rows[1])).toContain("Weekly: [");
    expect(stripAnsi(block!.rows[1])).toContain("42% resets in 2h:00m");
    expect(stripAnsi(block!.rows[0]).length).toBe(block!.width);
    expect(stripAnsi(block!.rows[1]).length).toBe(block!.width);
  });

  test("combined Claude accounts fill one bar scaled to their capacity and list the two soonest resets", () => {
    const now = 1_700_000_000_000;
    Date.now = () => now;
    const H = 60 * 60 * 1000;

    const state = createInitialState();
    state.provider = "anthropic";
    state.authByProvider.anthropic = true;
    state.usageByProvider.anthropic = {
      capacity: 200,
      fiveHour: { utilization: 100, resetsAt: now + 80 * 60 * 1000, resets: [now + 80 * 60 * 1000, now + 3 * H + 5 * 60 * 1000] },
      sevenDay: { utilization: 150, resetsAt: now + 3 * 24 * H, resets: [now + 3 * 24 * H, now + 5 * 24 * H, now + 6 * 24 * H] },
    };

    const block = usageBlock(state)!;
    const fiveHour = stripAnsi(block.rows[0]);
    const weekly = stripAnsi(block.rows[1]);
    // 100 of 200: half the bar.
    expect(fiveHour).toContain(`[${"\u2588".repeat(10)}${"\u2591".repeat(10)}]`);
    expect(fiveHour).toContain("100/200% resets in 1h20m · 3h05m");
    expect(weekly).toContain(`[${"\u2588".repeat(15)}${"\u2591".repeat(5)}]`);
    expect(weekly).toContain("150/200% resets in 3d · 5d");
    expect(weekly).not.toContain("6d");
    expect(fiveHour.length).toBe(block.width);
    expect(weekly.length).toBe(block.width);
  });

  test("one Claude account keeps the plain 0-100% bar", () => {
    const now = 1_700_000_000_000;
    Date.now = () => now;
    const state = createInitialState();
    state.provider = "anthropic";
    state.authByProvider.anthropic = true;
    state.usageByProvider.anthropic = {
      fiveHour: { utilization: 50, resetsAt: now + 2 * 60 * 60 * 1000 },
      sevenDay: { utilization: 25, resetsAt: now + 2 * 60 * 60 * 1000 },
    };
    const block = usageBlock(state)!;
    expect(stripAnsi(block.rows[0])).toContain("50% resets in 2h:00m");
    expect(stripAnsi(block.rows[0])).not.toContain("/100");
  });
});

describe("API-credit marker", () => {
  function claudeState(active: boolean) {
    const state = createInitialState();
    state.provider = "anthropic";
    state.authByProvider.anthropic = true;
    state.usageByProvider.anthropic = {
      fiveHour: { utilization: 200, resetsAt: null },
      sevenDay: { utilization: 150, resetsAt: null },
      capacity: 200,
      apiCredits: { active, ready: true, label: "main", spentUsd: 1.234, resetAt: null },
    };
    return state;
  }

  test("two short rows beside the bars while turns run on API credits", () => {
    const block = usageBlock(claudeState(true))!;
    const rows = block.rows.map(stripAnsi);
    expect(rows[0]).toMatch(/\] 200\/200% resets in .*  API credits main\s*$/);
    expect(rows[1]).toMatch(/  ≈\$1\.23 this cycle\s*$/);
    expect(block.height).toBe(2);
    expect(rows.every(row => row.length === block.width)).toBe(true);
  });

  test("nothing extra while the subscriptions serve", () => {
    const rows = usageBlock(claudeState(false))!.rows.map(stripAnsi);
    expect(rows.join("\n")).not.toContain("API credits");
  });
});
