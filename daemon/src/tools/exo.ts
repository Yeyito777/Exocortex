import { EFFORT_LEVELS } from "@exocortex/shared/messages";
import { repoRoot } from "@exocortex/shared/paths";
import type { Tool } from "./types";

export const exo: Tool = {
  name: "exo",
  description: "Start a subagent, abort a conversation, or restart the daemon.",
  systemHint: [
    "Subagents are the default for real work: building, fixing, or researching that takes more than a few minutes, and anything that should survive daemon restarts, model changes, or network outages, that the user may open or continue in the TUI, that should report back to you, or that commits to a repo. Do trivial or quick work yourself. Never bypass a user's prohibition.",
    "Children have their own workspace and the same tools; include the absolute target directory and context. Subagents cannot delegate further; as one, do the work yourself. Completion notifies you unless detach:true.",
    "Model: from a Claude conversation the default is opus at high effort (sonnet for lighter work); otherwise sol fast, or astra for substantial implementation, architecture, or correctness-sensitive work. Either family works from any conversation whose provider is signed in.",
    "restart gracefully restarts this daemon (e.g. to deploy merged daemon changes) once your current turn ends; use it instead of running exocortexd restart from a turn. Other active conversations are interrupted and replayed; yours is not, and gets a notice after boot. Refused within 5 minutes of daemon start or while a restart is pending; aborting your turn cancels it.",
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
          model: { type: "string", description: "sol fast, astra, opus, sonnet, or an exact Claude catalog id such as claude-opus-5-5. Default: opus from a Claude conversation, otherwise sol fast." },
          effort: { type: "string", enum: [...EFFORT_LEVELS], description: "Reasoning effort; must be supported by the model. Default: high for Claude, otherwise the model's default." },
        },
        additionalProperties: false,
      },
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
    const action = input.subagent !== undefined ? "subagent" : input.restart !== undefined ? "restart" : "abort";
    const value = input[action];
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    return { label: "Exocortex", detail: `${action}: ${text.slice(0, 100)}` };
  },
  async execute(input, context, signal) {
    if (!context?.exocortex) {
      return { output: "The native Exocortex runtime is unavailable in this tool context.", isError: true };
    }
    return context.exocortex.execute(input, context.conversationId, signal, context.subagentMaxDepth);
  },
};
