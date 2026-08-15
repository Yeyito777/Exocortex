import { describe, expect, test } from "bun:test";
import type { ConversationSummary } from "../messages";
import { createInitialState } from "../state";
import {
  beginConversationScrollRestore,
  captureScrollPercentage,
  completeInitialConversationBackfill,
  prepareConversationOpen,
  pruneConversationScrollPositions,
  scrollOffsetForPercentage,
} from "./position";

function conversation(id: string, unread = false): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "medium",
    fastMode: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    title: id,
    marked: false,
    pinned: false,
    streaming: false,
    unread,
    sortOrder: 1,
  };
}

describe("conversation scroll percentages", () => {
  test("captures and restores top, middle, and bottom positions", () => {
    expect(captureScrollPercentage(100, 20, 80)).toBe(0);
    expect(captureScrollPercentage(100, 20, 40)).toBe(0.5);
    expect(captureScrollPercentage(100, 20, 0)).toBe(1);
    expect(scrollOffsetForPercentage(100, 20, 0)).toBe(80);
    expect(scrollOffsetForPercentage(100, 20, 0.5)).toBe(40);
    expect(scrollOffsetForPercentage(100, 20, 1)).toBe(0);
  });

  test("captures unread before opening and gives it priority over saved position", () => {
    const state = createInitialState();
    state.convId = "current";
    state.layout.totalLines = 100;
    state.layout.messageAreaHeight = 20;
    state.scrollOffset = 40;
    state.sidebar.conversations = [conversation("current"), conversation("target", true)];
    state.conversationScroll.positions.set("target", 0.25);

    prepareConversationOpen(state, "target");
    expect(state.conversationScroll.positions.get("current")).toBe(0.5);
    expect(state.conversationScroll.pendingOpen).toEqual({ convId: "target", unreadAtOpen: true });

    beginConversationScrollRestore(state, "target", false, true);
    expect(state.conversationScroll.pendingRestore).toEqual({
      convId: "target",
      mode: "unread-response",
      waitForInitialBackfill: false,
    });
  });

  test("waits for initial history backfill before applying a remembered percentage", () => {
    const state = createInitialState();
    state.conversationScroll.positions.set("target", 0.25);
    state.sidebar.conversations = [conversation("target")];

    prepareConversationOpen(state, "target");
    beginConversationScrollRestore(state, "target", false, true);
    expect(state.conversationScroll.pendingRestore).toMatchObject({
      convId: "target",
      mode: "percentage",
      percentage: 0.25,
      waitForInitialBackfill: true,
    });

    completeInitialConversationBackfill(state, "target");
    expect(state.conversationScroll.pendingRestore?.waitForInitialBackfill).toBe(false);
  });

  test("prunes positions for conversations no longer reported by the daemon", () => {
    const state = createInitialState();
    state.conversationScroll.positions.set("keep", 0.25);
    state.conversationScroll.positions.set("deleted", 0.75);

    pruneConversationScrollPositions(state, ["keep"]);

    expect([...state.conversationScroll.positions]).toEqual([["keep", 0.25]]);
  });
});
