import { repoRoot } from "@exocortex/shared/paths";
import type { Tool } from "./types";

export const EXO_MODELS = ["sol fast", "astra"] as const;

export const exo: Tool = {
  name: "exo",
  description: "Start a subagent or abort a conversation.",
  systemHint: [
    "Almost never use subagents: do implementation, research, review, and testing yourself; size, parallelism, and end-to-end testing are not reasons to delegate. Delegate only on explicit request or for a rare compelling benefit unavailable by working yourself. Never bypass a user's prohibition.",
    "Children have their own workspace and the same tools; include the absolute target directory and context. They cannot delegate further. Default: sol fast; use Astra for substantial implementation, architecture, or correctness-sensitive work. Completion notifies you unless detach:true.",
    `For administration (inspect/create conversations, history, tasks, folders), send commands directly to this daemon; read ${repoRoot()}/docs/daemon-ipc.md and ${repoRoot()}/shared/src/protocol.ts first.`,
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      subagent: { type: "string", description: "Task prompt; include the target absolute directory and necessary context." },
      args: {
        type: "object",
        properties: {
          detach: { type: "boolean", description: "Do not notify the parent on completion. Default false." },
          model: { type: "string", enum: [...EXO_MODELS], description: "Default sol fast. Only sol fast or astra." },
        },
        additionalProperties: false,
      },
      abort: { type: "string", description: "Exact conversation ID to abort; never the current conversation." },
    },
    additionalProperties: false,
  },
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  watchdogExempt: true,
  display: { label: "Exocortex", color: "#1d9bf0" },
  summarize(input) {
    const value = input.subagent ?? input.abort;
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    return { label: "Exocortex", detail: `${input.subagent !== undefined ? "subagent" : "abort"}: ${text.slice(0, 100)}` };
  },
  async execute(input, context, signal) {
    if (!context?.exocortex) {
      return { output: "The native Exocortex runtime is unavailable in this tool context.", isError: true };
    }
    return context.exocortex.execute(input, context.conversationId, signal, context.subagentMaxDepth);
  },
};
