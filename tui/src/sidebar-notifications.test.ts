import { describe, expect, test } from "bun:test";
import type { ConversationSummary } from "./messages";
import { createSidebarState } from "./sidebar";
import {
  isSettledUnreadConversation,
  msUntilNextFolderNotification,
  reconcileFolderNotificationBuffer,
  STREAM_COMPLETION_SETTLE_MS,
} from "./sidebar/notifications";

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv",
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    title: "Conversation",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe("sidebar completion notification buffer", () => {
  test("delays a streaming-to-idle unread completion until it settles", () => {
    const sidebar = createSidebarState();
    const completed = conversation({ unread: true });
    sidebar.conversations = [completed];

    reconcileFolderNotificationBuffer(sidebar, completed, true, 1_000);

    expect(sidebar.folderNotificationBufferUntil.conv).toBe(1_000 + STREAM_COMPLETION_SETTLE_MS);
    expect(isSettledUnreadConversation(sidebar, completed, 1_199)).toBe(false);
    expect(msUntilNextFolderNotification(sidebar, 1_050)).toBe(150);
    expect(isSettledUnreadConversation(sidebar, completed, 1_200)).toBe(true);
    expect(msUntilNextFolderNotification(sidebar, 1_200)).toBeNull();
  });

  test("cancels the pending completion when a queued turn starts streaming", () => {
    const sidebar = createSidebarState();
    const completed = conversation({ unread: true });
    sidebar.conversations = [completed];
    reconcileFolderNotificationBuffer(sidebar, completed, true, 1_000);

    const queuedTurn = conversation({ unread: true, streaming: true });
    sidebar.conversations = [queuedTurn];
    reconcileFolderNotificationBuffer(sidebar, queuedTurn, false, 1_050);

    expect(sidebar.folderNotificationBufferUntil.conv).toBeUndefined();
    expect(isSettledUnreadConversation(sidebar, queuedTurn, 2_000)).toBe(false);
    expect(msUntilNextFolderNotification(sidebar, 1_050)).toBeNull();
  });

  test("does not delay unread conversations loaded in an already-settled state", () => {
    const sidebar = createSidebarState();
    const completed = conversation({ unread: true });
    sidebar.conversations = [completed];

    expect(isSettledUnreadConversation(sidebar, completed, 1_000)).toBe(true);
  });
});
