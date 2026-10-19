import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { dataDir } from "@exocortex/shared/paths";
import { chrono } from "./chrono";
import { chronoInternalsForTest, installMigratedSchedule } from "../chrono-service";
import { resetConversationActivityForTest, setBackgroundTaskActive, recordBackgroundTaskCompletion } from "../conversation-activity";
import { create, remove } from "../conversations";
import { buildExecutor } from "./registry";
import type { ActiveToolBackgrounder } from "./types";

const conversationIds: string[] = [];

function makeConversation(label: string): string {
  const id = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 8)}`;
  conversationIds.push(id);
  create(id, "openai", "gpt-5.6-sol", label);
  return id;
}

afterEach(() => {
  chronoInternalsForTest.reset();
  resetConversationActivityForTest();
  for (const id of conversationIds.splice(0)) remove(id);
});

describe("Chrono tool", () => {
  test("guidance leaves exec session polling to write_stdin", () => {
    expect(chrono.systemHint).toContain("Use native session polling for shell tools that provide it");
    expect(chrono.systemHint).not.toContain("Prefer chrono over shell sleep, polling");
  });

  test("wait succeeds immediately after completion and exposes exit/output evidence", async () => {
    recordBackgroundTaskCompletion("owner", {
      taskId: "bash:finished", toolName: "bash", title: "test", startedAt: 1,
      endedAt: Date.now(), exitCode: 3, signal: null, outputPath: "/tmp/finished.log",
    });
    const result = await chrono.execute({ action: "wait", task_id: "bash:finished", max_wait: "1s" },
      { conversationId: "owner", subagentMaxDepth: 0 });
    expect(result.isError).toBe(false); // The wait succeeded; the process did not.
    expect(JSON.parse(result.output)).toMatchObject({
      task_id: "bash:finished", status: "completed", exit_code: 3, output_path: "/tmp/finished.log",
    });
    const foreign = await chrono.execute({ action: "wait", task_id: "bash:finished", max_wait: "1s" },
      { conversationId: "foreign", subagentMaxDepth: 0 });
    expect(foreign.isError).toBe(true);
    // A child that may still delegate is just as limited to its own tasks.
    const delegatingChild = await chrono.execute({ action: "wait", task_id: "bash:finished", max_wait: "1s" },
      { conversationId: "foreign", subagentMaxDepth: 1 });
    expect(delegatingChild.isError).toBe(true);
  });

  test("shows the wait limit as a flag in TUI summaries", () => {
    expect(chrono.summarize({ action: "wait", task_id: "bash:42", max_wait: "20m" }).detail)
      .toBe("wait: bash:42 --max_wait 20m");
  });

  test("wait requires an explicit maximum duration", async () => {
    const result = await chrono.execute(
      { action: "wait", task_id: "bash:42" },
      { conversationId: "parent" },
    );
    expect(result).toEqual(expect.objectContaining({ isError: true }));
    expect(result.output).toContain("requires max_wait");
  });

  test("wait resolves on task completion and reports its own Tasks UI lifecycle", async () => {
    setBackgroundTaskActive("parent", "bash:42", true, { title: "test job", startedAt: 1 });
    const activity = mock(() => {});
    const resultPromise = chrono.execute(
      { action: "wait", task_id: "bash:42", max_wait: "5m" },
      { conversationId: "parent", toolCallId: "call-1", setChronoTaskActive: activity },
    );
    setBackgroundTaskActive("parent", "bash:42", false);
    await expect(resultPromise).resolves.toEqual(expect.objectContaining({ isError: false }));
    expect(activity).toHaveBeenNthCalledWith(1, "chrono:wait:call-1", true, expect.objectContaining({
      title: "Waiting up to 5m for bash:42",
      chronoMode: "wait",
      dueAt: expect.any(Number),
    }));
    expect(activity).toHaveBeenLastCalledWith("chrono:wait:call-1", false);
  });

  test("wait returns when its maximum duration is reached and clears its Tasks UI row", async () => {
    setBackgroundTaskActive("parent", "bash:slow", true, { title: "slow job", startedAt: 1 });
    const activity = mock(() => {});
    const result = await chrono.execute(
      { action: "wait", task_id: "bash:slow", max_wait: "5ms" },
      { conversationId: "parent", toolCallId: "call-limit", setChronoTaskActive: activity },
    );
    expect(result).toEqual(expect.objectContaining({ isError: false }));
    expect(JSON.parse(result.output)).toEqual({ task_id: "bash:slow", status: "wait_limit_reached", max_wait: "5ms" });
    expect(activity).toHaveBeenLastCalledWith("chrono:wait:call-limit", false);
  });

  test("sleep is abortable and always clears its Tasks UI row", async () => {
    const activity = mock(() => {});
    const controller = new AbortController();
    const result = chrono.execute(
      { action: "sleep", duration: "5m" },
      { conversationId: "parent", toolCallId: "call-2", setChronoTaskActive: activity },
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(activity).toHaveBeenLastCalledWith("chrono:sleep:call-2", false);
  });

  test("sleep longer than five minutes defers its tool result instead of waiting", async () => {
    const conversationId = makeConversation("long-sleep");
    const result = await chrono.execute(
      { action: "sleep", duration: "5m1ms" },
      { conversationId, toolCallId: "call-long", canDeferToolResult: true },
    );

    expect(result).toMatchObject({
      output: "",
      isError: false,
      deferred: {
        kind: "chrono_sleep",
        sleepId: "chrono:sleep:call-long",
        durationMs: 300_001,
      },
    });
  });

  test("a long sleep in a multi-tool round asks the model to retry it alone", async () => {
    const conversationId = makeConversation("long-sleep-batch");
    const result = await chrono.execute(
      { action: "sleep", duration: "10m" },
      { conversationId, toolCallId: "call-batch", canDeferToolResult: false },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be the only tool call");
  });

  test("a long sleep from Claude Code runs inside the call and a user message ends it early", async () => {
    const conversationId = makeConversation("long-sleep-claude-code");
    let backgrounder: ActiveToolBackgrounder | null = null;
    const pending = buildExecutor({
      conversationId,
      provider: "anthropic",
      registerBackgrounder: (next) => { backgrounder = next; },
    })([{ id: "toolu_long", name: "chrono", input: { action: "sleep", duration: "2h" } }]);
    while (!backgrounder) await Bun.sleep(1);

    expect((backgrounder as ActiveToolBackgrounder).background("steer")).toBe(true);
    const [result] = await pending;
    expect(result.deferred).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/^Sleep interrupted after .* because the user sent a message \(requested 2h\)\.$/);
    expect(backgrounder).toBeNull();
  });

  test("Claude Code is pointed at a wake only past the longest sleep a call can hold", async () => {
    const conversationId = makeConversation("too-long-sleep-claude-code");
    const [result] = await buildExecutor({ conversationId, provider: "anthropic" })(
      [{ id: "toolu_too_long", name: "chrono", input: { action: "sleep", duration: "25d" } }],
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot run inside a Claude Code turn");
    expect(result.output).toContain("chrono wake");
  });

  test("a long wait from Claude Code runs inside the call until the user stops it", async () => {
    const conversationId = makeConversation("long-wait-claude-code");
    setBackgroundTaskActive(conversationId, "bash:slow", true, { title: "slow", startedAt: 1 });
    let backgrounder: ActiveToolBackgrounder | null = null;
    const pending = buildExecutor({
      conversationId,
      provider: "anthropic",
      registerBackgrounder: (next) => { backgrounder = next; },
    })([{ id: "toolu_wait", name: "chrono", input: { action: "wait", task_id: "bash:slow", max_wait: "40m" } }]);
    while (!backgrounder) await Bun.sleep(1);

    (backgrounder as ActiveToolBackgrounder).background("manual");
    const [result] = await pending;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      task_id: "bash:slow", status: "wait_interrupted", reason: "user_background", max_wait: "40m",
    });
  });

  test("a wait above the same five-minute cutoff suspends immediately", async () => {
    const conversationId = makeConversation("long-wait");
    setBackgroundTaskActive(conversationId, "bash:long", true, { title: "build", startedAt: 1 });
    const result = await chrono.execute(
      { action: "wait", task_id: "bash:long", max_wait: "5m1ms" },
      { conversationId, toolCallId: "wait-long", canDeferToolResult: true },
    );
    expect(result).toMatchObject({
      output: "", isError: false,
      deferred: { kind: "chrono_wait", waitId: "chrono:wait:wait-long", durationMs: 300_001 },
    });
  });

  test("long waits validate targets and ownership before suspending", async () => {
    const conversationId = makeConversation("invalid-wait");
    const context = { conversationId, toolCallId: "invalid", canDeferToolResult: true, subagentMaxDepth: 0 };
    const missing = await chrono.execute({ action: "wait", task_id: "missing", max_wait: "1h" }, context);
    expect(missing.isError).toBe(true);
    expect(missing.deferred).toBeUndefined();
    setBackgroundTaskActive("other", "bash:foreign", true, { title: "private", startedAt: 1 });
    const foreign = await chrono.execute({ action: "wait", task_id: "bash:foreign", max_wait: "1h" }, context);
    expect(foreign.output).toContain("own tasks");
    expect(foreign.deferred).toBeUndefined();
  });

  test("already-completed tasks return inline even with a long wait limit or multiple tools", async () => {
    recordBackgroundTaskCompletion("owner", {
      taskId: "bash:done", toolName: "bash", title: "done", startedAt: 1,
      endedAt: Date.now(), exitCode: 0, signal: null, outputPath: "/tmp/done.log",
    });
    const result = await chrono.execute(
      { action: "wait", task_id: "bash:done", max_wait: "1h" },
      { conversationId: "owner", canDeferToolResult: false },
    );
    expect(result.isError).toBe(false);
    expect(result.deferred).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ status: "completed", exit_code: 0 });
  });

  test("a long wait in a multi-tool round asks the model to retry it alone", async () => {
    const conversationId = makeConversation("wait-batch");
    setBackgroundTaskActive(conversationId, "bash:batch", true, { title: "job", startedAt: 1 });
    const result = await chrono.execute(
      { action: "wait", task_id: "bash:batch", max_wait: "10m" },
      { conversationId, toolCallId: "wait-batch", canDeferToolResult: false },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be the only tool call");
  });

  test("an aborted long wait never leaves a durable suspension", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(chrono.execute(
      { action: "wait", task_id: "missing", max_wait: "1h" },
      { conversationId: "owner", toolCallId: "aborted", canDeferToolResult: true },
      controller.signal,
    )).rejects.toThrow("Aborted");
  });

  test("creates and lists a durable hard wake", async () => {
    const created = await chrono.execute({
      action: "wake",
      after_seconds: 60,
      title: "Check inbox",
      message: "Check my inbox.",
    }, { conversationId: "parent" });
    expect(created.isError).toBe(false);
    expect(created.output).toContain("Scheduled hard wake");

    const listed = await chrono.execute({ action: "list" }, { conversationId: "parent" });
    expect(listed.output).toContain("Check inbox");
  });

  test("adopts an ownerless daemon command schedule", async () => {
    installMigratedSchedule({
      id: "chrono:migrated:tool-adopt",
      title: "Recorder monitor",
      createdAt: Date.now(),
      nextAt: Date.now() + 60_000,
      target: { kind: "command", command: "exit 1", timeoutMs: 30_000 },
      source: "legacy-cron",
    });
    const adopted = await chrono.execute({
      action: "adopt",
      schedule_id: "chrono:migrated:tool-adopt",
      hard_wake: { message: "Investigate PMV4." },
    }, { conversationId: "pmv4-owner" });
    expect(adopted).toEqual(expect.objectContaining({ isError: false }));
    expect(adopted.output).toContain("soft wake → hard wake");

    const listed = await chrono.execute({ action: "list" }, { conversationId: "pmv4-owner" });
    expect(listed.output).toContain("Recorder monitor");
  });

  async function scheduleWake(conversationId: string, title: string): Promise<string> {
    const created = await chrono.execute({ action: "wake", after_seconds: 60, title, message: title }, { conversationId });
    const id = created.output.match(/chrono:[0-9a-f-]+/)?.[0];
    if (!id) throw new Error(`No schedule id in: ${created.output}`);
    return id;
  }

  test("cancel still accepts a single schedule_id", async () => {
    const id = await scheduleWake("parent", "Solo");
    const result = await chrono.execute({ action: "cancel", schedule_id: id }, { conversationId: "parent" });
    expect(result).toEqual({ output: `Cancelled Chrono schedule: ${id} (Solo)`, isError: false });
    const missing = await chrono.execute({ action: "cancel", schedule_id: id }, { conversationId: "parent" });
    expect(missing).toEqual({ output: `Chrono schedule not found: ${id}`, isError: true });
  });

  test("cancels several owned schedules in one call", async () => {
    const ids = [await scheduleWake("parent", "One"), await scheduleWake("parent", "Two"), await scheduleWake("parent", "Three")];
    const result = await chrono.execute({ action: "cancel", schedule_id: ids[0], schedule_ids: ids.slice(1) }, { conversationId: "parent" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe([
      "Cancelled 3 of 3 Chrono schedules:",
      `cancelled: ${ids[0]} (One)`,
      `cancelled: ${ids[1]} (Two)`,
      `cancelled: ${ids[2]} (Three)`,
    ].join("\n"));
    const listed = await chrono.execute({ action: "list" }, { conversationId: "parent" });
    expect(listed.output).toBe("No Chrono schedules for this conversation.");
  });

  test("batch cancel reports each missing or foreign id and only errors when nothing was cancelled", async () => {
    const mine = await scheduleWake("parent", "Mine");
    const theirs = await scheduleWake("other", "Theirs");
    const result = await chrono.execute({ action: "cancel", schedule_ids: [mine, "chrono:missing", theirs] }, { conversationId: "parent" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe([
      "Cancelled 1 of 3 Chrono schedules:",
      `cancelled: ${mine} (Mine)`,
      "error: Chrono schedule not found: chrono:missing",
      `error: Chrono schedule not found: ${theirs}`,
    ].join("\n"));
    const otherList = await chrono.execute({ action: "list" }, { conversationId: "other" });
    expect(otherList.output).toContain("Theirs");

    const none = await chrono.execute({ action: "cancel", schedule_ids: [mine, theirs] }, { conversationId: "parent" });
    expect(none.isError).toBe(true);
    expect(none.output).toStartWith("Cancelled 0 of 2 Chrono schedules:");
  });

  test("batch cancel de-duplicates ids and refuses prefixes, all, and oversized batches", async () => {
    const id = await scheduleWake("parent", "Once");
    const deduped = await chrono.execute({ action: "cancel", schedule_id: id, schedule_ids: [id, ` ${id} `] }, { conversationId: "parent" });
    expect(deduped).toEqual({ output: `Cancelled Chrono schedule: ${id} (Once)`, isError: false });

    const kept = await scheduleWake("parent", "Kept");
    const fuzzy = await chrono.execute({ action: "cancel", schedule_ids: ["all", kept.slice(0, 12)] }, { conversationId: "parent" });
    expect(fuzzy.isError).toBe(true);
    const tooMany = await chrono.execute({
      action: "cancel",
      schedule_ids: [kept, ...Array.from({ length: 50 }, (_, index) => `chrono:missing-${index}`)],
    }, { conversationId: "parent" });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.output).toContain("at most 50");
    expect((await chrono.execute({ action: "list" }, { conversationId: "parent" })).output).toContain("Kept");

    expect((await chrono.execute({ action: "cancel", schedule_ids: [] }, { conversationId: "parent" })).isError).toBe(true);
    expect((await chrono.execute({ action: "cancel", schedule_ids: [42] }, { conversationId: "parent" })).isError).toBe(true);
  });

  test("summarizes batch cancels readably", () => {
    expect(chrono.summarize({ action: "cancel", schedule_id: "chrono:a" }).detail).toBe("cancel: chrono:a");
    expect(chrono.summarize({ action: "cancel", schedule_id: "chrono:a", schedule_ids: ["chrono:b", "chrono:a"] }).detail)
      .toBe("cancel: 2 schedules: chrono:a, chrono:b");
  });

  const FUTURE = "2099-01-02T03:04:05.000Z";

  test("a single top-level wake is unchanged and matches a one-item wakes batch", async () => {
    const single = await chrono.execute({ action: "wake", at: FUTURE, title: "Solo", message: "solo" }, { conversationId: "parent" });
    const id = single.output.match(/chrono:[0-9a-f-]+/)?.[0];
    expect(single).toEqual({ output: `Scheduled hard wake:\n${id} — Solo — hard wake at ${FUTURE}`, isError: false });

    const batched = await chrono.execute({ action: "wake", wakes: [{ at: FUTURE, title: "Solo", command: "true" }] }, { conversationId: "parent" });
    const batchedId = batched.output.match(/chrono:[0-9a-f-]+/)?.[0];
    expect(batched).toEqual({ output: `Scheduled soft wake:\n${batchedId} — Solo — soft wake at ${FUTURE}`, isError: false });

    const invalidOne = await chrono.execute({ action: "wake", wakes: [{ at: FUTURE }] }, { conversationId: "parent" });
    expect(invalidOne).toEqual({ output: "Wake requires exactly one of 'message' or 'command'.", isError: true });
  });

  test("schedules several mixed wakes in one call", async () => {
    const before = Date.now();
    const result = await chrono.execute({
      action: "wake",
      wakes: [
        { at: FUTURE, title: "Nag", message: "Deadline soon." },
        { after_seconds: 600, title: "Check", command: "true", hard_wake: { when: "always", message: "Look." } },
        { at: FUTURE, title: "Daily", message: "Daily check.", repeat: { unit: "day" }, timezone: "UTC" },
        { after_seconds: 60, command: "echo plain", timeout_seconds: 5 },
      ],
    }, { conversationId: "parent" });
    expect(result.isError).toBe(false);
    const lines = result.output.split("\n");
    expect(lines[0]).toBe("Scheduled 4 of 4 Chrono wakes:");
    expect(lines[1]).toMatch(new RegExp(`^scheduled: chrono:[0-9a-f-]+ — Nag — hard wake at ${FUTURE}$`));
    expect(lines[2]).toMatch(/^scheduled: chrono:[0-9a-f-]+ — Check — soft wake → hard wake at \S+$/);
    expect(lines[3]).toMatch(new RegExp(`^scheduled: chrono:[0-9a-f-]+ — Daily — hard wake at ${FUTURE}, repeats daily in UTC$`));
    expect(lines[4]).toMatch(/^scheduled: chrono:[0-9a-f-]+ — echo plain — soft wake at \S+$/);
    expect(lines).toHaveLength(5);
    const checkAt = Date.parse(lines[2].split(" at ")[1]);
    expect(checkAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(checkAt).toBeLessThanOrEqual(Date.now() + 600_000);

    const listed = (await chrono.execute({ action: "list" }, { conversationId: "parent" })).output.split("\n");
    expect(listed).toHaveLength(5);
    for (const line of lines.slice(1)) expect(listed).toContain(line.replace("scheduled: ", ""));
  });

  test("an invalid wake in a batch schedules nothing and names every bad index", async () => {
    const result = await chrono.execute({
      action: "wake",
      wakes: [
        { after_seconds: 60, message: "fine" },
        { after_seconds: 60, message: "both", command: "true" },
        { at: "2000-01-01T00:00:00Z", message: "past" },
        { after_seconds: 60, command: "true", repeat: { unit: "fortnight" } },
      ],
    }, { conversationId: "parent" });
    expect(result).toEqual({
      output: [
        "Invalid wakes; nothing was scheduled:",
        "wakes[1]: Wake requires exactly one of 'message' or 'command'.",
        "wakes[2]: Wake time must be in the future.",
        "wakes[3]: repeat.unit must be minute, hour, day, week, or month.",
      ].join("\n"),
      isError: true,
    });
    const nonObject = await chrono.execute({ action: "wake", wakes: [{ after_seconds: 60, message: "fine" }, "soon", null] }, { conversationId: "parent" });
    expect(nonObject.isError).toBe(true);
    expect(nonObject.output).toBe([
      "Invalid wakes; nothing was scheduled:",
      "wakes[1]: must be an object with the same fields as a single wake.",
      "wakes[2]: must be an object with the same fields as a single wake.",
    ].join("\n"));
    expect((await chrono.execute({ action: "list" }, { conversationId: "parent" })).output).toBe("No Chrono schedules for this conversation.");
  });

  test("wakes refuses empty, non-array, oversized, and mixed-with-top-level input", async () => {
    const run = (input: Record<string, unknown>) => chrono.execute({ action: "wake", ...input }, { conversationId: "parent" });
    expect(await run({ wakes: [] })).toEqual({ output: "wakes must contain at least one wake.", isError: true });
    expect(await run({ wakes: { after_seconds: 60, message: "x" } })).toEqual({ output: "wakes must be an array of wake objects.", isError: true });
    const tooMany = await run({ wakes: Array.from({ length: 51 }, (_, index) => ({ after_seconds: 60 + index, message: `n${index}` })) });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.output).toContain("at most 50");
    const mixed = await run({ title: "Shared", after_seconds: 60, wakes: [{ after_seconds: 60, message: "x" }] });
    expect(mixed.isError).toBe(true);
    expect(mixed.output).toContain("top-level after_seconds, title cannot be combined with wakes");
    expect((await chrono.execute({ action: "list" }, { conversationId: "parent" })).output).toBe("No Chrono schedules for this conversation.");

    const fifty = await run({ wakes: Array.from({ length: 50 }, (_, index) => ({ after_seconds: 60 + index, message: `n${index}` })) });
    expect(fifty.output).toStartWith("Scheduled 50 of 50 Chrono wakes:");
  });

  test("a batch that validates but cannot be saved reports each item and leaves nothing behind", async () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    let result;
    try {
      result = await chrono.execute({ action: "wake", wakes: [{ after_seconds: 60, message: "a" }, { after_seconds: 60, message: "b" }] }, { conversationId: "parent" });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(result.isError).toBe(true);
    const lines = result.output.split("\n");
    expect(lines[0]).toBe("Scheduled 0 of 2 Chrono wakes:");
    expect(lines[1]).toStartWith("error: wakes[0]: Could not save Chrono schedule:");
    expect(lines[2]).toStartWith("error: wakes[1]: Could not save Chrono schedule:");
    expect((await chrono.execute({ action: "list" }, { conversationId: "parent" })).output).toBe("No Chrono schedules for this conversation.");
  });

  test("summarizes batch wakes readably", () => {
    expect(chrono.summarize({ action: "wake", title: "Solo", message: "x" }).detail).toBe("wake: Solo");
    expect(chrono.summarize({ action: "wake", wakes: [{ title: "Solo", message: "x" }] }).detail).toBe("wake: Solo");
    expect(chrono.summarize({ action: "wake", wakes: [{ title: "16:00", message: "x" }, { command: "notify" }, { title: "16:53", message: "y" }] }).detail)
      .toBe("wake: 3 schedules: 16:00, notify, 16:53");
    expect(chrono.summarize({ action: "wake", wakes: [] }).detail).toBe("wake");
  });
});
