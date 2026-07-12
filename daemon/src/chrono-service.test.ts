import { afterEach, describe, expect, test } from "bun:test";
import { create, getQueuedMessages, remove } from "./conversations";
import {
  chronoInternalsForTest,
  cancelChronoSchedule,
  createChronoSchedule,
  listChronoSchedules,
  startChronoService,
} from "./chrono-service";
import { clearAllQueuedMessages } from "./message-queue";
import { resetConversationActivityForTest } from "./conversation-activity";

const ids: string[] = [];

function makeConversation(label: string): string {
  const id = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  create(id, "openai", "gpt-5.6-sol", label);
  return id;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await Bun.sleep(10);
  }
}

afterEach(() => {
  chronoInternalsForTest.reset();
  clearAllQueuedMessages();
  resetConversationActivityForTest();
  for (const id of ids.splice(0)) remove(id);
});

describe("Chrono scheduler", () => {
  test("rejects ambiguous absolute wake times without an explicit offset", () => {
    const owner = makeConversation("offset");
    expect(createChronoSchedule({
      ownerConversationId: owner,
      at: "2026-08-01T09:00:00",
      message: "ambiguous",
    }, Date.parse("2026-07-01T00:00:00Z")).error).toContain("explicit offset");
  });

  test("calendar recurrence preserves local wall time across DST", () => {
    const owner = makeConversation("dst");
    const firstAt = "2026-03-07T09:00:00-05:00";
    const result = createChronoSchedule({
      ownerConversationId: owner,
      at: firstAt,
      repeat: { unit: "day" },
      timezone: "America/Toronto",
      message: "daily",
    }, Date.parse("2026-03-06T00:00:00Z"));
    expect(result.schedule?.recurrence?.kind).toBe("calendar");
    const recurrence = result.schedule!.recurrence!;
    if (recurrence.kind !== "calendar") throw new Error("expected calendar recurrence");
    const next = chronoInternalsForTest.nextCalendar(recurrence, Date.parse(firstAt));
    expect(new Date(next).toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(next - Date.parse(firstAt)).toBe(23 * 60 * 60 * 1000);
  });

  test("monthly recurrence preserves the anchored day and skips shorter months", () => {
    const owner = makeConversation("monthly");
    const firstAt = "2026-01-31T09:00:00-05:00";
    const result = createChronoSchedule({
      ownerConversationId: owner,
      at: firstAt,
      repeat: { unit: "month" },
      timezone: "America/Toronto",
      message: "month end",
    }, Date.parse("2026-01-01T00:00:00Z"));
    const recurrence = result.schedule!.recurrence!;
    if (recurrence.kind !== "calendar") throw new Error("expected calendar recurrence");
    const next = chronoInternalsForTest.nextCalendar(recurrence, Date.parse(firstAt));
    expect(new Date(next).toISOString()).toBe("2026-03-31T13:00:00.000Z");
  });

  test("legacy N/step cron migration preserves the old expansion semantics", () => {
    const next = chronoInternalsForTest.nextCron("5/10 * * * *", Date.parse("2026-07-11T12:05:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-07-11T12:15:00.000Z");
  });

  test("hard wake durably queues a model turn", async () => {
    const owner = makeConversation("hardwake");
    await startChronoService();
    createChronoSchedule({ ownerConversationId: owner, afterSeconds: 0.02, message: "Wake now" });
    await waitUntil(() => getQueuedMessages(owner).length === 1);
    expect(getQueuedMessages(owner)[0].text).toContain("[chrono wake:");
    expect(listChronoSchedules(owner)).toHaveLength(0);
  });

  test("reloads durable schedules across a service restart", async () => {
    const owner = makeConversation("restart");
    await startChronoService();
    const created = createChronoSchedule({
      ownerConversationId: owner,
      afterSeconds: 3_600,
      title: "After restart",
      message: "still here",
    });
    expect(created.schedule).toBeDefined();
    const id = created.schedule!.id;

    const { stopChronoService } = await import("./chrono-service");
    stopChronoService();
    await startChronoService();
    expect(listChronoSchedules(owner).map(schedule => schedule.id)).toEqual([id]);
  });

  test("a failing command soft-wake escalates to a model hard-wake", async () => {
    const owner = makeConversation("softwake");
    await startChronoService();
    const result = createChronoSchedule({
      ownerConversationId: owner,
      afterSeconds: 0.02,
      title: "Health probe",
      command: "printf 'unhealthy\\n'; exit 7",
      hardWake: { when: "failure", message: "Investigate health." },
    });
    expect(result.schedule?.target.kind).toBe("command");
    await waitUntil(() => getQueuedMessages(owner).length === 1);
    const wake = getQueuedMessages(owner)[0].text;
    expect(wake).toContain("[chrono hard wake:");
    expect(wake).toContain("Investigate health.");
    expect(wake).toContain("unhealthy");
  });

  test("cancel stops an already-running soft-wake before it can escalate", async () => {
    const owner = makeConversation("cancel-running");
    await startChronoService();
    const created = createChronoSchedule({
      ownerConversationId: owner,
      afterSeconds: 0.02,
      title: "Long probe",
      command: "sleep 30; exit 7",
      hardWake: { when: "failure", message: "should not wake" },
    });
    const scheduleId = created.schedule!.id;
    await Bun.sleep(80);
    const active = listChronoSchedules(owner).find(schedule => schedule.id === scheduleId);
    expect(active).toBeDefined();
    expect(["pending", "running"]).toContain(active!.status!);
    expect(cancelChronoSchedule(scheduleId, owner).cancelled?.id).toBe(scheduleId);
    await Bun.sleep(100);
    expect(getQueuedMessages(owner)).toHaveLength(0);
  });

  test("conversation deletion immediately cancels its owned schedules", async () => {
    const owner = makeConversation("delete-owner");
    await startChronoService();
    createChronoSchedule({ ownerConversationId: owner, afterSeconds: 3_600, message: "never" });
    expect(listChronoSchedules(owner)).toHaveLength(1);
    remove(owner);
    expect(listChronoSchedules(owner)).toHaveLength(0);
  });
});
