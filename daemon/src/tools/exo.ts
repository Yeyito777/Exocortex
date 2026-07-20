import { MAX_EXO_SUBAGENT_DEPTH } from "../messages";
import type { Tool } from "./types";

export const EXO_ACTIONS = [
  "send",
  "list",
  "jobs",
  "tasks",
  "info",
  "history",
  "abort",
  "queue",
  "commands",
] as const;

export type ExoAction = typeof EXO_ACTIONS[number];

function actionFromInput(input: Record<string, unknown>): ExoAction | null {
  return typeof input.action === "string" && (EXO_ACTIONS as readonly string[]).includes(input.action)
    ? input.action as ExoAction
    : null;
}

function detailValue(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0) return value.map(String).join(", ");
  return undefined;
}

function summaryValue(value: unknown): string {
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function summarizeExoParams(primary: string, input: Record<string, unknown>, skip: string[]): string {
  const parts = [primary];
  for (const [key, value] of Object.entries(input)) {
    if (skip.includes(key) || value == null) continue;
    const flag = key.startsWith("-") ? key : `--${key}`;
    if (value === true) parts.push(flag);
    else parts.push(`${flag} ${summaryValue(value)}`);
  }
  return parts.join(" ");
}

const EXO_SYSTEM_HINT = [
  "Use the native `exo` tool for the current daemon and its subagents.",
  "Default to doing the work yourself. Spawn subagents only for substantial, independent workstreams that can run concurrently, or when a genuinely difficult and high-risk problem would materially benefit from an independent analysis.",
  "Do not spawn subagents for ordinary repository inspection, routine planning, single-component implementation, or generic code review. Do not delegate work you are simultaneously doing yourself.",
  "Before spawning, identify a concrete, non-overlapping deliverable and how its result will be used. Prefer no more than two active children; exceed that only for clearly partitioned work with substantial expected wall-time savings or when the user explicitly requests broader delegation.",
  "Start reviews only after the implementation is stable. Prefer one targeted review; do not launch repeated final reviews without substantial new changes or unresolved high-risk findings. Reuse an existing child instead of spawning a replacement while it is still running.",
  "When an OpenAI subagent is warranted, omit `model` for the newest default (currently gpt-5.6-sol), use gpt-5.6-terra or gpt-5.6-luna for lighter work, and use older generations only when requested or required.",
  "Starting a subagent requires a short title of about three words; it becomes the child conversation title and identifies the task in the parent UI.",
  "Set max_depth=0 unless the child has a clear need to delegate a further independent workstream.",
  "When asked to manage external notification subscriptions, use action=commands with command=notifications; it can discover sources and defaults subscription targets to the active conversation.",
  "Subagents start in the daemon's working directory, so include the target absolute directory and all necessary task context.",
].join("\n");

export const exo: Tool = {
  name: "exo",
  description: "Manage the current Exocortex daemon directly. Frequent conversation, subagent, and active-task inspection operations are direct actions. Use action=commands to discover lower-frequency management commands on demand. Transcription and cross-instance targeting are intentionally excluded.",
  systemHint: EXO_SYSTEM_HINT,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: EXO_ACTIONS,
        description: "Operation to perform on the current daemon.",
      },
      text: {
        type: "string",
        description: "Message/task for send or queue.",
      },
      conversation_id: {
        type: "string",
        description: "Conversation targeted by send, tasks, info, history, abort, or queue. For tasks, omit to inspect work owned by the active conversation. Omit for send to create a new subagent.",
      },
      title: {
        type: "string",
        description: "Required when send creates a new subagent (conversation_id omitted). Short title of about three words; becomes the child conversation title and appears in the parent's Tasks UI.",
      },
      max_depth: {
        type: "integer",
        minimum: 0,
        maximum: MAX_EXO_SUBAGENT_DEPTH,
        description: `Required for send and queue. Maximum number of additional subagent generations permitted (0-${MAX_EXO_SUBAGENT_DEPTH}), not a target. Use 0 unless the target clearly needs to delegate; a spawned caller may set at most its own max_depth minus one.`,
      },
      query: {
        type: "string",
        description: "Optional case-insensitive filter for list, jobs, or tasks.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Maximum results for list, jobs, tasks, or history. Defaults to 25 for list/jobs/tasks and 50 for history; list/jobs/tasks cap at 100 and history at 200.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Pagination offset for list/jobs/tasks, or number of newest entries to skip for history. Defaults to 0.",
      },
      scope: {
        type: "string",
        enum: ["children", "all"],
        description: "For jobs/list, restrict to child conversations or include all. For tasks, children means work owned by the selected/active conversation and all means daemon-wide. Jobs/tasks default to children; list defaults to all.",
      },
      kind: {
        type: "string",
        enum: ["all", "subagent", "background", "chrono"],
        description: "For action=tasks, filter active work by kind. Defaults to all.",
      },
      provider: {
        type: "string",
        enum: ["openai", "deepseek"],
        description: "Optional provider for a new send.",
      },
      model: {
        type: "string",
        description: "Optional model or provider/model spec for send (for example gpt-5.6-terra or deepseek/pro).",
      },
      mode: {
        type: "string",
        enum: ["auto", "detach", "wait"],
        description: "send lifecycle. auto (default) detaches sends to other/new conversations and queues a send to the active parent; detach starts and returns; wait returns the completed child result. Sends to an already-streaming conversation are queued for its next turn regardless of mode.",
      },
      notify_parent: {
        type: "boolean",
        description: "For detached send, notify the active parent on completion. Defaults to true.",
      },
      full: {
        type: "boolean",
        description: "Include thinking and tool-result details in send wait output or history. Defaults to false.",
      },
      timing: {
        type: "string",
        enum: ["next-turn", "message-end"],
        description: "Queue delivery timing for action=queue. Defaults to next-turn.",
      },
      command: {
        type: "string",
        description: "For action=commands: omit or use ls to discover available commands, help to inspect one, or a discovered command name to execute it. Command names are intentionally not enumerated in this schema.",
      },
      args: {
        type: "object",
        description: "Structured command-specific arguments for action=commands. Discover their shape with command=help and args.command=<name>.",
        additionalProperties: true,
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parallelSafety: "exclusive",
  // Waiting on a subagent or one-shot LLM is independently cancellable and
  // must not inherit the generic two-minute tool deadline.
  defaultTimeoutMs: null,
  watchdogExempt: true,
  display: { label: "Exocortex", color: "#1d9bf0" },
  summarize(input) {
    const action = actionFromInput(input);
    if (!action) return { label: "Exocortex", detail: "invalid action" };
    const detailKey = action === "send" || action === "queue"
      ? "text"
      : action === "commands"
          ? "command"
          : "conversation_id";
    const detail = detailValue(input, detailKey);
    const primary = detail ? `${action}: ${detail}` : action;
    return { label: "Exocortex", detail: summarizeExoParams(primary, input, ["action", detailKey]) };
  },
  async execute(input, context, signal) {
    if (!context?.exocortex) {
      return { output: "The native Exocortex runtime is unavailable in this tool context.", isError: true };
    }
    return await context.exocortex.execute(input, context.conversationId, signal, context.subagentMaxDepth);
  },
};
