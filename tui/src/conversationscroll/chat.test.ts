import { describe, expect, test } from "bun:test";
import type { MessageBound, RenderLineAnchor } from "../conversation";
import { createInitialState } from "../state";
import { applyChatConversationScroll, latestAssistantFinalTextRows } from "./chat";

function assistantDocument(options: {
  totalLines: number;
  responseStart: number;
  responseEnd: number;
  /** The response block, to lay the same one out again at another size. */
  response?: object;
}): { anchors: RenderLineAnchor[]; bounds: MessageBound[] } {
  const thinking = { type: "thinking" };
  const response = options.response ?? { type: "text" };
  const anchors = Array.from({ length: options.totalLines }, (_, row): RenderLineAnchor => ({
    owner: row >= options.responseStart && row < options.responseEnd ? response : thinking,
    segment: "assistant_block",
    index: row,
    subIndex: 0,
  }));
  return {
    anchors,
    bounds: [{
      role: "assistant",
      start: 0,
      end: options.totalLines,
      contentStart: 0,
      contentEnd: options.totalLines,
    }],
  };
}

describe("conversation open placement", () => {
  test("opens an unread overflowing final response at its first row", () => {
    const state = createInitialState();
    state.convId = "unread";
    state.conversationScroll.pendingRestore = {
      convId: "unread",
      mode: "unread-response",
      waitForInitialBackfill: false,
    };
    const document = assistantDocument({ totalLines: 50, responseStart: 30, responseEnd: 45 });

    applyChatConversationScroll(state, document.anchors, document.bounds, 50, 10, 0);

    expect(state.scrollOffset).toBe(10);
    expect(50 - 10 - state.scrollOffset).toBe(30);
    expect(state.conversationScroll.pendingRestore).toBeNull();
  });

  test("opens an unread response at the bottom when the final text fits", () => {
    const state = createInitialState();
    state.convId = "unread";
    state.scrollOffset = 12;
    state.conversationScroll.pendingRestore = {
      convId: "unread",
      mode: "unread-response",
      waitForInitialBackfill: false,
    };
    const document = assistantDocument({ totalLines: 50, responseStart: 40, responseEnd: 45 });

    applyChatConversationScroll(state, document.anchors, document.bounds, 50, 10, 12);

    expect(state.scrollOffset).toBe(0);
  });

  test("holds the first unread response row when its footer pushes it out of view", () => {
    const state = createInitialState();
    state.convId = "unread";
    state.conversationScroll.pendingRestore = {
      convId: "unread",
      mode: "unread-response",
      waitForInitialBackfill: false,
    };
    const document = assistantDocument({ totalLines: 51, responseStart: 40, responseEnd: 50 });

    const update = applyChatConversationScroll(state, document.anchors, document.bounds, 51, 10, 0);

    expect(state.scrollOffset).toBe(1);
    expect(update.topAnchorRow).toBe(40);
  });

  test("lets go of the first row once the opened response fits the viewport", () => {
    const state = createInitialState();
    state.convId = "unread";
    state.conversationScroll.pendingRestore = {
      convId: "unread",
      mode: "unread-response",
      waitForInitialBackfill: false,
    };
    const response = { type: "text" };
    const opened = assistantDocument({ totalLines: 50, responseStart: 30, responseEnd: 45, response });
    expect(applyChatConversationScroll(state, opened.anchors, opened.bounds, 50, 10, 0).topAnchorRow).toBe(30);
    expect(state.scrollOffset).toBe(10);

    // Still taller than the viewport: its first row stays at the top.
    const shorter = assistantDocument({ totalLines: 44, responseStart: 30, responseEnd: 40, response });
    expect(applyChatConversationScroll(state, shorter.anchors, shorter.bounds, 44, 10, 10).topAnchorRow).toBe(30);
    expect(state.scrollOffset).toBe(4);

    // It fits: the viewport ends at its last row instead of past it.
    const fits = assistantDocument({ totalLines: 38, responseStart: 30, responseEnd: 36, response });
    expect(applyChatConversationScroll(state, fits.anchors, fits.bounds, 38, 10, 4).topAnchorRow).toBeNull();
    expect(state.scrollOffset).toBe(0);

    // Taller again: back to its first row.
    expect(applyChatConversationScroll(state, opened.anchors, opened.bounds, 50, 10, 0).topAnchorRow).toBe(30);
    expect(state.scrollOffset).toBe(10);
  });

  test("restores a remembered percentage after backfill", () => {
    const state = createInitialState();
    state.convId = "remembered";
    state.conversationScroll.pendingRestore = {
      convId: "remembered",
      mode: "percentage",
      percentage: 0.25,
      waitForInitialBackfill: false,
    };

    applyChatConversationScroll(state, [], [], 100, 20, 0);

    expect(state.scrollOffset).toBe(60);
  });

  test("finds the final text block rather than preceding assistant work", () => {
    const document = assistantDocument({ totalLines: 30, responseStart: 17, responseEnd: 30 });
    expect(latestAssistantFinalTextRows(document.anchors, document.bounds)).toEqual({ start: 17, end: 30 });
  });
});
