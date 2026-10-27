import { EFFORT_LEVELS, exoCallDetail } from "@exocortex/shared/messages";
import type { Tool } from "./types";
import { toolTextSource } from "./tool-text";

const TEXT = toolTextSource("exo");

export const exo: Tool = {
  name: "exo",
  get description() { return TEXT.description(); },
  get systemHint() { return TEXT.hint(); },
  inputSchema: {
    type: "object",
    properties: {
      subagent: { type: "string", description: "Task prompt; include the target absolute directory and necessary context." },
      args: {
        type: "object",
        properties: {
          detach: { type: "boolean", description: "Do not notify the parent on completion. Default false." },
          model: { type: "string", description: "sol fast, astra, opus, sonnet, or an exact Claude catalog id such as claude-opus-5-5. Default: opus from a Claude conversation, otherwise sol fast." },
          effort: { type: "string", enum: [...EFFORT_LEVELS], description: "Reasoning effort; must be supported by the model. Default: high for Claude, otherwise the model's default." },
        },
        additionalProperties: false,
      },
      message: {
        type: "object",
        properties: {
          conversation: { type: "string", description: "Exact conversation ID: your child, or your parent if you are a subagent; never the current conversation." },
          text: { type: "string", description: "Message, delivered as a prompt from you." },
          delivery: { type: "string", enum: ["now", "after_turn"], description: "now (default): join an active turn at its next tool boundary. after_turn: start a new turn once the active one ends. Either starts a turn on an idle conversation." },
        },
        required: ["conversation", "text"],
        additionalProperties: false,
      },
      status: { type: "string", description: "Exact conversation ID to inspect, read-only." },
      abort: { type: "string", description: "Exact conversation ID to abort; never the current conversation." },
      restart: { type: "string", description: "Restart the daemon after this turn ends. Value: short reason (may be empty)." },
    },
    additionalProperties: false,
  },
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  watchdogExempt: true,
  display: { label: "Exocortex", color: "#1d9bf0" },
  summarize(input) {
    return { label: "Exocortex", detail: exoCallDetail(input) };
  },
  async execute(input, context, signal) {
    if (!context?.exocortex) {
      return { output: "The native Exocortex runtime is unavailable in this tool context.", isError: true };
    }
    return context.exocortex.execute(input, context.conversationId, signal, context.subagentMaxDepth);
  },
};
