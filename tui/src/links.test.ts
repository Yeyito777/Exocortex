import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { inlineLinkAt } from "./links";
import { markdownWordWrap } from "./markdown";
import { stripAnsi } from "./historymotions";
import { visibleLength, termWidth } from "./textwidth";
import { setTheme, theme, themes } from "./theme";
import { createInitialState } from "./state";
import { buildMessageLines } from "./conversation";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { findOpenableTargetMatches, resolveOpenCommand } from "./openable";

beforeEach(() => writeExocortexConfig(defaultExocortexConfig()));
afterEach(() => writeExocortexConfig(defaultExocortexConfig()));

function history(text: string, width = 44) {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 40;
  state.sidebar.open = false;
  state.messages = [{ role: "assistant", blocks: [{ type: "text", text }], metadata: null }];
  const rendered = buildMessageLines(state, width);
  state.historyLines = rendered.lines;
  state.historyLineAnchors = rendered.lineAnchors;
  state.historyWrapContinuation = rendered.wrapContinuation;
  state.historyWrapJoiners = rendered.wrapJoiners;
  state.historyMessageBounds = rendered.messageBounds;
  state.layout = { ...state.layout, chatCol: 1, sepAbove: 35, messageAreaHeight: 32,
    historyViewportRows: rendered.lines.map((_, lineIndex) => ({ lineIndex, startCol: 0, displayPrefixWidth: 0 })) };
  return state;
}

describe("link parsing and rendering", () => {
  test("local file and folder labels hide destinations and retain complete targets", () => {
    for (const target of [
      "NFC-Findings/", "NFC-Findings/README.md", "./notes.txt", "../notes.md",
      "/tmp/notes.md", "~/notes.md", "file:///tmp/notes%20one.md",
      "notes%20one.md", "reports/result_(final).json",
    ]) {
      const source = `[Local report](${target})`;
      expect(inlineLinkAt(source, 0)?.target).toBe(target);
      const rendered = markdownWordWrap(source, 8, theme.reset);
      expect(rendered.lines.map(stripAnsi).join(" ")).toBe("Local report");
      expect(rendered.links?.flat().length).toBeGreaterThan(0);
      expect(rendered.links?.flat().every(span => span.target === target)).toBe(true);
    }
    for (const source of ['[Report](<notes one.md> "Title")', '[Report](notes\\ one.md)']) {
      expect(inlineLinkAt(source, 0)?.target).toBe("notes one.md");
    }
    expect(inlineLinkAt("[Report](notes\\(final\\).md)", 0)?.target).toBe("notes(final).md");
  });

  test("unsafe, malformed, and code-local links remain literal", () => {
    for (const source of [
      "[Local](javascript:notes.md)", "[Local](data:text/plain,notes.md)",
      "[Local](file://remote/tmp/notes.md)", "[Local](file:///tmp/notes%00.md)",
      "[Local](notes%0A.md)", "[Local](//remote/notes.md)", "[Local](#section)",
      "[Local](notes.md", "`[Local](notes.md)`", "[Local](file:///tmp/a\u001b.md)",
    ]) {
      expect(markdownWordWrap(source, 100, theme.reset).lines.map(stripAnsi).join(" ")).toContain("[Local]");
    }
  });

  test("Markdown labels, titles, autolinks and balanced URL punctuation", () => {
    for (const source of ['[Paper](https://example.com/a_(b))', '[Paper](<https://example.com/a_(b)> "A title")']) {
      expect(inlineLinkAt(source, 0)?.target).toBe("https://example.com/a_(b)");
      expect(markdownWordWrap(source, 12, theme.reset).lines.map(stripAnsi)).toEqual(["Paper"]);
    }
    const source = "<https://example.com/a>";
    expect(markdownWordWrap(source, 80, theme.reset).lines.map(stripAnsi)).toEqual(["https://example.com/a"]);
    expect(findOpenableTargetMatches("See https://example.com/a_(b)).")[0].target).toBe("https://example.com/a_(b)");
  });

  test("wrapped labels retain full targets and never wrap hidden URLs", () => {
    const url = "https://example.com/" + "very-long/".repeat(20);
    const rendered = markdownWordWrap(`See [**Working Backwards**: Learning to Place](${url}) next.`, 17, theme.reset);
    expect(rendered.lines.every(line => visibleLength(line) <= 17)).toBe(true);
    expect(rendered.lines.map(stripAnsi).join(" ")).not.toContain("https");
    expect(rendered.links?.flat().every(span => span.target === url)).toBe(true);
    expect(rendered.links?.filter(row => row?.length).length).toBeGreaterThan(1);
    expect(rendered.lines.join("")).toContain(theme.bold);
    expect(rendered.lines.join("")).toContain(theme.link);
  });

  test("links in tables retain hit ranges after cell wrapping", () => {
    for (const target of ["https://example.com", "NFC-Findings/README.md", "NFC-Findings/"]) {
      const rendered = markdownWordWrap(`| Name | Link |\n| --- | --- |\n| 中文 | [a rather long label](${target}) |`, 24, theme.reset);
      const spans = rendered.links?.flat() ?? [];
      expect(spans.length).toBeGreaterThan(0);
      for (let row = 0; row < rendered.lines.length; row++) {
        expect(visibleLength(rendered.lines[row])).toBeLessThanOrEqual(24);
        for (const span of rendered.links?.[row] ?? []) {
          expect(stripAnsi(rendered.lines[row]).slice(span.start, span.end)).not.toContain("│");
          expect(span.target).toBe(target);
        }
      }
    }
  });

  test("code remains literal; unsafe and unfinished links are not hidden", () => {
    for (const text of ["`[label](https://example.com)`", "[label](javascript:alert(1))", "[label](https://example.com"]) {
      const rendered = markdownWordWrap(text, 80, theme.reset);
      expect(rendered.lines.map(stripAnsi).join(" ")).toContain("[label]");
    }
    expect(resolveOpenCommand("https://example.com/\u001b[31m")).toBeNull();
    expect(resolveOpenCommand("javascript:alert(1)")).toBeNull();
    expect(resolveOpenCommand("https://example.com/a?x=1&y=2")).toEqual({ command: "xdg-open", args: ["https://example.com/a?x=1&y=2"] });
  });

  test("all themes supply their own link color and cached blocks follow theme changes", () => {
    const original = { ...theme };
    try {
      const state = history("[Paper](https://example.com)");
      for (const palette of Object.values(themes)) {
        setTheme(palette.name);
        expect(buildMessageLines(state, 44).lines.join("")).toContain(theme.link);
      }
    } finally { Object.assign(theme, original); }
  });
});

describe("link activation", () => {
  test("Enter and mouse activate local files and directories by their label", () => {
    for (const target of ["NFC-Findings/", "NFC-Findings/README.md", "evidence.json", "file:///tmp/notes.md"]) {
      const state = history(`[Local report](${target})`, 8);
      state.chatFocus = "history";
      expect(state.historyLineAnchors.flatMap(anchor => anchor.links ?? []).length).toBeGreaterThan(0);
      for (let row = 0; row < state.historyLineAnchors.length; row++) {
        for (const span of state.historyLineAnchors[row].links ?? []) {
          state.historyCursor = { row, col: span.start };
          expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "open_target", target });
          const col = 1 + termWidth(stripAnsi(state.historyLines[row]).slice(0, span.start));
          const event = { type: "mouse" as const, shift: false, meta: false, ctrl: false, row: row + 3, col, button: 0 };
          handleMouseEvent({ ...event, action: "press" }, state);
          expect(handleMouseEvent({ ...event, action: "release" }, state)).toEqual({ type: "open_target", target });
        }
      }
    }
  });

  test("Ctrl+N history navigation and Enter open every wrapped label fragment", () => {
    const state = history("[Working Backwards: Learning to Place by Picking](https://arxiv.org/abs/2312.02352)", 24);
    handleFocusedKey({ type: "ctrl-n" }, state);
    expect(state.chatFocus).toBe("history");
    for (let row = 0; row < state.historyLineAnchors.length; row++) {
      for (const span of state.historyLineAnchors[row].links ?? []) {
        state.historyCursor = { row, col: span.start };
        expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "open_target", target: span.target });
      }
    }
  });

  test("mouse hover uses a hand, click opens once, trailing space and overlays don't", () => {
    const state = history("中文 😀 [Paper](https://example.com)");
    const row = state.historyLineAnchors.findIndex(anchor => anchor.links?.length);
    const span = state.historyLineAnchors[row].links![0];
    const col = 1 + termWidth(stripAnsi(state.historyLines[row]).slice(0, span.start));
    const event = { type: "mouse" as const, shift: false, meta: false, ctrl: false, row: row + 3, col, button: 0 };
    handleMouseEvent({ ...event, button: 3, action: "motion" }, state);
    expect(state.mouseCursor).toBe("hand");
    expect(handleMouseEvent({ ...event, action: "press" }, state)).toEqual({ type: "handled" });
    expect(state.historyCursor).toEqual({ row, col: span.start });
    expect(handleMouseEvent({ ...event, action: "release" }, state)).toEqual({ type: "open_target", target: span.target });
    expect(handleMouseEvent({ ...event, action: "release" }, state)).toEqual({ type: "handled" });
    handleMouseEvent({ ...event, col: 90, button: 3, action: "motion" }, state);
    expect(state.mouseCursor).toBe("text");
    state.layout.taskPanelRect = { left: col, right: col + 15, top: event.row, bottom: event.row + 2 };
    handleMouseEvent({ ...event, button: 3, action: "motion" }, state);
    expect(state.mouseCursor).toBe("pointer");
    expect(handleMouseEvent({ ...event, action: "press" }, state)).toEqual({ type: "handled" });
  });

  test("dragging from a link selects text without opening, including drag back", () => {
    const state = history("[Paper](https://example.com) more");
    const row = state.historyLineAnchors.findIndex(anchor => anchor.links?.length);
    const event = { type: "mouse" as const, shift: false, meta: false, ctrl: false, row: row + 3, col: 3, button: 0 };
    handleMouseEvent({ ...event, action: "press" }, state);
    handleMouseEvent({ ...event, col: 9, action: "motion" }, state);
    handleMouseEvent({ ...event, action: "motion" }, state);
    expect(handleMouseEvent({ ...event, action: "release" }, state)).toEqual({ type: "handled" });
  });

  test("disabled URL opener prevents activation", () => {
    const state = history("[Paper](https://example.com)");
    const config = defaultExocortexConfig();
    config.openers = { ...config.openers, url: null };
    writeExocortexConfig(config);
    state.chatFocus = "history";
    const row = state.historyLineAnchors.findIndex(anchor => anchor.links?.length);
    state.historyCursor = { row, col: 2 };
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });
  });
});
