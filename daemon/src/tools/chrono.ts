import type { Tool, ToolResult } from "./types";
import { summarizeParams } from "./util";
import {
  adoptChronoSchedule,
  cancelChronoSchedule,
  createChronoSchedule,
  createChronoSchedules,
  deferChronoSleep,
  formatElapsedDuration,
  listChronoSchedules,
  type CreateScheduleInput,
  type RepeatInput,
} from "../chrono-service";
import { onBackgroundTaskEnded, type CompletedConversationTask } from "../conversation-activity";
import { checkChronoWaitTarget, waitForChronoWaitTarget } from "../chrono-wait-targets";
import { backgroundTaskWakeText } from "./chrono-output";
import { CLAUDE_CODE_INLINE_CHRONO_MAX_MS } from "./chrono-limits";
import { parseDurationMs } from "@exocortex/shared/duration";
import { LONG_CHRONO_SLEEP_THRESHOLD_MS } from "@exocortex/shared/chrono";
import { toolTextSource } from "./tool-text";

function action(input: Record<string, unknown>): string {
  return typeof input.action === "string" ? input.action : "";
}

function abortableSleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + durationMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const maxTimerMs = 2_000_000_000;

    function arm() {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return done();
      timer = setTimeout(arm, Math.min(maxTimerMs, remaining));
    }
    function cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    }
    function done() {
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    }
    if (signal?.aborted) aborted();
    else {
      signal?.addEventListener("abort", aborted, { once: true });
      arm();
    }
  });
}

function inlineChronoLimitMs(context: Parameters<Tool["execute"]>[1]): number {
  return context?.provider === "anthropic" ? CLAUDE_CODE_INLINE_CHRONO_MAX_MS : LONG_CHRONO_SLEEP_THRESHOLD_MS;
}

function undeferrableLongChronoError(kind: "sleep" | "wait", context: Parameters<Tool["execute"]>[1]): string {
  if (context?.provider === "anthropic") {
    return `Chrono ${kind}s longer than ${formatElapsedDuration(CLAUDE_CODE_INLINE_CHRONO_MAX_MS)} cannot run inside a Claude Code turn. Schedule a chrono wake with a message and end your turn.`;
  }
  return `Chrono ${kind}s longer than five minutes must be the only tool call in a model provider round so the turn can be suspended safely. Call chrono ${kind} again by itself.`;
}

/**
 * Let a user message end an inline sleep or wait early, as it resumes a
 * suspended one. A queued steer (or the manual background key) reaches the
 * running tool through its backgrounder.
 */
function interruptibleByUser(context: NonNullable<Parameters<Tool["execute"]>[1]>): {
  signal: AbortSignal;
  /** True when the user pressed the background key rather than sending a message. */
  manual(): boolean;
  release(): void;
} {
  const interrupt = new AbortController();
  let manual = false;
  context.registerBackgrounder?.({
    toolName: "chrono",
    toolCallId: context.toolCallId,
    background: (reason) => {
      if (interrupt.signal.aborted) return false;
      manual = reason === "manual";
      interrupt.abort();
      return true;
    },
  });
  return {
    signal: interrupt.signal,
    manual: () => manual,
    release: () => context.registerBackgrounder?.(null),
  };
}

const MAX_CANCEL_SCHEDULE_IDS = 50;

/** Exact ids from schedule_id and schedule_ids, merged and de-duplicated in order. */
function cancelScheduleIds(input: Record<string, unknown>): string[] | { error: string } {
  const raw: unknown[] = [];
  if (input.schedule_id !== undefined) raw.push(input.schedule_id);
  if (input.schedule_ids !== undefined) {
    if (!Array.isArray(input.schedule_ids)) return { error: "schedule_ids must be an array of exact schedule ids." };
    raw.push(...input.schedule_ids);
  }
  if (raw.some(id => typeof id !== "string")) return { error: "Chrono schedule ids must be strings." };
  return [...new Set((raw as string[]).map(id => id.trim()).filter(Boolean))];
}

const MAX_WAKES = 50;
const WAKE_FIELDS = ["at", "after_seconds", "title", "message", "command", "timeout_seconds", "timezone", "repeat", "hard_wake"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function wakeScheduleInput(fields: Record<string, unknown>, ownerConversationId: string): CreateScheduleInput {
  const repeat = isPlainObject(fields.repeat) ? fields.repeat as unknown as RepeatInput : undefined;
  const hardWake = isPlainObject(fields.hard_wake)
    ? fields.hard_wake as { when?: "failure" | "always"; message?: string; include_output?: boolean }
    : undefined;
  return {
    ownerConversationId,
    at: typeof fields.at === "string" ? fields.at : undefined,
    afterSeconds: typeof fields.after_seconds === "number" ? fields.after_seconds : undefined,
    repeat,
    timezone: typeof fields.timezone === "string" ? fields.timezone : undefined,
    message: typeof fields.message === "string" ? fields.message : undefined,
    command: typeof fields.command === "string" ? fields.command : undefined,
    title: typeof fields.title === "string" ? fields.title : undefined,
    timeoutSeconds: typeof fields.timeout_seconds === "number" ? fields.timeout_seconds : undefined,
    hardWake: hardWake ? {
      when: hardWake.when,
      message: hardWake.message,
      includeOutput: hardWake.include_output,
    } : undefined,
  };
}

/** The wakes array, or an error when it is malformed or mixed with top-level wake fields. */
function batchWakes(input: Record<string, unknown>): Record<string, unknown>[] | { error: string } {
  if (!Array.isArray(input.wakes)) return { error: "wakes must be an array of wake objects." };
  const mixed = WAKE_FIELDS.filter(field => input[field] !== undefined);
  if (mixed.length) {
    return { error: `Put every wake's fields inside its wakes item; top-level ${mixed.join(", ")} cannot be combined with wakes. Nothing was scheduled.` };
  }
  if (input.wakes.length === 0) return { error: "wakes must contain at least one wake." };
  if (input.wakes.length > MAX_WAKES) {
    return { error: `wake accepts at most ${MAX_WAKES} wakes per call; got ${input.wakes.length}. Nothing was scheduled.` };
  }
  const notObjects = input.wakes.flatMap((item, index) => isPlainObject(item) ? [] : [`wakes[${index}]: must be an object with the same fields as a single wake.`]);
  if (notObjects.length) return { error: `Invalid wakes; nothing was scheduled:\n${notObjects.join("\n")}` };
  return input.wakes as Record<string, unknown>[];
}

function wakeSummary(fields: Record<string, unknown>): string {
  return String(fields.title ?? fields.message ?? fields.command ?? fields.at ?? "");
}

function scheduledWakeOutput(schedule: NonNullable<ReturnType<typeof createChronoSchedule>["schedule"]>): string {
  return `Scheduled ${schedule.target.kind === "command" ? "soft wake" : "hard wake"}:\n${formatSchedule(schedule)}`;
}

function formatSchedule(schedule: ReturnType<typeof listChronoSchedules>[number]): string {
  const target = schedule.target.kind === "conversation" ? "hard wake" : schedule.target.hardWake ? "soft wake → hard wake" : "soft wake";
  const repeat = schedule.recurrence ? `, repeats ${schedule.recurrence.kind === "interval" ? `every ${schedule.recurrence.everyMs / 1000}s` : schedule.recurrence.kind === "calendar" ? `${schedule.recurrence.unit === "day" ? "daily" : schedule.recurrence.unit === "week" ? "weekly" : "monthly"} in ${schedule.recurrence.timezone}` : schedule.recurrence.expression}` : "";
  const status = schedule.status && schedule.status !== "scheduled" ? `${schedule.status} ` : "";
  return `${schedule.id} — ${schedule.title} — ${status}${target} at ${new Date(schedule.nextAt).toISOString()}${repeat}`;
}

async function execute(input: Record<string, unknown>, context: Parameters<Tool["execute"]>[1], signal?: AbortSignal): Promise<ToolResult> {
  const convId = context?.conversationId;
  if (!convId) return { output: "Chrono requires an active conversation context.", isError: true };
  const selected = action(input);

  if (selected === "wait") {
    const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";
    if (!taskId) return { output: "wait requires task_id.", isError: true };
    const maxWaitMs = parseDurationMs(input.max_wait);
    if (maxWaitMs === null) {
      return { output: "wait requires max_wait as a positive duration such as '30s', '1m20s', '2h 30m', or '1d'.", isError: true };
    }

    const maxWait = String(input.max_wait).trim();
    const startedAt = Date.now();
    const ownTaskId = `chrono:wait:${context.toolCallId ?? startedAt}`;
    // Only subagent turns carry a delegation budget; they may wait only on their own tasks.
    const ownerConversationId = context.subagentMaxDepth != null ? convId : undefined;
    if (maxWaitMs > LONG_CHRONO_SLEEP_THRESHOLD_MS) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const finished = await checkChronoWaitTarget(taskId, ownerConversationId);
        if (finished) return { output: finished.output, isError: false };
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (context.toolCallId && context.canDeferToolResult) {
        const deferred = deferChronoSleep({
          conversationId: convId,
          toolCallId: context.toolCallId,
          startedAt,
          durationMs: maxWaitMs,
          wait: { taskId, maxWait, ownerConversationId },
        });
        if (!deferred.sleep) return { output: deferred.error ?? "Could not defer Chrono wait.", isError: true };
        return {
          output: "",
          isError: false,
          deferred: {
            kind: "chrono_wait",
            waitId: deferred.sleep.id,
            startedAt,
            dueAt: startedAt + maxWaitMs,
            durationMs: maxWaitMs,
          },
        };
      }
      if (maxWaitMs > inlineChronoLimitMs(context)) {
        return { output: undeferrableLongChronoError("wait", context), isError: true };
      }
    }
    const waitController = new AbortController();
    const limitController = new AbortController();
    let limitReached = false;
    const abort = () => {
      waitController.abort();
      limitController.abort();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const userInterrupt = interruptibleByUser(context);
    userInterrupt.signal.addEventListener("abort", abort, { once: true });
    const limit = abortableSleep(maxWaitMs, limitController.signal)
      .then(() => {
        limitReached = true;
        waitController.abort();
      })
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
      });

    context.setChronoTaskActive?.(ownTaskId, true, {
      title: `Waiting up to ${maxWait} for ${taskId}`,
      startedAt,
      dueAt: startedAt + maxWaitMs,
      chronoMode: "wait",
    });
    try {
      const completed = await waitForChronoWaitTarget(taskId, waitController.signal, ownerConversationId);
      return { output: completed.output, isError: false };
    } catch (err) {
      if (limitReached && err instanceof DOMException && err.name === "AbortError") {
        return { output: JSON.stringify({ task_id: taskId, status: "wait_limit_reached", max_wait: maxWait }), isError: false };
      }
      if (userInterrupt.signal.aborted && !signal?.aborted && err instanceof DOMException && err.name === "AbortError") {
        return {
          output: JSON.stringify({
            task_id: taskId,
            status: "wait_interrupted",
            reason: userInterrupt.manual() ? "user_background" : "user_message",
            elapsed: formatElapsedDuration(Date.now() - startedAt),
            max_wait: maxWait,
          }),
          isError: false,
        };
      }
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    } finally {
      userInterrupt.release();
      limitController.abort();
      await limit;
      signal?.removeEventListener("abort", abort);
      context.setChronoTaskActive?.(ownTaskId, false);
    }
  }

  if (selected === "sleep") {
    const durationMs = parseDurationMs(input.duration);
    if (durationMs === null) return { output: "sleep requires duration such as '30s', '1m20s', '2h 30m', or '1d'.", isError: true };
    const startedAt = Date.now();
    const dueAt = startedAt + durationMs;
    const taskId = `chrono:sleep:${context.toolCallId ?? startedAt}`;
    if (durationMs > LONG_CHRONO_SLEEP_THRESHOLD_MS && context.toolCallId && context.canDeferToolResult) {
      const deferred = deferChronoSleep({
        conversationId: convId,
        toolCallId: context.toolCallId,
        startedAt,
        durationMs,
      });
      if (!deferred.sleep) return { output: deferred.error ?? "Could not defer Chrono sleep.", isError: true };
      return {
        output: "",
        isError: false,
        deferred: {
          kind: "chrono_sleep",
          sleepId: deferred.sleep.id,
          startedAt,
          dueAt,
          durationMs,
        },
      };
    }
    if (durationMs > inlineChronoLimitMs(context)) {
      return { output: undeferrableLongChronoError("sleep", context), isError: true };
    }
    context.setChronoTaskActive?.(taskId, true, {
      title: `Sleeping until ${new Date(dueAt).toISOString()}`,
      startedAt,
      dueAt,
      chronoMode: "sleep",
    });
    const userInterrupt = interruptibleByUser(context);
    // One of this conversation's own background tasks finishing ends the sleep too.
    const taskWake = new AbortController();
    let finishedTask: CompletedConversationTask | undefined;
    const stopWatchingTasks = onBackgroundTaskEnded((ownerConversationId, task) => {
      if (ownerConversationId !== convId || finishedTask) return;
      finishedTask = task;
      taskWake.abort();
    });
    try {
      await abortableSleep(durationMs, AbortSignal.any([userInterrupt.signal, taskWake.signal, ...(signal ? [signal] : [])]));
      return { output: `Sleep finished at ${new Date().toISOString()}.`, isError: false };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (userInterrupt.signal.aborted) {
        return {
          output: `Sleep interrupted after ${formatElapsedDuration(Date.now() - startedAt)} because ${userInterrupt.manual() ? "the user stopped waiting" : "the user sent a message"} (requested ${formatElapsedDuration(durationMs)}).`,
          isError: false,
        };
      }
      if (!finishedTask) throw err;
      return {
        output: backgroundTaskWakeText(formatElapsedDuration(Date.now() - startedAt), formatElapsedDuration(durationMs), finishedTask),
        isError: false,
      };
    } finally {
      stopWatchingTasks();
      userInterrupt.release();
      context.setChronoTaskActive?.(taskId, false);
    }
  }

  if (selected === "wake") {
    if (input.wakes === undefined) {
      const result = createChronoSchedule(wakeScheduleInput(input, convId));
      if (!result.schedule) return { output: result.error ?? "Could not create Chrono schedule.", isError: true };
      return { output: scheduledWakeOutput(result.schedule), isError: false };
    }
    const wakes = batchWakes(input);
    if ("error" in wakes) return { output: wakes.error, isError: true };
    const created = createChronoSchedules(wakes.map(fields => wakeScheduleInput(fields, convId)));
    if ("invalid" in created) {
      if (wakes.length === 1) return { output: created.invalid[0].error, isError: true };
      const lines = created.invalid.map(({ index, error }) => `wakes[${index}]: ${error}`);
      return { output: `Invalid wakes; nothing was scheduled:\n${lines.join("\n")}`, isError: true };
    }
    const { results } = created;
    if (wakes.length === 1) {
      const [result] = results;
      return result.schedule
        ? { output: scheduledWakeOutput(result.schedule), isError: false }
        : { output: result.error ?? "Could not create Chrono schedule.", isError: true };
    }
    const scheduled = results.filter(result => result.schedule).length;
    const lines = results.map((result, index) => result.schedule
      ? `scheduled: ${formatSchedule(result.schedule)}`
      : `error: wakes[${index}]: ${result.error ?? "Could not create Chrono schedule."}`);
    return {
      output: `Scheduled ${scheduled} of ${results.length} Chrono wakes:\n${lines.join("\n")}`,
      isError: scheduled === 0,
    };
  }

  if (selected === "list") {
    const items = listChronoSchedules(convId);
    return {
      output: items.length ? `Chrono schedules:\n${items.map(formatSchedule).join("\n")}` : "No Chrono schedules for this conversation.",
      isError: false,
    };
  }

  if (selected === "adopt") {
    const scheduleId = typeof input.schedule_id === "string" ? input.schedule_id.trim() : "";
    if (!scheduleId) return { output: "adopt requires schedule_id.", isError: true };
    const hardWakeRaw = input.hard_wake;
    const hardWake = hardWakeRaw && typeof hardWakeRaw === "object" && !Array.isArray(hardWakeRaw)
      ? hardWakeRaw as { when?: "failure" | "always"; message?: string; include_output?: boolean }
      : undefined;
    const result = adoptChronoSchedule({
      scheduleId,
      ownerConversationId: convId,
      hardWake: hardWake ? {
        when: hardWake.when,
        message: hardWake.message,
        includeOutput: hardWake.include_output,
      } : undefined,
    });
    return result.schedule
      ? { output: `Adopted Chrono schedule:\n${formatSchedule(result.schedule)}`, isError: false }
      : { output: result.error ?? "Could not adopt Chrono schedule.", isError: true };
  }

  if (selected === "cancel") {
    const ids = cancelScheduleIds(input);
    if ("error" in ids) return { output: ids.error, isError: true };
    if (ids.length === 0) return { output: "cancel requires schedule_id or schedule_ids.", isError: true };
    if (ids.length > MAX_CANCEL_SCHEDULE_IDS) {
      return { output: `cancel accepts at most ${MAX_CANCEL_SCHEDULE_IDS} schedule ids per call; got ${ids.length}. Nothing was cancelled.`, isError: true };
    }
    const results = ids.map(id => cancelChronoSchedule(id, convId));
    if (ids.length === 1) {
      const [result] = results;
      return result.cancelled
        ? { output: `Cancelled Chrono schedule: ${result.cancelled.id} (${result.cancelled.title})`, isError: false }
        : { output: result.error ?? "Chrono schedule not found.", isError: true };
    }
    const cancelled = results.filter(result => result.cancelled).length;
    const lines = results.map((result, index) => result.cancelled
      ? `cancelled: ${result.cancelled.id} (${result.cancelled.title})`
      : `error: ${result.error ?? `Chrono schedule not found: ${ids[index]}`}`);
    return {
      output: `Cancelled ${cancelled} of ${ids.length} Chrono schedules:\n${lines.join("\n")}`,
      isError: cancelled === 0,
    };
  }

  return { output: "Invalid Chrono action. Use wait, sleep, wake, list, adopt, or cancel.", isError: true };
}

/** Per-wake fields, accepted at the top level for one wake or inside each wakes item. */
const WAKE_PROPERTIES = {
  at: { type: "string", description: "For wake: future ISO-8601 date/time with an explicit timezone offset." },
  after_seconds: { type: "number", exclusiveMinimum: 0, description: "For wake: relative delay; cannot be combined with at." },
  title: { type: "string", description: "Short Tasks UI title for the scheduled wake." },
  message: { type: "string", description: "Hard wake payload: starts/queues a model turn in this conversation." },
  command: { type: "string", description: "Soft wake payload: runs directly without a model. Exactly one of message or command is required. Execution is at-least-once after crashes; CHRONO_OCCURRENCE_ID is exported for deduplication." },
  timeout_seconds: { type: "number", exclusiveMinimum: 0, maximum: 86400, description: "Soft-wake command timeout; defaults to 300 seconds." },
  timezone: { type: "string", description: "IANA timezone for daily/weekly/monthly recurrence; defaults to daemon local timezone." },
  repeat: {
    type: "object",
    description: "Optional structured recurrence. Minute/hour are fixed intervals; day/week/month preserve local wall time.",
    properties: {
      unit: { type: "string", enum: ["minute", "hour", "day", "week", "month"] },
      interval: { type: "integer", minimum: 1, maximum: 10000 },
      weekdays: { type: "array", items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } },
    },
    required: ["unit"],
    additionalProperties: false,
  },
  hard_wake: {
    type: "object",
    description: "For command soft-wakes: conditionally wake the model. With when=failure, the command can define any escalation condition by exiting non-zero.",
    properties: {
      when: { type: "string", enum: ["failure", "always"], description: "Defaults to failure." },
      message: { type: "string", description: "Instruction delivered to the model on escalation." },
      include_output: { type: "boolean", description: "Include capped command output; defaults to true." },
    },
    additionalProperties: false,
  },
};

const TEXT = toolTextSource("chrono");

export const chrono: Tool = {
  name: "chrono",
  get description() { return TEXT.description(); },
  get systemHint() { return TEXT.hint(); },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["wait", "sleep", "wake", "list", "adopt", "cancel"], description: "Chrono operation." },
      task_id: { type: "string", description: "For wait: exact active task id from the Tasks UI, exec_command, or daemon IPC list_tasks, or unit:NAME for a systemd user unit (Linux), which ends when the unit stops." },
      max_wait: { type: "string", description: "Required for wait: maximum duration to wait, such as 30s, 1m20s, 2h 30m, or 1d." },
      duration: { type: "string", description: "For sleep: positive duration such as 30s, 1m20s, 2h 30m, or 1d." },
      ...WAKE_PROPERTIES,
      wakes: {
        type: "array",
        items: { type: "object", properties: WAKE_PROPERTIES, additionalProperties: false },
        description: `For wake: schedule several wakes in one call (at most ${MAX_WAKES}). Each item takes the same fields as a single wake (at or after_seconds, message or command, title, repeat, timezone, timeout_seconds, hard_wake); do not also set those fields at the top level. Every item is validated before any is created, and each is reported on its own line.`,
      },
      schedule_id: { type: "string", description: "For adopt/cancel: exact Chrono schedule id. Adopt transfers an ownerless command schedule to this conversation and configures failure escalation." },
      schedule_ids: { type: "array", items: { type: "string" }, description: `For cancel: exact Chrono schedule ids to cancel in one call (at most ${MAX_CANCEL_SCHEDULE_IDS}); merged with schedule_id. Each id is cancelled independently and reported on its own line.` },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  watchdogExempt: true,
  display: { label: "Chrono", color: "#4ec9b0" },
  summarize(input) {
    const selected = action(input) || "invalid";
    if (selected === "wait") {
      const taskId = String(input.task_id ?? "");
      const primary = taskId ? `wait: ${taskId}` : "wait";
      return { label: "Chrono", detail: summarizeParams(primary, input, ["action", "task_id"]) };
    }
    if (selected === "cancel") {
      const ids = cancelScheduleIds(input);
      const detail = "error" in ids ? String(input.schedule_id ?? "")
        : ids.length > 1 ? `${ids.length} schedules: ${ids.join(", ")}`
          : ids[0] ?? "";
      return { label: "Chrono", detail: detail ? `cancel: ${detail}` : "cancel" };
    }
    if (selected === "wake" && Array.isArray(input.wakes)) {
      const titles = input.wakes.map(item => isPlainObject(item) ? wakeSummary(item) : "").filter(Boolean);
      const detail = input.wakes.length > 1 ? `${input.wakes.length} schedules: ${titles.join(", ")}` : titles[0] ?? "";
      return { label: "Chrono", detail: detail ? `wake: ${detail}` : "wake" };
    }
    const detail = selected === "sleep" ? String(input.duration ?? "")
      : selected === "wake" ? wakeSummary(input)
        : selected === "adopt" ? String(input.schedule_id ?? "")
          : "";
    return { label: "Chrono", detail: detail ? `${selected}: ${detail}` : selected };
  },
  execute,
};

export const chronoToolInternalsForTest = { parseDurationMs, abortableSleep };
