import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  clearAllQueuedMessages,
  drainQueuedMessages,
  getQueuedMessageById,
  getQueuedMessages,
  listQueuedMessages,
  loadQueuedMessagesFromDisk,
  moveQueuedMessage,
  pushGlobalIdleQueuedMessage,
  pushQueuedMessage,
  removeQueuedMessageById,
  setQueuedMessagesChangedListener,
  suspendQueuedMessageDelivery,
  resumeQueuedMessageDelivery,
  updateQueuedMessage,
} from "./message-queue";

beforeEach(() => {
  setQueuedMessagesChangedListener(null);
  clearAllQueuedMessages();
});

afterAll(() => {
  setQueuedMessagesChangedListener(null);
  clearAllQueuedMessages();
});

describe("durable daemon message queue", () => {
  test("persists stable identities and FIFO order across an in-process daemon reload", () => {
    pushQueuedMessage("conv-a", "same", "next-turn", undefined, 2, undefined, "queue-a", 10);
    pushQueuedMessage("conv-a", "same", "message-end", undefined, 1, undefined, "queue-b", 20);

    expect(loadQueuedMessagesFromDisk()).toBe(2);
    expect(getQueuedMessages("conv-a").map(message => message.id)).toEqual(["queue-a", "queue-b"]);
    expect(drainQueuedMessages("conv-a", "next-turn").map(message => message.id)).toEqual(["queue-a"]);
    expect(getQueuedMessages("conv-a").map(message => message.id)).toEqual(["queue-b"]);
  });

  test("removes duplicate-text entries by id without touching their neighbor", () => {
    pushQueuedMessage("conv-a", "duplicate", "next-turn", undefined, undefined, undefined, "first");
    pushQueuedMessage("conv-a", "duplicate", "message-end", undefined, undefined, undefined, "second");

    expect(removeQueuedMessageById("second")).toBe(true);
    expect(getQueuedMessageById("first")?.timing).toBe("next-turn");
    expect(getQueuedMessageById("second")).toBeUndefined();
  });

  test("edits and reorders entries by stable id", () => {
    pushQueuedMessage("conv-a", "one", "message-end", undefined, undefined, undefined, "one");
    pushQueuedMessage("conv-a", "two", "message-end", undefined, undefined, undefined, "two");

    expect(updateQueuedMessage("two", "two edited", "next-turn")).toBe(true);
    expect(moveQueuedMessage("two", "up")).toBe(true);
    expect(getQueuedMessages("conv-a").map(message => [message.id, message.text, message.timing])).toEqual([
      ["two", "two edited", "next-turn"],
      ["one", "one", "message-end"],
    ]);
  });

  test("temporarily gates delivery without removing durable queue state", () => {
    pushQueuedMessage("conv-a", "keep me", "message-end", undefined, undefined, undefined, "suspended");

    suspendQueuedMessageDelivery("conv-a");
    expect(getQueuedMessages("conv-a")).toEqual([]);
    expect(listQueuedMessages().map(message => message.id)).toEqual(["suspended"]);

    resumeQueuedMessageDelivery("conv-a");
    expect(getQueuedMessages("conv-a").map(message => message.id)).toEqual(["suspended"]);
  });

  test("persists global-idle target metadata for daemon-side scheduling", () => {
    pushGlobalIdleQueuedMessage("conv-a", "after build", undefined, {
      id: "idle-a",
      waitTarget: { type: "folder", folderId: "folder-a", label: "Build" },
      target: "conversation",
      createdAt: 30,
    });

    loadQueuedMessagesFromDisk();
    expect(listQueuedMessages()).toEqual([{
      id: "idle-a",
      convId: "conv-a",
      text: "after build",
      timing: "message-end",
      source: "global-idle",
      target: "conversation",
      waitTarget: { type: "folder", folderId: "folder-a", label: "Build" },
      createdAt: 30,
    }]);
  });

  test("drops a crash-window queue copy whose id is already durable in history", () => {
    pushQueuedMessage("conv-a", "accepted", "message-end", undefined, undefined, undefined, "accepted-id");
    pushQueuedMessage("conv-a", "pending", "message-end", undefined, undefined, undefined, "pending-id");

    expect(loadQueuedMessagesFromDisk(new Set(["accepted-id"]))).toBe(1);
    expect(listQueuedMessages().map(message => message.id)).toEqual(["pending-id"]);
  });

  test("notifies clients with authoritative full snapshots after mutations", () => {
    const snapshots: string[][] = [];
    setQueuedMessagesChangedListener(messages => snapshots.push(messages.map(message => message.id)));

    pushQueuedMessage("conv-a", "one", "message-end", undefined, undefined, undefined, "one");
    pushQueuedMessage("conv-b", "two", "message-end", undefined, undefined, undefined, "two");
    removeQueuedMessageById("one");

    expect(snapshots).toEqual([["one"], ["one", "two"], ["two"]]);
  });
});
