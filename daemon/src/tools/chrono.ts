import type { Tool, ToolResult } from "./types";
import { adoptChronoSchedule, createChronoSchedule, cancelChronoSchedule, listChronoSchedules, type RepeatInput } from "../chrono-service";
import { waitForConversationTask } from "../conversation-activity";

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i;

function parseDurationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(DURATION_RE);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = match[2].toLowerCase() === "ms" ? 1
    : match[2].toLowerCase() === "s" ? 1_000
      : match[2].toLowerCase() === "m" ? 60_000
        : match[2].toLowerCase() === "h" ? 3_600_000
          : 86_400_000;
  const result = amount * multiplier;
  return Number.isFinite(result) && result > 0 ? Math.round(result) : null;
}

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
      return { output: "wait requires max_wait as a positive duration such as '30s', '20m', '2h', or '1d'.", isError: true };
    }

    const maxWait = String(input.max_wait).trim();
    const startedAt = Date.now();
    const ownTaskId = `chrono:wait:${context.toolCallId ?? startedAt}`;
    const waitController = new AbortController();
    const limitController = new AbortController();
    let limitReached = false;
    const abort = () => {
      waitController.abort();
      limitController.abort();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
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
      const completed = await waitForConversationTask(taskId, waitController.signal);
      return { output: `Task finished: ${completed.id} (${completed.title})`, isError: false };
    } catch (err) {
      if (limitReached && err instanceof DOMException && err.name === "AbortError") {
        return { output: `Wait limit reached after ${maxWait} before task completion was observed: ${taskId}`, isError: false };
      }
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    } finally {
      limitController.abort();
      await limit;
      signal?.removeEventListener("abort", abort);
      context.setChronoTaskActive?.(ownTaskId, false);
    }
  }

  if (selected === "sleep") {
    const durationMs = parseDurationMs(input.duration);
    if (durationMs === null) return { output: "sleep requires duration such as '30s', '20m', '2h', or '1d'.", isError: true };
    const startedAt = Date.now();
    const dueAt = startedAt + durationMs;
    const taskId = `chrono:sleep:${context.toolCallId ?? startedAt}`;
    context.setChronoTaskActive?.(taskId, true, {
      title: `Sleeping until ${new Date(dueAt).toISOString()}`,
      startedAt,
      dueAt,
      chronoMode: "sleep",
    });
    try {
      await abortableSleep(durationMs, signal);
      return { output: `Sleep finished at ${new Date().toISOString()}.`, isError: false };
    } finally {
      context.setChronoTaskActive?.(taskId, false);
    }
  }

  if (selected === "wake") {
    const repeatRaw = input.repeat;
    const repeat = repeatRaw && typeof repeatRaw === "object" && !Array.isArray(repeatRaw)
      ? repeatRaw as unknown as RepeatInput
      : undefined;
    const hardWakeRaw = input.hard_wake;
    const hardWake = hardWakeRaw && typeof hardWakeRaw === "object" && !Array.isArray(hardWakeRaw)
      ? hardWakeRaw as { when?: "failure" | "always"; message?: string; include_output?: boolean }
      : undefined;
    const result = createChronoSchedule({
      ownerConversationId: convId,
      at: typeof input.at === "string" ? input.at : undefined,
      afterSeconds: typeof input.after_seconds === "number" ? input.after_seconds : undefined,
      repeat,
      timezone: typeof input.timezone === "string" ? input.timezone : undefined,
      message: typeof input.message === "string" ? input.message : undefined,
      command: typeof input.command === "string" ? input.command : undefined,
      title: typeof input.title === "string" ? input.title : undefined,
      timeoutSeconds: typeof input.timeout_seconds === "number" ? input.timeout_seconds : undefined,
      hardWake: hardWake ? {
        when: hardWake.when,
        message: hardWake.message,
        includeOutput: hardWake.include_output,
      } : undefined,
    });
    if (!result.schedule) return { output: result.error ?? "Could not create Chrono schedule.", isError: true };
    return {
      output: `Scheduled ${result.schedule.target.kind === "command" ? "soft wake" : "hard wake"}:\n${formatSchedule(result.schedule)}`,
      isError: false,
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
    const scheduleId = typeof input.schedule_id === "string" ? input.schedule_id.trim() : "";
    if (!scheduleId) return { output: "cancel requires schedule_id.", isError: true };
    const result = cancelChronoSchedule(scheduleId, convId);
    return result.cancelled
      ? { output: `Cancelled Chrono schedule: ${result.cancelled.id} (${result.cancelled.title})`, isError: false }
      : { output: result.error ?? "Chrono schedule not found.", isError: true };
  }

  return { output: "Invalid Chrono action. Use wait, sleep, wake, list, adopt, or cancel.", isError: true };
}

export const chrono: Tool = {
  name: "chrono",
  description: "Wait for an active task up to a required limit, sleep the current model turn, or manage durable one-shot/recurring wakes. A message is a hard wake that starts the model. A command is a soft wake that runs without a model and can escalate to a hard wake on failure or a script-defined non-zero exit.",
  systemHint: "Use Chrono instead of shell sleep, polling background tasks, or cron. `wait` requires a `max_wait` safety limit and wakes immediately when the task finishes or that limit is reached. `sleep` pauses this turn for a duration. `wake` persists across daemon restarts; message wakes start a model turn, while command soft-wakes can use hard_wake to escalate failures or command-defined non-zero conditions. `adopt` attaches an ownerless daemon command schedule to this conversation and configures its hard wake. Command occurrences are at-least-once across crash windows and receive CHRONO_OCCURRENCE_ID, so side-effecting commands should deduplicate that id. Use list/cancel to manage owned schedules.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["wait", "sleep", "wake", "list", "adopt", "cancel"], description: "Chrono operation." },
      task_id: { type: "string", description: "For wait: exact active task id from the Tasks UI or exo tasks." },
      max_wait: { type: "string", description: "Required for wait: maximum duration to wait, such as 30s, 20m, 2h, or 1d." },
      duration: { type: "string", description: "For sleep: positive duration such as 30s, 20m, 2h, or 1d." },
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
      schedule_id: { type: "string", description: "For adopt/cancel: exact Chrono schedule id. Adopt transfers an ownerless command schedule to this conversation and configures failure escalation." },
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
    const detail = selected === "wait" ? String(input.task_id ?? "")
      : selected === "sleep" ? String(input.duration ?? "")
        : selected === "wake" ? String(input.title ?? input.message ?? input.command ?? input.at ?? "")
          : selected === "adopt" || selected === "cancel" ? String(input.schedule_id ?? "")
            : "";
    return { label: "Chrono", detail: detail ? `${selected}: ${detail}` : selected };
  },
  execute,
};

export const chronoToolInternalsForTest = { parseDurationMs, abortableSleep };
