import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { create, get, remove } from "./conversations";
import { DEFAULT_EFFORT } from "./messages";
import {
  acknowledgeSubagentNotification,
  beginPendingSubagentNotification,
  buildSubagentNotificationText,
  cancelRunningSubagentNotifications,
  followUpTrigger,
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
  test("full-details guidance points to direct daemon IPC, not removed native actions", () => {
    const parentId = conversation("hint-parent");
    const childId = conversation("hint-child");
    const record = beginPendingSubagentNotification({ convId: parentId }, childId, "task", 42, 0);
    const text = buildSubagentNotificationText(record, { ok: true, blocks: [{ type: "text", text: "done" }] });
    expect(text).toContain(childId);
    expect(text).toContain("load_conversation/load_conversation_history");
    expect(text).toContain("shared/src/protocol.ts");
    expect(text).not.toContain("action=read");
  });
  test("completed and failed notices end with the exo message follow-up line", () => {
    const parentId = conversation("followup-parent");
    const childId = conversation("followup-child");
    const record = beginPendingSubagentNotification({ convId: parentId }, childId, "task", 42, 0);
    const line = `Follow up: exo message {conversation: "${childId}", text}`;
    const ok = buildSubagentNotificationText(record, { ok: true, blocks: [{ type: "text", text: "done" }] });
    const failed = buildSubagentNotificationText(record, { ok: false, error: "boom", blocks: [] });
    expect(ok.split("\n").at(-1)).toBe(line);
    expect(failed.split("\n").at(-1)).toBe(line);
  });
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

  test("persists whether a detached turn should count as subagent activity", () => {
    const parentConvId = conversation("regular-send-parent");
    const targetConvId = conversation("regular-send-target");

    beginPendingSubagentNotification(
      { convId: parentConvId },
      targetConvId,
      "send an update",
      84,
      0,
      false,
    );

    expect(reloadPendingSubagentNotifications()).toEqual([
      expect.objectContaining({
        parentConvId,
        childConvId: targetConvId,
        trackAsSubagent: false,
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

  test("a stopped child tells its parent it was stopped, with any partial output", () => {
    const parentConvId = conversation("abort-parent");
    const childConvId = conversation("abort-child");
    beginPendingSubagentNotification({ convId: parentConvId }, childConvId, "stop me", 200, 0);

    const { ready } = settlePendingSubagentNotifications(childConvId, {
      ok: false,
      blocks: [{ type: "text", text: "Halfway through the migration." }],
      error: "✗ Interrupted",
      aborted: true,
      pendingWork: ["1 background task"],
    });

    expect(ready).toHaveLength(1);
    expect(ready[0].text).toStartWith(`[notification] Subagent stopped: exo:${childConvId}`);
    expect(ready[0].text).toContain("stopped before it finished");
    expect(ready[0].text).toContain("Partial output:\nHalfway through the migration.");
    expect(ready[0].text).not.toContain("Still waiting on");
    expect(ready[0].text).not.toContain("Interrupted");
  });

  test("a parent's own abort cancels the notice instead", () => {
    const parentConvId = conversation("cancel-parent");
    const childConvId = conversation("cancel-child");
    beginPendingSubagentNotification({ convId: parentConvId }, childConvId, "cancel me", 200, 0);

    expect(cancelRunningSubagentNotifications(childConvId)).toHaveLength(1);
    settlePendingSubagentNotifications(childConvId, { ok: false, blocks: [], aborted: true });

    expect(listPendingSubagentNotifications()).toEqual([]);
    expect(existsSync(pendingSubagentNotificationsPath())).toBe(false);
  });

  test("a turn that leaves work pending says so; a follow-up names what woke it", () => {
    const parentConvId = conversation("pending-parent");
    const childConvId = conversation("pending-child");
    beginPendingSubagentNotification({ convId: parentConvId }, childConvId, "[background done]", 200, 0, true,
      followUpTrigger({ kind: "background_task_completion", sourceId: "t1" }, parentConvId));

    const { ready } = settlePendingSubagentNotifications(childConvId, {
      ok: true,
      blocks: [{ type: "text", text: "Tests started; waiting on the build." }],
      pendingWork: ["1 background task (bun test)", "1 subagent (fix lint)"],
    });

    expect(ready[0].text).toStartWith(`[notification] Subagent replied (still working): exo:${childConvId}`);
    expect(ready[0].text).toContain("Woken by: one of its background tasks finishing");
    expect(ready[0].text).toContain("Still waiting on: 1 background task (bun test), 1 subagent (fix lint). You get another notice when it next stops.");
    expect(ready[0].text).toContain("Result:\nTests started; waiting on the build.");
  });

  test("follow-up triggers read from the parent's point of view", () => {
    const parentConvId = conversation("trigger-parent");
    const siblingId = conversation("trigger-sibling");
    expect(followUpTrigger({ kind: "exo_send", sourceId: parentConvId }, parentConvId)).toBe("your message");
    expect(followUpTrigger({ kind: "exo_send", sourceId: siblingId }, parentConvId)).toStartWith(`a message from exo:${siblingId}`);
    expect(followUpTrigger({ kind: "subagent_completion", sourceId: "gc" }, parentConvId)).toBe("a report from its subagent exo:gc");
    expect(followUpTrigger({ kind: "chrono_hard_wake", sourceId: "w" }, parentConvId)).toBe("a wake it scheduled");
    expect(followUpTrigger({ kind: "chrono_wake", sourceId: "w" }, parentConvId)).toBe("a wake it scheduled");
    expect(followUpTrigger({ kind: "external_notification" }, parentConvId)).toBe("an external notification");
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
