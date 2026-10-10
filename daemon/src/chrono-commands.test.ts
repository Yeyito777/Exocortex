import { afterEach, describe, expect, test } from "bun:test";
import type { ChronoCommand } from "@exocortex/shared/protocol";
import { create, remove } from "./conversations";
import { runChronoCommand } from "./chrono-commands";
import { chronoInternalsForTest, createChronoSchedule, listChronoSchedules } from "./chrono-service";
import { resetConversationActivityForTest } from "./conversation-activity";

const ids: string[] = [];

function makeConversation(label: string): string {
  const id = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  create(id, "openai", "gpt-5.6-sol", label);
  return id;
}

function run(convId: string, command: Omit<ChronoCommand, "type" | "convId">) {
  return runChronoCommand({ type: "chrono", convId, ...command });
}

afterEach(() => {
  chronoInternalsForTest.reset();
  resetConversationActivityForTest();
  for (const id of ids.splice(0)) remove(id);
});

describe("/chrono daemon command", () => {
  test("creates conversation-owned message and command wakes the model also sees", () => {
    const convId = makeConversation("create");
    const at = new Date(Date.now() + 3_600_000).toISOString();

    const message = run(convId, { action: "create", reqId: "r1", at, message: "check the build" });
    expect(message.event).toEqual(expect.objectContaining({
      type: "chrono_result", reqId: "r1", convId, action: "create",
      created: expect.objectContaining({ kind: "message", payload: "check the build", nextAt: Date.parse(at), status: "scheduled" }),
    }));
    const command = run(convId, {
      action: "create", at, command: "echo hi", repeat: { unit: "day" }, timezone: "America/Chicago",
    });
    expect(command.event?.created).toEqual(expect.objectContaining({
      kind: "command",
      payload: "echo hi",
      recurrence: expect.objectContaining({ kind: "calendar", unit: "day", timezone: "America/Chicago" }),
    }));
    expect(command.event?.schedules.map(schedule => schedule.payload).sort()).toEqual(["check the build", "echo hi"]);
    expect(listChronoSchedules(convId).every(schedule => schedule.ownerConversationId === convId)).toBe(true);
  });

  test("reports scheduler validation errors and rejects malformed wire repeats", () => {
    const convId = makeConversation("invalid");
    expect(run(convId, { action: "create", at: new Date(Date.now() - 1_000).toISOString(), message: "late" }).error)
      .toContain("future");
    expect(run(convId, {
      action: "create",
      at: new Date(Date.now() + 60_000).toISOString(),
      message: "bad",
      repeat: { unit: "week", weekdays: [1] } as never,
    }).error).toBe("Invalid Chrono repeat.");
    expect(run(convId, { action: "create", at: 5 as never, message: "bad" }).error).toContain("'at'");
    expect(listChronoSchedules(convId)).toEqual([]);
  });

  test("lists only this conversation's schedules", () => {
    const convId = makeConversation("list");
    const other = makeConversation("other");
    const at = new Date(Date.now() + 60_000).toISOString();
    createChronoSchedule({ ownerConversationId: convId, at, message: "mine" });
    createChronoSchedule({ ownerConversationId: other, at, message: "theirs" });

    expect(run(convId, { action: "list" }).event?.schedules.map(schedule => schedule.payload)).toEqual(["mine"]);
  });

  test("cancels by short-id prefix or all, never another conversation's schedule", () => {
    const convId = makeConversation("cancel");
    const other = makeConversation("cancel-other");
    const at = new Date(Date.now() + 60_000).toISOString();
    const first = createChronoSchedule({ ownerConversationId: convId, at, message: "first" }).schedule!;
    createChronoSchedule({ ownerConversationId: convId, at, message: "second" });
    const foreign = createChronoSchedule({ ownerConversationId: other, at, message: "foreign" }).schedule!;

    expect(run(convId, { action: "cancel", scheduleId: foreign.id.slice(7, 15) }).error).toContain("No Chrono schedule");
    const cancelled = run(convId, { action: "cancel", scheduleId: first.id.slice(7, 13).toUpperCase() });
    expect(cancelled.event?.cancelled).toEqual([{ id: first.id, title: "first" }]);
    expect(cancelled.event?.schedules.map(schedule => schedule.payload)).toEqual(["second"]);

    expect(run(convId, { action: "cancel", scheduleId: "all" }).event?.cancelled?.map(item => item.title)).toEqual(["second"]);
    expect(run(convId, { action: "cancel", scheduleId: "all" }).error).toBe("No Chrono schedules to cancel.");
    expect(listChronoSchedules(other).map(schedule => schedule.id)).toEqual([foreign.id]);
  });

  test("asks for more of an ambiguous id", () => {
    const convId = makeConversation("ambiguous");
    const at = new Date(Date.now() + 60_000).toISOString();
    createChronoSchedule({ ownerConversationId: convId, at, message: "one" });
    createChronoSchedule({ ownerConversationId: convId, at, message: "two" });

    // Every id starts with "chrono:", so an empty short-id prefix matches both.
    expect(run(convId, { action: "cancel", scheduleId: "chrono:" }).error).toContain("matches 2 schedules");
    expect(listChronoSchedules(convId)).toHaveLength(2);
  });
});
