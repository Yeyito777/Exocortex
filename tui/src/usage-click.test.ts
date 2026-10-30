import { describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { cursorZone, handleMouseEvent, isInsideUsageBlock } from "./mouse";
import { accountsScreenAvailable } from "./accountsscreen";
import { SIDEBAR_WIDTH } from "./sidebar";
import { TerminalScreen } from "./testhelpers/terminalscreen";
import type { ProviderAuthAccountInfo } from "./protocol";

/** Run `fn`, returning everything it wrote to stdout instead of printing it. */
function captureOutput(fn: () => void): string {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  return out;
}

const ROWS = 30;

/** Claude signed in with combined usage over `accounts` accounts (one: the plain single-account shape). */
function claudeState(accounts: number, cols = 150): RenderState {
  const state = createInitialState();
  state.cols = cols;
  state.rows = ROWS;
  state.sidebar.open = false;
  state.provider = "anthropic";
  state.authByProvider.anthropic = true;
  state.usageByProvider.anthropic = {
    fiveHour: { utilization: 40, resetsAt: null },
    sevenDay: { utilization: 20, resetsAt: null },
    ...(accounts > 1 ? { capacity: accounts * 100 } : {}),
  };
  return state;
}

function openaiAccount(email: string, current = false): ProviderAuthAccountInfo {
  return { email, displayName: null, subscriptionType: "pro", accountId: email, current };
}

/** Render a frame and return the screen as plain rows (index 0 is row 1). */
function frame(state: RenderState): string[] {
  const screen = new TerminalScreen(state.rows, state.cols);
  screen.feed(captureOutput(() => render(state)));
  return screen.plainRows();
}

/** Where "5-Hour" and "Weekly" are drawn, as 1-based screen cells. */
function drawnUsage(rows: string[]): { fiveHour: { row: number; col: number }; weekly: { row: number; col: number } } {
  const find = (needle: string) => {
    const index = rows.findIndex(row => row.includes(needle));
    expect(index).toBeGreaterThanOrEqual(0);
    return { row: index + 1, col: rows[index].indexOf(needle) + 1 };
  };
  return { fiveHour: find("5-Hour"), weekly: find("Weekly") };
}

const mouse = (col: number, row: number, action: "press" | "release" | "motion", button = 0) =>
  ({ type: "mouse" as const, shift: false, meta: false, ctrl: false, col, row, button, action });

function press(state: RenderState, col: number, row: number, action: "press" | "release" | "motion" = "press", button = 0) {
  let result: ReturnType<typeof handleMouseEvent> | undefined;
  captureOutput(() => { result = handleMouseEvent(mouse(col, row, action, button), state); });
  return result!;
}

describe("usage block hit-test", () => {
  test("the rectangle is the drawn block: its two rows, from the chat column to its last column", () => {
    const state = claudeState(2);
    const rows = frame(state);
    const drawn = drawnUsage(rows);
    const rect = state.layout.usageBlockRect!;
    expect(rect).not.toBeNull();
    expect(rect.top).toBe(drawn.fiveHour.row);
    expect(rect.bottom).toBe(drawn.weekly.row);
    expect(rect.top).toBe(state.layout.sepBelow + 1);
    // The rows start with two spaces before the label.
    expect(rect.left).toBe(drawn.fiveHour.col - 2);
    // The context block follows after " │ ".
    const statusRow = rows[rect.top - 1];
    expect(statusRow[rect.right + 1 - 1]).toBe(" ");
    expect(statusRow[rect.right + 2 - 1]).toBe("\u2502");
  });

  test("inside and on every edge; one cell beyond any edge is outside", () => {
    const state = claudeState(2);
    frame(state);
    const { top, bottom, left, right } = state.layout.usageBlockRect!;
    for (const [col, row] of [[left, top], [right, top], [left, bottom], [right, bottom], [(left + right) >> 1, top]]) {
      expect(isInsideUsageBlock(col, row, state)).toBe(true);
    }
    for (const [col, row] of [[left, top - 1], [right, bottom + 1], [right + 1, top], [right + 2, bottom], [left - 1, top]]) {
      expect(isInsideUsageBlock(col, row, state)).toBe(false);
    }
  });

  test("follows the block when the sidebar opens and the prompt grows", () => {
    const state = claudeState(2, 180);
    state.sidebar.open = true;
    state.inputBuffer = "one\ntwo\nthree";
    state.cursorPos = state.inputBuffer.length;
    const drawn = drawnUsage(frame(state));
    const rect = state.layout.usageBlockRect!;
    expect(rect.top).toBe(drawn.fiveHour.row);
    expect(rect.left).toBe(drawn.fiveHour.col - 2);
    expect(rect.left).toBeGreaterThan(SIDEBAR_WIDTH);
    expect(rect.left).toBe(state.layout.chatCol);
    expect(cursorZone(rect.left, rect.top, state)).toBe("hand");
    // The sidebar cell left of it stays sidebar chrome.
    expect(cursorZone(rect.left - 1, rect.top, state)).toBe("pointer");
  });

  test("on API credits the rectangle is the Credit and Expiry rows, at any width", () => {
    for (const cols of [150, 60]) {
      const state = claudeState(2, cols);
      const now = Date.now();
      state.usageByProvider.anthropic!.apiCredits = {
        active: true, ready: true, label: "main", spentUsd: 1, resetAt: null,
        pool: { balanceUsd: 862, grantedUsd: 900, approximate: false, grants: [
          { leftUsd: 162, grantedUsd: 200, expiresAt: now + 12 * 86_400_000 },
          { leftUsd: 700, grantedUsd: 700, expiresAt: now + 170 * 86_400_000 },
        ] },
        subscriptionsBackAt: now + 28 * 3_600_000,
      };
      const rows = frame(state);
      const top = rows.findIndex(row => row.includes("Credit:")) + 1;
      const rect = state.layout.usageBlockRect!;
      expect(rows[top]).toContain("Expiry:");
      expect(rect.top).toBe(top);
      expect(rect.bottom).toBe(top + 1);
      expect(rect.left).toBe(rows[top - 1].indexOf("Credit:") + 1 - 2);
      // Its widest row ends on the rectangle's right edge (1-based column = 0-based index + 1), and the cell after it is blank.
      const ends = [rows[top - 1], rows[top]].map(row => row.slice(0, rect.right).trimEnd().length);
      expect(Math.max(...ends)).toBe(rect.right);
      for (const row of [rows[top - 1], rows[top]]) expect(row[rect.right] ?? " ").toBe(" ");
      expect(rows.join("\n")).not.toContain("API credits");
      expect(cursorZone(rect.right, rect.bottom, state)).toBe("hand");
      expect(press(state, rect.right, rect.bottom)).toEqual({ type: "open_accounts" });
      expect(isInsideUsageBlock(rect.right + 1, rect.top, state)).toBe(false);
    }
  });

  test("no block, no rectangle: signed out, or too narrow for the usage bars", () => {
    const state = claudeState(2);
    frame(state);
    const { left, top } = state.layout.usageBlockRect!;
    state.authByProvider.anthropic = false;
    frame(state);
    expect(state.layout.usageBlockRect).toBeNull();
    expect(isInsideUsageBlock(left, top, state)).toBe(false);
    expect(cursorZone(left, top, state)).toBe("pointer");
    expect(press(state, left, top)).toEqual({ type: "handled" });

    const narrow = claudeState(2, 40);
    const rows = frame(narrow);
    expect(rows.some(row => row.includes("5-Hour"))).toBe(false);
    expect(narrow.layout.usageBlockRect).toBeNull();
  });
});

describe("usage block cursor and click", () => {
  test("one account: ordinary pointer, and a click does nothing", () => {
    const state = claudeState(1);
    frame(state);
    expect(accountsScreenAvailable(state)).toBe(false);
    const { left, top } = state.layout.usageBlockRect!;
    expect(cursorZone(left + 3, top, state)).toBe("pointer");
    const messages = state.messages.length;
    expect(press(state, left + 3, top)).toEqual({ type: "handled" });
    expect(state.messages.length).toBe(messages);
    expect(state.accountsOpenRequest).toBeNull();
  });

  test("several Claude accounts (here or the /proxy remote's pool): hand, and a left press opens the screen", () => {
    const state = claudeState(2);
    frame(state);
    const { left, top, right, bottom } = state.layout.usageBlockRect!;
    expect(cursorZone(left, top, state)).toBe("hand");
    expect(cursorZone(right, bottom, state)).toBe("hand");
    expect(cursorZone(right + 1, top, state)).toBe("pointer");
    const hoverOut = captureOutput(() => handleMouseEvent(mouse(left + 3, top, "motion", 3), state));
    expect(hoverOut).toBe("\x1b]777;mouseshape;hand\x07");
    expect(press(state, left + 3, top)).toEqual({ type: "open_accounts" });
    expect(press(state, right, bottom)).toEqual({ type: "open_accounts" });
    // Outside the block the status line still does nothing.
    expect(press(state, right + 2, top)).toEqual({ type: "handled" });
  });

  test("releases, drags, hovers and other buttons do not open it", () => {
    const state = claudeState(3);
    frame(state);
    const { left, top } = state.layout.usageBlockRect!;
    expect(press(state, left + 3, top, "release")).toEqual({ type: "handled" });
    expect(press(state, left + 3, top, "motion")).toEqual({ type: "handled" });
    expect(press(state, left + 3, top, "motion", 3)).toEqual({ type: "handled" });
    expect(press(state, left + 3, top, "press", 1)).toEqual({ type: "handled" });
    expect(press(state, left + 3, top, "press", 2)).toEqual({ type: "handled" });
    expect(press(state, left + 3, top, "press", 64)).toEqual({ type: "handled" });
  });

  test("several OpenAI accounts make it clickable unless OpenAI goes through /proxy", () => {
    const state = claudeState(1);
    state.provider = "openai";
    state.authByProvider.openai = true;
    state.usageByProvider.openai = { fiveHour: { utilization: 5, resetsAt: null }, sevenDay: { utilization: 1, resetsAt: null } };
    state.authInfoByProvider.openai.accounts = [openaiAccount("a@example.com", true)];
    frame(state);
    const { left, top } = state.layout.usageBlockRect!;
    expect(cursorZone(left, top, state)).toBe("pointer");

    state.authInfoByProvider.openai.accounts = [openaiAccount("a@example.com", true), openaiAccount("b@example.com")];
    frame(state);
    expect(cursorZone(left, top, state)).toBe("hand");
    expect(press(state, left, top)).toEqual({ type: "open_accounts" });

    state.providerProxies = [{ provider: "openai", alias: "box", state: "connected" } as NonNullable<RenderState["providerProxies"]>[number]];
    frame(state);
    expect(accountsScreenAvailable(state)).toBe(false);
    expect(cursorZone(left, top, state)).toBe("pointer");
  });

  test("modal overlays keep owning the pointer over the block", () => {
    const state = claudeState(2);
    frame(state);
    const { left, top } = state.layout.usageBlockRect!;
    state.queuePrompt = { selection: 0 } as unknown as RenderState["queuePrompt"];
    expect(press(state, left, top)).toEqual({ type: "handled" });
  });
});
