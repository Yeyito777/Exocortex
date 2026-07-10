import { MAX_EXO_SUBAGENT_DEPTH } from "../messages";
import type { Tool } from "./types";

export const EXO_ACTIONS = [
  "send",
  "list",
  "jobs",
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
  "Use subagents only when parallel work would materially improve speed or quality; otherwise, do not use them.",
  "Set max_depth=0 unless a subagent clearly needs to delegate further.",
  "Subagents start in the daemon's working directory, so include the target absolute directory in tasks when relevant.",
].join("\n");

export const exo: Tool = {
  name: "exo",
  description: "Manage the current Exocortex daemon directly. Frequent conversation and subagent operations are direct actions. Use action=commands to discover lower-frequency management commands on demand. Transcription and cross-instance targeting are intentionally excluded.",
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
        description: "Conversation targeted by send, info, history, abort, or queue. Omit for send to create a new subagent.",
      },
      max_depth: {
        type: "integer",
        minimum: 0,
        maximum: MAX_EXO_SUBAGENT_DEPTH,
        description: `Required for send and queue. Maximum number of additional subagent generations permitted (0-${MAX_EXO_SUBAGENT_DEPTH}), not a target. Use 0 unless the target clearly needs to delegate; a spawned caller may set at most its own max_depth minus one.`,
      },
      query: {
        type: "string",
        description: "Optional case-insensitive ID/title/provider/model filter for list or jobs.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Maximum results for list, jobs, or history. Defaults to 25 for list/jobs and 50 for history; list/jobs cap at 100 and history at 200.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Pagination offset for list/jobs, or number of newest entries to skip for history. Defaults to 0.",
      },
      scope: {
        type: "string",
        enum: ["children", "all"],
        description: "For jobs/list, restrict to subagents spawned by the active conversation or include all conversations. Jobs defaults to children; list defaults to all.",
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
        description: "send lifecycle. auto (default) detaches sends to other/new conversations and queues a send to the active parent; detach starts and returns; wait returns the completed child result.",
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
