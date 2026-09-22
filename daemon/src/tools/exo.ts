import { EFFORT_LEVELS, MAX_EXO_SUBAGENT_DEPTH } from "../messages";
import type { Tool } from "./types";

export const EXO_ACTIONS = ["send", "list", "tasks", "read", "stop", "commands"] as const;
export type ExoAction = typeof EXO_ACTIONS[number];

const string = (description: string) => ({ type: "string", description });
const boolean = (description: string) => ({ type: "boolean", description });
const choice = (values: string[], description: string) => ({ type: "string", enum: values, description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const conversation_id = string("Exact conversation ID.");
const task_id = string("Exact active task ID from tasks.");
const text = string("Task or message text.");
const title = string("Short title for a new subagent (at most 6 words / 60 characters).");
const model = string("Optional exact model ID or provider/model. Omit for configured default; commands/models lists choices.");
const allow_edits = boolean("For a new subagent: enable shell and file edits. Default false; not a sandbox.");
const mode = choice(["auto", "detach", "wait"], "Default auto: starts and notifies on completion. wait returns the result. Busy targets queue for next turn.");
const max_depth = { type: "integer", minimum: 0, maximum: MAX_EXO_SUBAGENT_DEPTH, description: "Additional delegation generations. Defaults to 0; cannot exceed caller's remaining depth minus one." };
const page = {
  limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size; list/tasks cap at 100, read at 200." },
  offset: { type: "integer", minimum: 0, description: "Page offset; for history, skip this many newest entries." },
};
const listing = {
  ...page,
  query: string("Case-insensitive filter."),
  scope: choice(["children", "all"], "list defaults all; tasks/jobs default children (own work)."),
};
const send = {
  text, title, conversation_id, model, allow_edits, mode, max_depth,
  provider: choice(["openai", "deepseek", "opencode", "openrouter"], "Provider override."),
  effort: choice([...EFFORT_LEVELS], "Reasoning effort; defaults medium, normalized for the model."),
  internal_tools: strings("Exact internal tools. Defaults research tools; cannot combine with allow_edits. For existing targets both tool lists are required and persistently replace policy; self must retain exo."),
  external_tools: strings("Exact external CLI tools; defaults none. Enables shell; tool selection is not a sandbox."),
  notify_parent: boolean("Notify on detached completion; defaults true."),
  full: boolean("Include thinking/tool results in wait output; defaults false."),
};

/** Full argument reference, returned on demand rather than injected every turn. */
export const EXO_OPERATION_SCHEMAS: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries({
    send,
    list: listing,
    tasks: { ...listing, conversation_id, kind: choice(["all", "subagent", "background", "chrono"], "Active task kind; defaults all.") },
    read: { conversation_id, task_id, ...page, full: boolean("Include thinking and tool results."), view: choice(["history", "info"], "Conversation view; defaults history.") },
    stop: { conversation_id, task_id },
    jobs: listing,
    queue: { conversation_id, text, max_depth, timing: choice(["next-turn", "message-end"], "Defaults next-turn.") },
  }).map(([name, properties]) => [name, { type: "object", properties, additionalProperties: false }]),
);

function brief(value: unknown, max = 100): string {
  const line = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const exo: Tool = {
  name: "exo",
  description: "Delegate and manage work in this daemon: send, list conversations, tasks, read results, stop work. Advanced administration and option reference are under commands.",
  systemHint: [
    "Delegate only when requested, needed for testing, or exceptionally useful in parallel. Start with exo {action:'send', title:'Short task title', text:'Task and context'}; add allow_edits:true for coding. Depth defaults to 0. Results notify you automatically.",
    "Subagents start in their own isolated conversation workspace; include the target absolute directory and necessary context. Tool selection is not a sandbox.",
    "Omit model for the configured default, or use commands/models for exact IDs. Use tasks to inspect active work, read for results, stop with one exact task_id or conversation_id. Depth-zero agents may only inspect/stop their own tasks.",
    "For advanced options use {action:'commands', command:'help', args:{command:'send'}} (or another action/command). Pass options in args. commands without a command lists administration; notifications manages subscriptions.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      action: choice([...EXO_ACTIONS], "send delegates/messages; list finds conversations; tasks shows active work; read gets history/info; stop cancels one target; commands discovers advanced operations."),
      text,
      title,
      conversation_id: string("send: omit to create a subagent. read: omit for current conversation. stop: exact conversation to abort, never current."),
      task_id: string("read: exact active task ID. stop: exact background-task ID from tasks. Do not combine with conversation_id."),
      model,
      allow_edits,
      mode,
      command: string("For commands: omit to list; help with args.command for reference; models for model IDs; otherwise a discovered command."),
      args: { type: "object", additionalProperties: true, description: "Optional advanced action options or command arguments. Discover with commands/help; ordinary calls need none." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parallelSafety: "exclusive",
  parallelSafetyForInput(input) {
    if (["list", "jobs", "tasks", "read", "info", "history"].includes(String(input.action))) return "safe";
    if (input.action !== "commands") return "exclusive";
    const command = String(input.command ?? "ls").toLowerCase();
    if (["ls", "list", "help", "models", "jobs", "status", "stats"].includes(command)) return "safe";
    const args = input.args as Record<string, unknown> | undefined;
    const operation = args?.operation;
    if ((command === "task" && operation === "info")
      || (command === "folder" && ["ls", "tree"].includes(String(operation)))
      || (["tools", "instructions"].includes(command) && operation === "get")
      || (command === "notifications" && ["sources", "list"].includes(String(operation)))) return "safe";
    return "exclusive";
  },
  defaultTimeoutMs: null,
  watchdogExempt: true,
  display: { label: "Exocortex", color: "#1d9bf0" },
  summarize(input) {
    const args = input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : {};
    const action = brief(input.action, 20) || "invalid action";
    const target = action === "send" || action === "queue"
      ? brief(input.title ?? args.title ?? input.text ?? args.text)
      : action === "commands"
        ? brief(input.command ?? "list")
        : brief(input.task_id ?? args.task_id ?? input.conversation_id ?? args.conversation_id);
    return { label: "Exocortex", detail: target ? `${action}: ${target}` : action };
  },
  async execute(input, context, signal) {
    if (!context?.exocortex) {
      return { output: "The native Exocortex runtime is unavailable in this tool context.", isError: true };
    }
    return await context.exocortex.execute(input, context.conversationId, signal, context.subagentMaxDepth);
  },
};
