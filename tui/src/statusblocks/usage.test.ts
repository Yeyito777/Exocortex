import { afterEach, describe, expect, test } from "bun:test";
import { usageBlock } from "./usage";
import { createInitialState } from "../state";
import { stripAnsi } from "../historycursor";

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
});
