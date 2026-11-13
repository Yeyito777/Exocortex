import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FAINT_MIX, resetFaintPen, resolveFaint } from "./lightfaint";
import { setTheme, theme, themes } from "./theme";
import { hexToRgb } from "./terminalcolors";

const ESC = "\x1b[";
const fg = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number) => `${ESC}48;2;${r};${g};${b}m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

const mixed = (from: readonly number[], to: readonly number[]) =>
  fg(...from.map((channel, i) => Math.round(channel + (to[i] - channel) * FAINT_MIX)) as [number, number, number]);

const ink = hexToRgb(themes.paper.terminalFg!);
const page = hexToRgb(themes.paper.terminalBg!);
const paint = (text: string) => resolveFaint(text, "truecolor");

describe("faint text on a light theme", () => {
  const original = { ...theme };
  beforeEach(() => { setTheme("paper"); resetFaintPen(); });
  afterEach(() => { Object.assign(theme, original); resetFaintPen(); });

  test("a dark theme's output is left exactly as written", () => {
    setTheme("whale");
    const text = `${DIM}${fg(1, 2, 3)}quiet${RESET}`;
    expect(paint(text)).toBe(text);
  });

  test("SGR 2 never reaches the terminal: uncoloured faint text is ink mixed into the page", () => {
    expect(paint(`${DIM}quiet${RESET} loud`)).toBe(`${mixed(ink, page)}quiet${RESET} loud`);
  });

  test("a faint colour keeps its hue, whichever of the two comes first", () => {
    const green = [40, 120, 70] as const;
    const faded = mixed(green, page);
    expect(paint(`${DIM}${fg(...green)}done${RESET}`)).toBe(`${mixed(ink, page)}${faded}done${RESET}`);
    expect(paint(`${fg(...green)}${DIM}done${RESET}`)).toBe(`${fg(...green)}${faded}done${RESET}`);
  });

  test("ending faint with SGR 22 gives back the colour the text had", () => {
    const blue = [36, 71, 184] as const;
    expect(paint(`${fg(...blue)}a${DIM}b${ESC}22mc${RESET}`))
      .toBe(`${fg(...blue)}a${mixed(blue, page)}b${ESC}22m${fg(...blue)}c${RESET}`);
    expect(paint(`a${DIM}b${ESC}22mc`)).toBe(`a${mixed(ink, page)}b${ESC}22m${ESC}39mc`);
  });

  test("faint text fades toward the background it sits on, not the page", () => {
    const bar = [35, 37, 45] as const;
    const label = [251, 250, 246] as const;
    expect(paint(`${bg(...bar)}${fg(...label)}${DIM}queued${ESC}22m${RESET}`))
      .toBe(`${bg(...bar)}${fg(...label)}${mixed(label, bar)}queued${ESC}22m${fg(...label)}${RESET}`);
  });

  test("bold wins over faint, as in the terminal", () => {
    const red = [192, 52, 43] as const;
    expect(paint(`${fg(...red)}${ESC}1m${DIM}x${RESET}`)).toBe(`${fg(...red)}${ESC}1mx${RESET}`);
  });

  test("what is not faint is not rewritten", () => {
    const text = `${ESC}1m${fg(1, 2, 3)}${bg(4, 5, 6)}bold${ESC}22m${ESC}3mitalic${ESC}23m${RESET}`;
    expect(paint(text)).toBe(text);
  });

  test("the pen carries over from one write to the next", () => {
    expect(paint(`${fg(10, 20, 30)}${DIM}one`)).toBe(`${fg(10, 20, 30)}${mixed([10, 20, 30], page)}one`);
    expect(paint(`two${ESC}22m`)).toBe(`two${ESC}22m${fg(10, 20, 30)}`);
  });

  test("an underline colour's parameters are not read as faint", () => {
    const text = `${ESC}4;58;2;10;20;30munder${RESET}`;
    expect(paint(text)).toBe(text);
  });

  test("palette colours fade too, in a 256-colour terminal's own terms", () => {
    const out = resolveFaint(`${ESC}38;5;21m${DIM}x${RESET}`, "256");
    expect(out).not.toContain(DIM);
    expect(out).toMatch(/^\x1b\[38;5;21m\x1b\[38;5;\d+mx\x1b\[0m$/);
  });
});
