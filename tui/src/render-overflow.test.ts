import { describe, expect, test } from "bun:test";
import { render, invalidateHistoryRenderCache } from "./render";
import { createInitialState, type RenderState } from "./state";
import { invalidateFrame } from "./frame";
import { TerminalScreen } from "./testhelpers/terminalscreen";

function captureRenderOutput(state: RenderState): string {
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  return out;
}

function assistantState(text: string, cols: number, rows = 20): RenderState {
  const state = createInitialState();
  state.cols = cols;
  state.rows = rows;
  state.sidebar.open = false;
  state.messages = [{ role: "assistant", blocks: [{ type: "text", text }], metadata: null }];
  return state;
}

/** A full repaint into an st-like screen; every written row must fit without auto-wrapping. */
function paint(state: RenderState): TerminalScreen {
  const screen = new TerminalScreen(state.rows, state.cols, { autowrap: true });
  invalidateFrame(state);
  screen.feed(captureRenderOutput(state));
  return screen;
}

describe("history rows never exceed the terminal width", () => {
  const cases: Array<[name: string, text: string, cols: number]> = [
    ["prose that starts and ends with a pipe", "Triangle inequality:\n\n|a + b| is always less than or equal to the sum of the two magnitudes |a| + |b|\n\nend", 50],
    ["a streamed table header before its separator row", "| Name | Description | Default value | Notes about the option |", 50],
    ["a table with too many columns for the width", [
      "| a | b | c | d | e | f | g | h | i | j | k | l | m | n | o |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      "| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |",
    ].join("\n"), 40],
  ];

  for (const [name, text, cols] of cases) {
    test(name, () => {
      const screen = paint(assistantState(text, cols));
      expect(screen.autoWrapCount).toBe(0);
    });
  }

  test("an incremental frame after a long row changes matches a full repaint", () => {
    const long = (end: string) => `|a + b| is at most the sum of both magnitudes, here |a| + |${end}|`;
    const state = assistantState("intro\n\n" + long("b"), 50, 14);
    const screen = paint(state);
    state.messages = [{ role: "assistant", blocks: [{ type: "text", text: "intro\n\n" + long("c") }], metadata: null }];
    invalidateHistoryRenderCache(state);
    screen.feed(captureRenderOutput(state));

    expect(screen.autoWrapCount).toBe(0);
    expect(screen.plainRows()).toEqual(paint(state).plainRows());
  });
});
