import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationWorkspaceDir, trashedConversationWorkspaceDir } from "@exocortex/shared/paths";
import { appendMessages, create, get, getQueuedMessages, remove } from "./conversations";
import {
  adoptChronoSchedule,
  chronoInternalsForTest,
  cancelChronoSchedule,
  completeDeferredChronoSleepResume,
  configureChronoService,
  createChronoSchedule,
  deferChronoSleep,
  installMigratedSchedule,
  interruptDeferredChronoSleep,
  listDeferredChronoSleeps,
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

async function waitUntil(predicate: () => boolean, timeoutMs = process.platform === "win32" ? 5_000 : 2_000): Promise<void> {
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
    const created = createChronoSchedule({ ownerConversationId: owner, afterSeconds: 0.02, message: "Wake now" });
    await waitUntil(() => getQueuedMessages(owner).length === 1);
    const wake = getQueuedMessages(owner)[0];
    expect(wake.timing).toBe("next-turn");
    expect(wake.text).toContain("[chrono wake:");
    expect(wake.automation).toEqual({ kind: "chrono_wake", sourceId: created.schedule?.id });
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

  test("attaches a deferred sleep result and requests replay when the deadline arrives", async () => {
    const owner = makeConversation("deferred-sleep-deadline");
    const toolCallId = "sleep-deadline-call";
    expect(appendMessages(owner, [{
      role: "assistant",
      content: [{ type: "tool_use", id: toolCallId, name: "chrono", input: { action: "sleep", duration: "10m" } }],
      metadata: null,
    }])).toBe(true);
    let resumed = false;
    configureChronoService(null, (sleep) => {
      expect(sleep.resumeReason).toBe("elapsed");
      resumed = true;
    });
    await startChronoService();
    const durationMs = 10 * 60_000;
    const deferred = deferChronoSleep({
      conversationId: owner,
      toolCallId,
      startedAt: Date.now() - durationMs + 20,
      durationMs,
    });
    expect(deferred.error).toBeUndefined();

    await waitUntil(() => resumed && listDeferredChronoSleeps(owner).length === 0);
    const resultMessage = get(owner)!.messages.at(-1)!;
    expect(resultMessage.role).toBe("user");
    expect(resultMessage.content).toContainEqual(expect.objectContaining({
      type: "tool_result",
      tool_use_id: toolCallId,
      is_error: false,
    }));
    const output = (resultMessage.content as Array<{ content?: string }>)[0]?.content;
    expect(output).toContain("Sleep finished after 10m");
    expect(output).toContain("requested 10m");
  });

  test("an incoming user turn ends a deferred sleep early with elapsed time", async () => {
    const owner = makeConversation("deferred-sleep-user");
    const toolCallId = "sleep-user-call";
    expect(appendMessages(owner, [{
      role: "assistant",
      content: [{ type: "tool_use", id: toolCallId, name: "chrono", input: { action: "sleep", duration: "10m" } }],
      metadata: null,
    }])).toBe(true);
    const durationMs = 10 * 60_000;
    const deferred = deferChronoSleep({
      conversationId: owner,
      toolCallId,
      startedAt: Date.now() - 125_000,
      durationMs,
    }).sleep!;

    const interrupted = interruptDeferredChronoSleep(owner);
    expect(interrupted).toMatchObject({ id: deferred.id, state: "resuming", resumeReason: "user_message" });
    const result = get(owner)!.messages.at(-1)!;
    const output = (result.content as Array<{ content?: string }>)[0]?.content ?? "";
    expect(output).toContain("Sleep finished after 2m 5s");
    expect(output).toContain("ended early because the user sent a message");
    expect(listDeferredChronoSleeps(owner)).toHaveLength(1);

    completeDeferredChronoSleepResume(deferred.id);
    expect(listDeferredChronoSleeps(owner)).toHaveLength(0);
  });

  test("a failing command soft-wake escalates to a model hard-wake", async () => {
    const owner = makeConversation("softwake");
    await startChronoService();
    const result = createChronoSchedule({
      ownerConversationId: owner,
      afterSeconds: 0.02,
      title: "Health probe",
      command: process.platform === "win32" ? "[Console]::WriteLine('unhealthy'); exit 7" : "printf 'unhealthy\\n'; exit 7",
      hardWake: { when: "failure", message: "Investigate health." },
    });
    expect(result.schedule?.target.kind).toBe("command");
    await waitUntil(() => getQueuedMessages(owner).length === 1);
    const wake = getQueuedMessages(owner)[0];
    expect(wake.timing).toBe("next-turn");
    expect(wake.automation).toEqual({ kind: "chrono_hard_wake", sourceId: result.schedule?.id });
    expect(wake.text).toContain("[chrono hard wake:");
    expect(wake.text).toContain("Investigate health.");
    expect(wake.text).toContain("unhealthy");
  });

  test("runs an owned command soft-wake in its conversation workspace", async () => {
    const owner = makeConversation("softwake-cwd");
    const artifact = join(conversationWorkspaceDir(owner), "chrono-cwd.txt");
    await startChronoService();
    createChronoSchedule({
      ownerConversationId: owner,
      afterSeconds: 0.02,
      title: "Record cwd",
      command: "pwd > chrono-cwd.txt",
    });

    await waitUntil(() => existsSync(artifact));
    expect(readFileSync(artifact, "utf8").trim()).toBe(conversationWorkspaceDir(owner));
  });

  test("adopts an ownerless command schedule and assigns failure escalation", () => {
    const owner = makeConversation("adopt");
    const id = "chrono:migrated:test-adopt";
    expect(installMigratedSchedule({
      id,
      title: "Global health probe",
      createdAt: Date.now(),
      nextAt: Date.now() + 60_000,
      recurrence: { kind: "cron", expression: "*/15 * * * *" },
      target: { kind: "command", command: "exit 1", timeoutMs: 30_000 },
      source: "legacy-cron",
    })).toBe(true);

    const result = adoptChronoSchedule({
      scheduleId: id,
      ownerConversationId: owner,
      hardWake: { message: "Investigate the recorder." },
    });
    expect(result.error).toBeUndefined();
    expect(result.schedule).toMatchObject({
      id,
      ownerConversationId: owner,
      target: {
        kind: "command",
        hardWake: {
          conversationId: owner,
          when: "failure",
          message: "Investigate the recorder.",
          includeOutput: true,
        },
      },
    });
    expect(listChronoSchedules(owner).map(schedule => schedule.id)).toEqual([id]);
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

  test("conversation deletion quiesces a running command before trashing its workspace", async () => {
    const owner = makeConversation("delete-running-owner");
    const liveMarker = join(conversationWorkspaceDir(owner), "chrono-running.txt");
    await startChronoService();
    createChronoSchedule({
      ownerConversationId: owner,
      afterSeconds: 0.02,
      title: "Running during delete",
      command: "printf running > chrono-running.txt; sleep 30",
    });
    await waitUntil(() => existsSync(liveMarker));

    expect(remove(owner)).toBe(true);
    expect(existsSync(conversationWorkspaceDir(owner))).toBe(false);
    expect(readFileSync(join(trashedConversationWorkspaceDir(owner), "chrono-running.txt"), "utf8")).toBe("running");
    expect(listChronoSchedules(owner)).toHaveLength(0);
  });
});
