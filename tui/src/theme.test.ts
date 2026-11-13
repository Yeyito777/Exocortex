import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { ansiColorToRgb } from "./terminalcolors";
import { contrastRatio, setTheme, theme, themes, toolColorHex, type Theme, type ThemeSurfaces } from "./theme";
import {
  handleTerminalColorReply, resetTerminalThemeForTests, terminalThemeReset, terminalThemeSequence,
} from "./terminaltheme";

beforeEach(() => {
  writeExocortexConfig(defaultExocortexConfig());
  resetTerminalThemeForTests();
});
afterEach(() => {
  setTheme("whale");
  writeExocortexConfig(defaultExocortexConfig());
});

const SURFACES: Array<keyof ThemeSurfaces> = [
  "cursorFg", "heading", "panelBg", "inlineCodeBg", "topbarDim",
  "codeText", "codeGutter", "codeLabel",
  "synKeyword", "synString", "synComment", "synNumber", "synType", "synFunction", "synOperator", "synPunct",
  "ladderLight", "ladderRefused",
];

/** `#rrggbb` of a truecolor slot in a theme's own definition. */
function hex(palette: Theme, slot: keyof Theme): string {
  const value = palette[slot] as string;
  const rgb = ansiColorToRgb(value, value.includes("[48;") ? 48 : 38);
  if (!rgb) throw new Error(`${palette.name}.${String(slot)} is not a colour`);
  return `#${rgb.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Hue in degrees. */
function hue(color: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const h = max === r ? (g - b) / (max - min) : max === g ? 2 + (b - r) / (max - min) : 4 + (r - g) / (max - min);
  return (h * 60 + 360) % 360;
}

describe("themes", () => {
  test("every theme is selectable and resolves every surface", () => {
    for (const name of Object.keys(themes)) {
      expect(setTheme(name)).toBe(true);
      expect(theme.name).toBe(name);
      for (const slot of SURFACES) expect(theme[slot]).toMatch(/^\x1b\[[0-9;]+m$/);
    }
    expect(setTheme("no-such-theme")).toBe(false);
  });

  test("a theme's optional slots do not outlive it", () => {
    setTheme("paper");
    expect(theme.terminalBg).toBe(themes.paper.terminalBg);
    expect(theme.minToolContrast).toBeGreaterThan(1);
    setTheme("whale");
    expect(theme.terminalFg).toBeUndefined();
    expect(theme.terminalBg).toBeUndefined();
    expect(theme.minToolContrast).toBeUndefined();
    expect(theme.heading).not.toBe(themes.paper.heading);
  });

  test("the dark themes keep SGR faint for dim; paper fades with a colour", () => {
    for (const name of ["whale", "cerberus", "tonikawa"]) expect(themes[name].dim).toBe("\x1b[2m");
    expect(ansiColorToRgb(themes.paper.dim, 38)).not.toBeNull();
  });
});

describe("paper", () => {
  const paper = themes.paper;
  const page = hex(paper, "appBg");
  const backgrounds = (["appBg", "sidebarBg", "userBg", "automatedUserBg", "historyLineBg", "panelBg"] as const).map(slot => hex(paper, slot));

  test("is a light theme whose terminal defaults match the page and its ink", () => {
    expect(paper.terminalBg).toBe(page);
    expect(paper.terminalFg).toBe(hex(paper, "text"));
    expect(contrastRatio(page, "#ffffff")).toBeLessThan(1.3);
    expect(paper.cursorColor).toBe(paper.terminalFg);
  });

  test("body text is at least 7:1 on every surface text sits on", () => {
    const ink = hex(paper, "text");
    for (const background of [...backgrounds, hex(paper, "sidebarSelBg"), hex(paper, "selectionBg"), hex(paper, "topbarBg"), hex(paper, "inlineCodeBg"), hex(paper, "searchBg")]) {
      expect(contrastRatio(ink, background)).toBeGreaterThanOrEqual(7);
    }
    expect(contrastRatio(hex(paper, "cursorFg"), hex(paper, "cursorBg"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(hex(paper, "notificationFg"), hex(paper, "notificationBg"))).toBeGreaterThanOrEqual(4.5);
  });

  test("dim, muted and every coloured ink are at least 4.5:1 on the page and the sidebar", () => {
    const inks = [
      "dim", "muted", "accent", "link", "error", "warning", "success", "goal", "prompt", "tool", "command",
      "vimNormal", "vimInsert", "vimVisual", "heading", "codeText", "codeLabel",
      "synKeyword", "synString", "synComment", "synNumber", "synType", "synFunction", "synOperator", "synPunct",
    ] as const;
    for (const slot of inks) {
      for (const background of [page, hex(paper, "sidebarBg")]) {
        expect({ slot, ok: contrastRatio(hex(paper, slot), background) >= 4.5 }).toEqual({ slot, ok: true });
      }
    }
    // Dim and muted text also sits in message bubbles and cards.
    for (const slot of ["dim", "muted"] as const) {
      for (const background of backgrounds) expect(contrastRatio(hex(paper, slot), background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("working, waiting and unread indicators are three different hues", () => {
    const hues = (["accent", "warning", "success"] as const).map(slot => hue(hex(paper, slot)));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const apart = Math.abs(hues[i] - hues[j]);
        expect(Math.min(apart, 360 - apart)).toBeGreaterThanOrEqual(60);
      }
    }
  });

  test("tool colours are darkened until they read on the page, and left alone on dark themes", () => {
    const pastels = ["#d19a66", "#82aaff", "#c3e88d", "#89ddff", "#ffcb6b", "#ffffff"];
    for (const pastel of pastels) expect(toolColorHex(pastel)).toBe(pastel);
    setTheme("paper");
    for (const pastel of pastels) {
      const toned = toolColorHex(pastel);
      expect(contrastRatio(toned, page)).toBeGreaterThanOrEqual(4.5);
      // Darker, same hue.
      if (pastel !== "#ffffff") expect(Math.abs(hue(toned) - hue(pastel))).toBeLessThan(4);
    }
    expect(toolColorHex("#1a1a1a")).toBe("#1a1a1a");
    expect(toolColorHex("not-a-colour")).toBe("not-a-colour");
  });
});

describe("terminal colours", () => {
  const set = (osc: number, color: string) => `\x1b]${osc};${color}\x1b\\`;

  test("a dark theme only sets the cursor", () => {
    expect(terminalThemeSequence()).toBe(set(12, themes.whale.cursorColor!));
  });

  test("paper sets the default foreground and background, and leaving it puts the terminal's own back", () => {
    expect(handleTerminalColorReply("\x1b]10;rgb:f1f1/fafa/eeee\x07")).toBe(true);
    expect(handleTerminalColorReply("\x1b]11;rgb:0000/0505/0f0f\x1b\\")).toBe(true);
    expect(handleTerminalColorReply("\x1b]12;rgb:4848/caca/e4e4\x07")).toBe(true);
    expect(handleTerminalColorReply("\x1b[?2032;1$y")).toBe(false);

    setTheme("paper");
    expect(terminalThemeSequence()).toBe(set(12, themes.paper.cursorColor!) + set(10, themes.paper.terminalFg!) + set(11, themes.paper.terminalBg!));
    // A reply after the change reports paper's colours and must not replace the originals.
    handleTerminalColorReply("\x1b]11;rgb:f6f6/eeee/dbdb\x07");

    setTheme("whale");
    expect(terminalThemeSequence()).toBe(set(12, themes.whale.cursorColor!) + set(10, "#f1faee") + set(11, "#00050f"));
    expect(terminalThemeReset()).toBe(set(12, "#48cae4"));
    expect(terminalThemeReset()).toBe("");
  });

  test("without a reply from the terminal the reset sequences are used", () => {
    setTheme("paper");
    terminalThemeSequence();
    expect(terminalThemeReset()).toBe("\x1b]112\x1b\\\x1b]110\x1b\\\x1b]111\x1b\\");
  });
});
