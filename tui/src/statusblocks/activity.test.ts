import { describe, expect, test } from "bun:test";
import { createInitialState } from "../state";
import { stripAnsi } from "../historycursor";
import { renderStatusLine } from "../statusline";
import { activityBlock } from "./activity";

function focusedState() {
  const state = createInitialState();
  state.convId = "focused";
  state.sidebar.conversations = [{
    id: "focused",
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    title: "Focused",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 0,
    folderId: null,
    subagentCount: 3,
    backgroundTaskCount: 2,
  }];
  return state;
}

describe("focused conversation activity status block", () => {
  test("renders active subagent and background-task counts", () => {
    const block = activityBlock(focusedState());
    expect(block.priority).toBe(-1);
    expect(stripAnsi(block.rows[0])).toContain("Subagents: 3");
    expect(stripAnsi(block.rows[1])).toContain("Background tasks: 2");
  });

  test("appears immediately to the right of Context on a wide status line", () => {
    const rendered = renderStatusLine(focusedState(), 100);
    const first = stripAnsi(rendered.lines[0]);
    const second = stripAnsi(rendered.lines[1]);
    expect(first.indexOf("Subagents: 3")).toBeGreaterThan(first.indexOf("Context:"));
    expect(second.indexOf("Background tasks: 2")).toBeGreaterThan(second.indexOf("Max Context:"));
  });

  test("is dropped before Context when width is constrained", () => {
    const rendered = renderStatusLine(focusedState(), 30);
    const text = rendered.lines.map(stripAnsi).join("\n");
    expect(text).toContain("Context:");
    expect(text).not.toContain("Subagents:");
    expect(text).not.toContain("Background tasks:");
  });

  test("defaults both counts to zero when no conversation is focused", () => {
    const state = createInitialState();
    const block = activityBlock(state);
    expect(stripAnsi(block.rows[0])).toContain("Subagents: 0");
    expect(stripAnsi(block.rows[1])).toContain("Background tasks: 0");
  });
});
