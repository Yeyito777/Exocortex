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
});
