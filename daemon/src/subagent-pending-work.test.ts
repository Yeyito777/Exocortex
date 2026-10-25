import { afterEach, describe, expect, test } from "bun:test";
import { create, pushQueuedMessage, getQueuedMessages, removeQueuedMessagesById, remove } from "./conversations";
import { chronoInternalsForTest, createChronoSchedule } from "./chrono-service";
import { resetConversationActivityForTest, setBackgroundTaskActive, setSubagentActive } from "./conversation-activity";
import { describeSubagentPendingWork } from "./subagent-pending-work";

const ids: string[] = [];

function conversation(label: string): string {
  const id = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  create(id, "openai", "gpt-5.6-sol", label);
  return id;
}

afterEach(() => {
  chronoInternalsForTest.reset();
  resetConversationActivityForTest();
  for (const id of ids.splice(0)) {
    removeQueuedMessagesById(getQueuedMessages(id).map(entry => entry.id));
    remove(id);
  }
});

describe("subagent pending work", () => {
  test("a child with nothing left running is done", () => {
    expect(describeSubagentPendingWork(conversation("idle"))).toEqual([]);
  });

  test("lists background tasks, its own subagents, one-shot wakes and queued input", () => {
    const child = conversation("busy");
    const now = Date.now();
    setBackgroundTaskActive(child, "task-1", true, { title: "bun test", startedAt: now });
    setBackgroundTaskActive(child, "task-2", true, { title: "make build", startedAt: now + 1 });
    setSubagentActive(child, "grandchild", true, { title: "fix lint", startedAt: now });
    expect(createChronoSchedule({ ownerConversationId: child, afterSeconds: 25 * 60, message: "check CI" }).error).toBeUndefined();
    pushQueuedMessage(child, "from a sibling", "next-turn", undefined, null, undefined, undefined, undefined,
      { kind: "exo_send", sourceId: "sibling" });
    expect(describeSubagentPendingWork(child, now)).toEqual([
      "2 background tasks (bun test; make build)",
      "1 subagent (fix lint)",
      "1 scheduled wake (next in 25 min)",
      "1 queued message",
    ]);
  });

  test("a repeating wake, or a command wake that never wakes the model, is not waiting", () => {
    const child = conversation("recurring");
    expect(createChronoSchedule({ ownerConversationId: child, afterSeconds: 3600, repeat: { unit: "hour" }, message: "hourly check" }).error)
      .toBeUndefined();
    expect(createChronoSchedule({ ownerConversationId: child, afterSeconds: 60, command: "true" }).error).toBeUndefined();
    expect(describeSubagentPendingWork(child)).toEqual([]);
    expect(createChronoSchedule({
      ownerConversationId: child, afterSeconds: 60, command: "false", hardWake: { when: "failure", message: "it failed" },
    }).error).toBeUndefined();
    expect(describeSubagentPendingWork(child)).toEqual(["1 scheduled wake (next in 1 min)"]);
  });
});
