import type { Tool } from "./types";

export const EXO_ACTIONS = [
  "send",
  "list",
  "jobs",
  "info",
  "history",
  "delete",
  "abort",
  "queue",
  "rename",
  "status",
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

const EXO_SYSTEM_HINT = [
  "Use the native `exo` tool to manage the current Exocortex daemon and spawn or control subagents.",
  "For a new subagent, call action=send with text; it detaches by default and this conversation is notified on completion.",
  "Use action=history, jobs, info, queue, abort, or another send to inspect and control child conversations.",
  "For less-common management operations, call action=commands with command=ls to discover the daemon-owned command registry, then command=help with args.command to inspect one command.",
  "Use the external `exo` CLI through bash only when debugging or targeting another daemon instance (for example with --instance).",
  "Subagents use Exocortex's daemon working directory, so include the target absolute working directory in the task text when relevant.",
].join("\n");

export const exo: Tool = {
  name: "exo",
  description: "Manage the current Exocortex daemon directly. High-frequency conversation and subagent operations are top-level. Use action=commands with command=ls to discover lower-frequency management commands on demand. Transcription and cross-instance targeting are intentionally excluded.",
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
        description: "Conversation targeted by send, info, history, delete, abort, queue, or rename. Omit for send to create a new subagent.",
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
      title: {
        type: "string",
        description: "New title for action=rename.",
      },
      command: {
        type: "string",
        description: "For action=commands: use ls to discover available commands, help to inspect one, or a discovered command name to execute it. Command names are intentionally not enumerated in this schema.",
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
    const detail = action === "send" || action === "queue"
      ? detailValue(input, "text")
      : action === "rename"
        ? [detailValue(input, "conversation_id"), detailValue(input, "title")].filter(Boolean).join(" → ")
        : action === "commands"
          ? detailValue(input, "command")
          : detailValue(input, "conversation_id");
    const compact = detail && detail.length > 180 ? `${detail.slice(0, 177)}…` : detail;
    return { label: "Exocortex", detail: compact ? `${action}: ${compact}` : action };
  },
  async execute(input, context, signal) {
    if (!context?.exocortex) {
      return { output: "The native Exocortex runtime is unavailable in this tool context.", isError: true };
    }
    return await context.exocortex.execute(input, context.conversationId, signal);
  },
};
