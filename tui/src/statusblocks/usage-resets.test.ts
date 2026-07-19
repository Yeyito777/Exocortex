import { afterEach, describe, expect, test } from "bun:test";
import { stripAnsi } from "../historycursor";
import { createInitialState } from "../state";
import { renderStatusLine } from "../statusline";
import { theme } from "../theme";
import { contextBlock } from "./context";
import { usageBlock } from "./usage";
import { usageResetsBlock } from "./usage-resets";

const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
});

function stateWithUsageResets() {
  const state = createInitialState();
  state.provider = "openai";
  state.authByProvider.openai = true;
  state.usageByProvider.openai = {
    fiveHour: { utilization: 25, resetsAt: 1_700_000_000_000 + 60 * 60_000 },
    sevenDay: { utilization: 50, resetsAt: 1_700_000_000_000 + 24 * 60 * 60_000 },
    resetCredits: {
      availableCount: 3,
      nextExpiresAt: 1_700_000_000_000 + 2 * 24 * 60 * 60_000 + 3 * 60 * 60_000 + 4 * 60_000,
    },
  };
  return state;
}

describe("usage reset status block", () => {
  test("renders the available count and nearest expiry", () => {
    Date.now = () => 1_700_000_000_000;
    const block = usageResetsBlock(stateWithUsageResets());

    expect(block).not.toBeNull();
    expect(block!.priority).toBe(0);
    expect(stripAnsi(block!.rows[0]).trim()).toBe("Usage Resets: 3");
    expect(stripAnsi(block!.rows[1]).trim()).toBe("Next Expiriy: 2d:3h:04m");
    expect(block!.rows[0]).toContain(`${theme.accent}3`);
    expect(block!.rows[1]).toContain(`${theme.accent}2d:3h:04m`);
    expect(stripAnsi(block!.rows[0]).length).toBe(block!.width);
    expect(stripAnsi(block!.rows[1]).length).toBe(block!.width);
  });

  test("shows an unknown expiry when no available credit has an expiry", () => {
    const state = stateWithUsageResets();
    state.usageByProvider.openai!.resetCredits = { availableCount: 0, nextExpiresAt: null };
    expect(stripAnsi(usageResetsBlock(state)!.rows[1]).trim()).toBe("Next Expiriy: ?");
  });

  test("appears to the right of usage and context when all three fit", () => {
    Date.now = () => 1_700_000_000_000;
    const state = stateWithUsageResets();
    const usage = usageBlock(state)!;
    const context = contextBlock(state)!;
    const resets = usageResetsBlock(state)!;
    const cols = usage.width + context.width + resets.width + 6;
    const rendered = stripAnsi(renderStatusLine(state, cols).lines[0]);

    expect(rendered.indexOf("5-Hour")).toBeLessThan(rendered.indexOf("Context"));
    expect(rendered.indexOf("Context")).toBeLessThan(rendered.indexOf("Usage Resets"));
  });

  test("drops before usage and context on a narrower status line", () => {
    Date.now = () => 1_700_000_000_000;
    const state = stateWithUsageResets();
    const usage = usageBlock(state)!;
    const context = contextBlock(state)!;
    const cols = usage.width + context.width + 3;
    const rendered = stripAnsi(renderStatusLine(state, cols).lines.join("\n"));

    expect(rendered).toContain("5-Hour");
    expect(rendered).toContain("Context");
    expect(rendered).not.toContain("Usage Resets");
  });
});
