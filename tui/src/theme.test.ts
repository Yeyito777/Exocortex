import { describe, expect, test } from "bun:test";
import { INK_CONTRAST, hexToAnsi, inkAnsi, setTheme, theme, themes, type Theme } from "./theme";
import { ansiColorToRgb, contrastRatio, darkenToContrast, hexToRgb } from "./terminalcolors";
import { apply_theme_colors, forget_terminal_colors, handle_terminal_color_reply, query_terminal_colors, reset_theme_colors } from "./terminal";
import { TerminalControlBuffer } from "./terminalclipboard";
import { highlightLine } from "./markdown/highlight";
import { renderTopbar } from "./topbar";
import { createInitialState } from "./state";

type Rgb = [number, number, number];

const rgbOf = (escape: string, kind: 38 | 48 = 38): Rgb => {
  const rgb = ansiColorToRgb(escape, kind);
  if (!rgb) throw new Error(`no colour in ${JSON.stringify(escape)}`);
  return rgb;
};

function withTheme(name: string, body: () => void): void {
  const original = { ...theme };
  try {
    setTheme(name);
    body();
  } finally { Object.assign(theme, original); }
}

describe("paper", () => {
  const paper = themes.paper;
  const page = hexToRgb(paper.terminalBg!);

  test("is the light theme: its page is the app background and the terminal's own", () => {
    expect(paper.light).toBe(true);
    expect(rgbOf(paper.appBg!, 48)).toEqual(page);
    expect(rgbOf(paper.text)).toEqual(hexToRgb(paper.terminalFg!));
    expect(paper.previewColors[2]).toBe(paper.terminalBg!);
    for (const dark of ["whale", "cerberus", "tonikawa"]) {
      expect(themes[dark].light).toBeUndefined();
      expect(themes[dark].terminalBg).toBeUndefined();
    }
  });

  test("every ink reads on the page", () => {
    const inks: Array<keyof Theme> = [
      "accent", "link", "text", "error", "warning", "success", "goal", "prompt", "tool", "command",
      "vimNormal", "vimInsert", "vimVisual", "borderFocused",
      "codeText", "synKeyword", "synString", "synNumber", "synType", "synFunction", "synOperator", "synPunct",
    ];
    for (const key of inks) {
      const ratio = contrastRatio(rgbOf(paper[key] as string), page);
      expect({ key, readable: ratio >= 4.5 }).toEqual({ key, readable: true });
    }
    // Quieter on purpose, but still text.
    for (const key of ["muted", "synComment"] as const) {
      expect(contrastRatio(rgbOf(paper[key]), page)).toBeGreaterThanOrEqual(3);
    }
  });

  test("text reads on every surface it is written on", () => {
    const ink = rgbOf(paper.text);
    for (const key of ["userBg", "automatedUserBg", "sidebarBg", "sidebarSelBg", "historyLineBg", "selectionBg", "panelBg", "codeBg"] as const) {
      const ratio = contrastRatio(ink, rgbOf(paper[key], 48));
      expect({ key, readable: ratio >= 7 }).toEqual({ key, readable: true });
    }
    expect(contrastRatio(rgbOf(paper.searchFg), rgbOf(paper.searchBg, 48))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(rgbOf(paper.topbarFg!), rgbOf(paper.topbarBg, 48))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(rgbOf(paper.cursorFg), rgbOf(paper.cursorBg, 48))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgbOf(paper.notificationFg), rgbOf(paper.notificationBg, 48))).toBeGreaterThanOrEqual(4.5);
  });

  test("uses no colour from the terminal's 16-colour palette, which is tuned for a dark page", () => {
    for (const [key, value] of Object.entries(paper)) {
      if (typeof value !== "string" || !value.startsWith("\x1b[")) continue;
      expect({ key, palette: /\x1b\[(?:3[0-7]|4[0-7]|9[0-7]|10[0-7])m/.test(value) }).toEqual({ key, palette: false });
    }
  });
});

describe("switching themes", () => {
  test("a theme's optional colours do not outlive it", () => {
    withTheme("paper", () => {
      expect(theme.light).toBe(true);
      expect(theme.topbarFg).toBeTruthy();
      setTheme("whale");
      expect(theme.light).toBeUndefined();
      expect(theme.topbarFg).toBeUndefined();
      expect(theme.terminalFg).toBeUndefined();
      expect(theme.terminalBg).toBeUndefined();
    });
  });

  test("the terminal gets the theme's default colours, and gets its own back", () => {
    const { paper, whale } = themes;
    expect(apply_theme_colors(paper)).toBe(
      `\x1b]12;${paper.cursorColor}\x1b\\\x1b]10;${paper.terminalFg}\x1b\\\x1b]11;${paper.terminalBg}\x1b\\`,
    );
    expect(reset_theme_colors(paper)).toBe("\x1b]112\x1b\\\x1b]110\x1b\\\x1b]111\x1b\\");
    // A dark theme leaves the terminal's colours alone...
    expect(apply_theme_colors(whale)).toBe(`\x1b]12;${whale.cursorColor}\x1b\\`);
    expect(reset_theme_colors(whale)).toBe("\x1b]112\x1b\\");
    // ...and coming from paper, puts them back.
    expect(apply_theme_colors(whale, true)).toBe(`\x1b]12;${whale.cursorColor}\x1b\\\x1b]110\x1b\\\x1b]111\x1b\\`);
  });

  test("the terminal's own colours are asked for once and put back by value", () => {
    const { paper, whale } = themes;
    forget_terminal_colors();
    try {
      expect(query_terminal_colors).toBe("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\");
      // st answers with 16-bit channels and BEL; others end with ST.
      expect(handle_terminal_color_reply("\x1b]10;rgb:f1f1/fafa/eeee\x07", paper)).toBe(true);
      expect(handle_terminal_color_reply("\x1b]11;rgb:0000/0505/0f0f\x1b\\", paper)).toBe(true);
      expect(handle_terminal_color_reply("\x1b]12;rgb:48/ca/e4\x07", paper)).toBe(true);
      expect(handle_terminal_color_reply("\x1b]52;c;aGk=\x07", paper)).toBe(false);
      // A later answer is the theme's own colour, not the terminal's.
      expect(handle_terminal_color_reply("\x1b]11;rgb:1111/2222/3333\x07", paper)).toBe(true);

      const own = "\x1b]12;#48cae4\x1b\\\x1b]112\x1b\\\x1b]10;#f1faee\x1b\\\x1b]110\x1b\\\x1b]11;#00050f\x1b\\\x1b]111\x1b\\";
      // st on macOS ignores the resets, so each is preceded by the value itself.
      expect(reset_theme_colors(paper)).toBe(own);
      expect(apply_theme_colors(whale, true)).toBe(`\x1b]12;${whale.cursorColor}\x1b\\` + own.slice(own.indexOf("\x1b]10;")));
    } finally { forget_terminal_colors(); }
  });

  test("a theme left behind by a killed TUI is not taken for the terminal's own colours", () => {
    const { paper } = themes;
    forget_terminal_colors();
    try {
      const channels = (hex: string) => [1, 3, 5].map(at => hex.slice(at, at + 2).repeat(2)).join("/");
      expect(handle_terminal_color_reply(`\x1b]11;rgb:${channels(paper.terminalBg!)}\x07`, paper)).toBe(true);
      expect(reset_theme_colors({ terminalBg: paper.terminalBg })).toBe("\x1b]111\x1b\\");
    } finally { forget_terminal_colors(); }
  });

  test("the terminal's colour answers come out of the key stream as replies", () => {
    const input: string[] = [];
    const replies: string[] = [];
    const buffer = new TerminalControlBuffer(data => input.push(data), sequence => replies.push(sequence));
    // Split mid-answer, as SSH may deliver it, with a key press on each side.
    buffer.feed("a\x1b]11;rgb:0000/05");
    buffer.feed("05/0f0f\x07b\x1b]10;rgb:f1f1/fafa/eeee\x1b\\");
    buffer.dispose();
    expect(input.join("")).toBe("ab");
    expect(replies).toEqual(["\x1b]11;rgb:0000/0505/0f0f\x07", "\x1b]10;rgb:f1f1/fafa/eeee\x1b\\"]);
  });

  test("code is painted in the active theme's colours", () => {
    const line = 'const answer = "yes"; // 42';
    withTheme("whale", () => {
      const dark = highlightLine(line, "ts");
      expect(dark).toContain(theme.synKeyword);
      setTheme("paper");
      const light = highlightLine(line, "ts");
      expect(light).not.toBe(dark);
      for (const key of ["synKeyword", "synString", "synComment", "codeText"] as const) expect(light).toContain(theme[key]);
    });
  });

  test("the top bar's text is the theme's own where it names one", () => {
    const state = createInitialState();
    state.cols = 60;
    withTheme("whale", () => {
      expect(renderTopbar(state).startsWith(`${theme.topbarBg}${theme.bold}`)).toBe(true);
      setTheme("paper");
      expect(renderTopbar(state).startsWith(`${theme.topbarBg}${theme.topbarFg}${theme.bold}`)).toBe(true);
    });
  });
});

describe("colours from outside the theme", () => {
  const pastel = "#4ddbb7";

  test("a dark theme shows them as given", () => {
    withTheme("whale", () => expect(inkAnsi(pastel)).toBe(hexToAnsi(pastel)));
  });

  test("darkening keeps the hue and stops at the contrast asked for", () => {
    const page = hexToRgb(themes.paper.terminalBg!);
    const from = hexToRgb(pastel);
    const dark = darkenToContrast(from, page, INK_CONTRAST);
    expect(contrastRatio(dark, page)).toBeGreaterThanOrEqual(INK_CONTRAST);
    expect(contrastRatio(dark, page)).toBeLessThan(INK_CONTRAST + 0.3);
    // Scaled toward black: channels keep their order and proportions.
    expect(dark[1]).toBeGreaterThan(dark[2]);
    expect(dark[2]).toBeGreaterThan(dark[0]);
    expect(dark[0] / dark[1]).toBeCloseTo(from[0] / from[1], 1);
    // One already dark enough is left alone.
    expect(darkenToContrast([20, 60, 160], page, INK_CONTRAST)).toEqual([20, 60, 160]);
  });

  test("on paper a pastel is no longer the pastel", () => {
    withTheme("paper", () => expect(inkAnsi(pastel)).not.toBe(hexToAnsi(pastel)));
  });
});
