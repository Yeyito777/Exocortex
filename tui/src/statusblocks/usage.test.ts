import { afterEach, describe, expect, test } from "bun:test";
import { usageBlock, usageSummary } from "./usage";
import { renderStatusLine } from "../statusline";
import type { ApiCreditGrantLeft, ApiCreditsUsage } from "../messages";
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

  test("the balance of the key in use: ≈ while an estimate, red under a tenth", () => {
    const state = claudeState(true);
    const credits = state.usageByProvider.anthropic!.apiCredits!;
    Object.assign(credits, { balanceUsd: 688.4, grantedUsd: 700, approximate: false });
    let block = usageBlock(state)!;
    expect(stripAnsi(block.rows[1])).toMatch(/  \$688 left\s*$/);
    expect(block.rows[1]).toContain(theme.accent);
    expect(block.rows.map(stripAnsi).every(row => row.length === block.width)).toBe(true);
    expect(usageSummary(state)).toContain("on API credits (main), $688 left, ≈$1.23 this cycle");
    Object.assign(credits, { balanceUsd: 15, approximate: true });
    block = usageBlock(state)!;
    expect(stripAnsi(block.rows[1])).toMatch(/  ≈\$15 left\s*$/);
    expect(block.rows[1]).toContain(theme.error);
  });

  test("an older daemon (no pool) keeps the bars beside the marker", () => {
    const rows = usageBlock(claudeState(true))!.rows.map(stripAnsi);
    expect(rows[0]).toContain("5-Hour: [");
    expect(rows.join("\n")).not.toContain("Credit:");
  });

  test("nothing extra while the subscriptions serve", () => {
    const rows = usageBlock(claudeState(false))!.rows.map(stripAnsi);
    expect(rows.join("\n")).not.toContain("API credits");
  });
});

describe("Claude on API credits: Credit and Expiry rows", () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const D = 24 * H;
  const grant = (leftUsd: number, grantedUsd: number, days: number | null): ApiCreditGrantLeft =>
    ({ leftUsd, grantedUsd, expiresAt: days === null ? null : NOW + days * D + H });

  function creditState(extra: Partial<ApiCreditsUsage> = {}, grants = [grant(500, 500, 170), grant(162, 200, 12), grant(200, 200, 19)]) {
    Date.now = () => NOW;
    const state = createInitialState();
    state.provider = "anthropic";
    state.authByProvider.anthropic = true;
    state.usageByProvider.anthropic = {
      capacity: 200,
      fiveHour: { utilization: 200, resetsAt: NOW + 2 * H },
      sevenDay: { utilization: 150, resetsAt: NOW + 3 * D },
      apiCredits: {
        active: true, ready: true, label: "main", spentUsd: 1.234, resetAt: null,
        // The key in use's own balance: older TUIs show it; the rows show the pool.
        balanceUsd: 662, grantedUsd: 700, approximate: false,
        pool: { balanceUsd: grants.reduce((sum, g) => sum + g.leftUsd, 0), grantedUsd: grants.reduce((sum, g) => sum + g.grantedUsd, 0), approximate: false, grants },
        subscriptionsBackAt: NOW + D + 4 * H + 60_000,
        ...extra,
      },
    };
    return state;
  }

  function subscriptionState() {
    const state = creditState();
    state.usageByProvider.anthropic!.apiCredits!.active = false;
    return state;
  }

  test("replace the bars: the pool over everything granted, every grant soonest first, no account names", () => {
    const block = usageBlock(creditState())!;
    const rows = block.rows.map(stripAnsi);
    const credit = `  Credit: [${"\u2588".repeat(19)}${"\u2591"}] $862 / $900`;
    const expiry = "  Expiry: $162 12d · $200 19d · $500 170d";
    const col = Math.max(credit.length, expiry.length) + 3;
    expect(rows[0].trimEnd()).toBe(`${credit.padEnd(col)}API credits`);
    expect(rows[1].trimEnd()).toBe(`${expiry.padEnd(col)}subs back 1d4h`);
    expect(rows.every(row => row.length === block.width)).toBe(true);
    expect(block.width).toBe(col + "subs back 1d4h".length);
    const text = rows.join("\n");
    for (const gone of ["5-Hour", "Weekly", "main", "$662", "left"]) expect(text).not.toContain(gone);
    // Colours: the bar accent, the amounts plain green, the grant muted, the label warning, the time accent, the separators dim.
    expect(block.rows[0]).toContain(`${theme.accent}\u2588`);
    expect(block.rows[0]).toContain(`${theme.success}$862`);
    expect(block.rows[0]).not.toContain(theme.bold);
    expect(block.rows[0]).toContain(`${theme.muted} / $900`);
    expect(block.rows[0]).toContain(`${theme.warning}API credits`);
    expect(block.rows[1]).toContain(`${theme.success}$162`);
    expect(block.rows[1]).not.toContain(theme.bold);
    expect(block.rows[1]).toContain(`${theme.dim} · `);
    expect(block.rows[1]).toContain(`${theme.accent}1d4h`);
  });

  test("labels share the window labels' width: the bar does not move between subscription and credits", () => {
    const credits = usageBlock(creditState())!.rows.map(stripAnsi);
    const bars = usageBlock(subscriptionState())!.rows.map(stripAnsi);
    expect(bars[0]).toStartWith("  5-Hour: [");
    expect(bars[1]).toStartWith("  Weekly: [");
    expect(credits[0]).toStartWith("  Credit: [");
    expect(credits[1]).toStartWith("  Expiry: $");
    expect(credits[0].indexOf("[")).toBe(bars[0].indexOf("["));
    expect(credits[0].indexOf("]")).toBe(bars[0].indexOf("]"));
    expect(credits[1].indexOf("$")).toBe(bars[1].indexOf("["));
  });

  test("the right column starts 3 after the longer left row, wherever that is", () => {
    // Long Expiry row: the column follows it.
    let rows = usageBlock(creditState({}, [grant(100, 100, 3), grant(100, 100, 30), grant(100, 100, 60), grant(100, 100, 300)]))!.rows.map(stripAnsi);
    expect(rows[1].indexOf("subs back")).toBe("  Expiry: $100 3d · $100 30d · $100 60d · $100 300d".length + 3);
    expect(rows[0].indexOf("API credits")).toBe(rows[1].indexOf("subs back"));
    // One grant: the Credit row is longer.
    rows = usageBlock(creditState({}, [grant(40, 200, 12)]))!.rows.map(stripAnsi);
    expect(rows[0].indexOf("API credits")).toBe(`  Credit: [${"x".repeat(20)}] $40 / $200`.length + 3);
  });

  test("an unknown or past return time leaves the second right row blank", () => {
    for (const subscriptionsBackAt of [null, undefined, NOW - 1]) {
      const block = usageBlock(creditState({ subscriptionsBackAt }))!;
      const rows = block.rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toEndWith("   API credits");
      expect(rows[1]).not.toContain("subs back");
      expect(block.width).toBe(rows[0].trimEnd().length);
    }
  });

  test("sorting and filtering: soonest expiry first, never-expiring last, used-up and expired grants left out", () => {
    const rows = usageBlock(creditState({}, [grant(300, 300, null), grant(0.2, 200, 2), grant(50, 50, -1), grant(20, 20, 0.5), grant(80, 100, 40)]))!.rows.map(stripAnsi);
    expect(rows[1]).toStartWith("  Expiry: $20 13h · $80 40d · $300 no expiry ");
  });

  test("≈ while an estimate or stale, red under a tenth, sign-in needed beside it", () => {
    const state = creditState();
    const pool = state.usageByProvider.anthropic!.apiCredits!.pool!;
    Object.assign(pool, { approximate: true });
    let block = usageBlock(state)!;
    expect(stripAnsi(block.rows[0])).toContain("] ≈$862 / $900");
    Object.assign(pool, { balanceUsd: 80, signInNeeded: true });
    block = usageBlock(state)!;
    expect(stripAnsi(block.rows[0])).toContain(`[${"\u2588".repeat(2)}${"\u2591".repeat(18)}] ≈$80 / $900 sign-in needed   API credits`);
    expect(block.rows[0]).toContain(`${theme.error}≈$80`);
    expect(block.rows[0]).toContain(`${theme.error}${"\u2588".repeat(2)}`);
  });

  test("narrow terminals: the right column goes first, then the Expiry list shortens to +N, then the block", () => {
    const grants = [grant(10, 10, 3), grant(20, 20, 30), grant(30, 30, 60), grant(40, 40, 90), grant(50, 50, 120)];
    const state = creditState({}, grants);
    state.sidebar.open = false;
    const block = usageBlock(state)!;
    const draw = (cols: number) => renderStatusLine(state, cols).lines.map(stripAnsi);
    const full = "  Expiry: $10 3d · $20 30d · $30 60d · $40 90d · $50 120d";
    expect(draw(block.width)[1]).toContain(`${full}   subs back`);
    // One column short of the right column: it goes, the whole list stays.
    let rows = draw(block.width - 1);
    expect(rows.join("\n")).not.toContain("API credits");
    expect(rows[1].trimEnd()).toBe(full);
    // Shorter than the list: fewer grants, the rest counted.
    rows = draw(full.length - 1);
    expect(rows[1].trimEnd()).toBe("  Expiry: $10 3d · $20 30d · $30 60d · $40 90d · +1");
    rows = draw(46);
    expect(rows[1].trimEnd()).toBe("  Expiry: $10 3d · $20 30d · $30 60d · +2");
    expect(rows[0]).toContain("Credit: [");
    // The Credit row is the least it can be: narrower than that, the block is dropped.
    const credit = stripAnsi(block.rows[0]).indexOf("$150 / $150") + "$150 / $150".length;
    expect(draw(credit)[0]).toContain("Credit:");
    expect(draw(credit - 1).join("\n")).not.toContain("Credit:");
    // Every form's rows are as wide as it says.
    for (const form of [block, ...(block.narrower ?? [])]) expect(form.rows.every(row => stripAnsi(row).length === form.width)).toBe(true);
  });

  test("/tokens: the pool, when a subscription is back, and the cycle's spend", () => {
    expect(usageSummary(creditState())).toEndWith(" · on API credits, $862 / $900 left, subscriptions back in 1d4h, ≈$1.23 this cycle");
  });
});
