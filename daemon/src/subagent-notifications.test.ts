import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { create, get, remove } from "./conversations";
import { DEFAULT_EFFORT } from "./messages";
import {
  acknowledgeSubagentNotification,
  beginPendingSubagentNotification,
  hasSubagentNotificationBeenDelivered,
  listPendingSubagentNotifications,
  pendingSubagentNotificationsPath,
  reloadPendingSubagentNotifications,
  resetPendingSubagentNotificationsForTest,
  settlePendingSubagentNotifications,
} from "./subagent-notifications";

const IDS: string[] = [];

function conversation(suffix: string): string {
  const id = `subagent-notification-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  create(id, "openai", "gpt-5.5", suffix, DEFAULT_EFFORT, false, null);
  return id;
}

beforeEach(resetPendingSubagentNotificationsForTest);

afterEach(() => {
  resetPendingSubagentNotificationsForTest();
  for (const id of IDS.splice(0)) remove(id);
});

describe("durable subagent notifications", () => {
  test("persists the parent target before the child runs and reloads it", () => {
    const parentConvId = conversation("parent");
    const childConvId = conversation("child");

    const created = beginPendingSubagentNotification(
      { convId: parentConvId, maxChars: 1234 },
      childConvId,
      "inspect the restart path",
      42,
      2,
    );

    expect(existsSync(pendingSubagentNotificationsPath())).toBe(true);
    expect(reloadPendingSubagentNotifications()).toEqual([
      expect.objectContaining({
        id: created.id,
        parentConvId,
        childConvId,
        task: "inspect the restart path",
        childStartedAt: 42,
        subagentMaxDepth: 2,
        maxChars: 1234,
        state: "running",
      }),
    ]);
  });

  test("keeps restart-aborted work running, then makes its successful replay ready", () => {
    const parentConvId = conversation("restart-parent");
    const childConvId = conversation("restart-child");
    beginPendingSubagentNotification({ convId: parentConvId }, childConvId, "resume me", 100, 0);

    settlePendingSubagentNotifications(childConvId, {
      ok: false,
      blocks: [],
      error: "✗ Daemon restarted",
      aborted: true,
      daemonRestart: true,
    });
    expect(listPendingSubagentNotifications()).toEqual([
      expect.objectContaining({ childConvId, parentConvId, state: "running" }),
    ]);

    settlePendingSubagentNotifications(childConvId, {
      ok: true,
      blocks: [{ type: "text", text: "replayed result" }],
    });
    reloadPendingSubagentNotifications();
    expect(listPendingSubagentNotifications()).toEqual([
      expect.objectContaining({
        childConvId,
        parentConvId,
        state: "ready",
        text: expect.stringContaining("replayed result"),
      }),
    ]);
  });

  test("cancels deliberate aborts instead of notifying the parent", () => {
    const parentConvId = conversation("abort-parent");
    const childConvId = conversation("abort-child");
    beginPendingSubagentNotification({ convId: parentConvId }, childConvId, "cancel me", 200, 0);

    settlePendingSubagentNotifications(childConvId, {
      ok: false,
      blocks: [],
      error: "✗ Interrupted",
      aborted: true,
    });

    expect(listPendingSubagentNotifications()).toEqual([]);
    expect(existsSync(pendingSubagentNotificationsPath())).toBe(false);
  });

  test("deduplicates the crash window after the parent accepted the notification", () => {
    const parentConvId = conversation("dedupe-parent");
    const childConvId = conversation("dedupe-child");
    const pending = beginPendingSubagentNotification({ convId: parentConvId }, childConvId, "finish", 300, 0);
    settlePendingSubagentNotifications(childConvId, { ok: true, blocks: [] });
    get(parentConvId)!.messages.push({
      role: "user",
      content: "notification",
      metadata: {
        startedAt: 400,
        endedAt: 400,
        model: "gpt-5.5",
        tokens: 0,
        subagentNotificationId: pending.id,
      },
    });

    const ready = listPendingSubagentNotifications({ state: "ready" })[0];
    expect(hasSubagentNotificationBeenDelivered(ready)).toBe(true);
    expect(acknowledgeSubagentNotification(ready.id)).toBe(true);
    expect(listPendingSubagentNotifications()).toEqual([]);
  });
});
