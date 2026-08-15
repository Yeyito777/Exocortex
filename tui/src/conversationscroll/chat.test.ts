import { describe, expect, test } from "bun:test";
import type { MessageBound, RenderLineAnchor } from "../conversation";
import { createInitialState } from "../state";
import { applyChatConversationScroll, latestAssistantFinalTextRows } from "./chat";

function assistantDocument(options: {
  totalLines: number;
  responseStart: number;
  responseEnd: number;
}): { anchors: RenderLineAnchor[]; bounds: MessageBound[] } {
  const thinking = { type: "thinking" };
  const response = { type: "text" };
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
