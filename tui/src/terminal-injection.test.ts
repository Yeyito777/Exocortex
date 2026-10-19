import { describe, expect, test } from "bun:test";

import { renderSystemMessage } from "./blockrenderer";
import type { ConversationSummary } from "./messages";
import { createSidebarState, renderSidebar } from "./sidebar";
import { createInitialState } from "./state";
import { visibleLength } from "./textwidth";
import { renderTopbar } from "./topbar";

// Sequences that must never reach the terminal from daemon/provider/external text.
const CLIPBOARD_WRITE = "\x1b]52;c;ZWNobyBwd25lZA==\x07";
const WINDOW_TITLE = "\x1b]0;pwned\x07";
const CLEAR_SCREEN = "\x1b[2J";

function hasDangerousEscape(text: string): boolean {
  // Anything but an SGR sequence, plus bare BEL/C1 controls.
  return /\x1b(?!\[[0-9;:]*m)|[\x07\x80-\x9f]/.test(text);
}

function conversation(id: string, title: string): ConversationSummary {
  return {
    id, provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false,
    createdAt: 1, updatedAt: 1, messageCount: 0, title,
    marked: false, pinned: false, streaming: false, unread: false, sortOrder: 1,
  };
}

describe("untrusted text never reaches the terminal as control sequences", () => {
  test("system notices (external notifications, daemon errors) drop OSC/CSI but keep styling", () => {
    const notice = renderSystemMessage(`[notification] gmail: ${CLIPBOARD_WRITE}subject${WINDOW_TITLE}${CLEAR_SCREEN}`, 80);
    expect(hasDangerousEscape(notice.lines.join("\n"))).toBe(false);
    expect(notice.lines.join("")).toContain("subject");

    const styled = renderSystemMessage(`\x1b[31mred\x1b[0m ${WINDOW_TITLE}\x9b2J`, 80);
    expect(hasDangerousEscape(styled.lines.join("\n"))).toBe(false);
    expect(styled.lines[0]).toContain("\x1b[31mred\x1b[0m");
  });

  test("styled notice lines wrap by visible width instead of overflowing", () => {
    const line = `\x1b[32m${"word ".repeat(30)}\x1b[0m`;
    const rendered = renderSystemMessage(line, 40);
    expect(rendered.lines.length).toBeGreaterThan(1);
    for (const row of rendered.lines) expect(visibleLength(row)).toBeLessThanOrEqual(40);
    expect(rendered.cont).toEqual(rendered.lines.map((_, index) => index > 0));
  });

  test("sidebar rows sanitize conversation titles and folder names", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [conversation("a", `hi${CLIPBOARD_WRITE}`)];
    sidebar.folders = [{ id: "f", name: `evil${WINDOW_TITLE}`, parentId: null, pinned: false, sortOrder: 2, createdAt: 1, updatedAt: 1 } as never];
    const rows = renderSidebar(sidebar, 12, true, null).join("\n");
    expect(hasDangerousEscape(rows)).toBe(false);
    expect(rows).toContain("hi");
    expect(rows).toContain("evil");
  });

  test("the topbar sanitizes the open conversation's title", () => {
    const state = createInitialState();
    state.convId = "a";
    state.sidebar.conversations = [conversation("a", `title${CLIPBOARD_WRITE}${CLEAR_SCREEN}`)];
    const rendered = renderTopbar(state, 80);
    expect(hasDangerousEscape(rendered)).toBe(false);
    expect(rendered).toContain("title");
  });
});
