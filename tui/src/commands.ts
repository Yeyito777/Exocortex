/**
 * Slash command registry.
 *
 * Defines all user-facing slash commands. Each command has a name,
 * description, and handler. The handler receives the full input text
 * and state, and returns a result indicating what happened.
 *
 * This is the only file that knows what slash commands exist.
 */

import type { RenderState } from "./state";
import { clearPrompt } from "./promptline";
import type { ModelId } from "./messages";

// ── Types ───────────────────────────────────────────────────────────

export interface CompletionItem {
  name: string;
  desc: string;
}

export type CommandResult =
  | { type: "handled" }
  | { type: "quit" }
  | { type: "new_conversation" }
  | { type: "model_changed"; model: ModelId };

export interface SlashCommand {
  name: string;
  description: string;
  handler: (text: string, state: RenderState) => CommandResult;
}

// ── Command definitions ─────────────────────────────────────────────

const MODELS: ModelId[] = ["sonnet", "haiku", "opus"];

const commands: SlashCommand[] = [
  {
    name: "/help",
    description: "Show available commands",
    handler: (_text, state) => {
      const lines = commands
        .filter(c => c.name !== "/exit")
        .map(c => `${c.name}  ${c.description}`);
      state.messages.push({ role: "system", text: lines.join("\n"), metadata: null });
      clearPrompt(state);
      return { type: "handled" };
    },
  },
  {
    name: "/quit",
    description: "Exit Exocortex",
    handler: () => ({ type: "quit" }),
  },
  {
    name: "/exit",
    description: "Exit Exocortex",
    handler: () => ({ type: "quit" }),
  },
  {
    name: "/new",
    description: "Start a new conversation",
    handler: (_text, state) => {
      state.messages = [];
      state.pendingAI = null;
      clearPrompt(state);
      state.scrollOffset = 0;
      state.contextTokens = null;
      // Return new_conversation so main.ts can unsubscribe + clear convId
      return { type: "new_conversation" };
    },
  },
  {
    name: "/model",
    description: "Set or show the current model",
    handler: (text, state) => {
      const parts = text.split(/\s+/);
      const arg = parts[1];
      if (arg && MODELS.includes(arg as ModelId)) {
        state.model = arg as ModelId;
        state.messages.push({ role: "system", text: `Model set to ${state.model}`, metadata: null });
        clearPrompt(state);
        return { type: "model_changed", model: arg as ModelId };
      } else {
        state.messages.push({ role: "system", text: `Current: ${state.model}. Available: ${MODELS.join(", ")}`, metadata: null });
      }
      clearPrompt(state);
      return { type: "handled" };
    },
  },
];

// ── Lookup ──────────────────────────────────────────────────────────

/**
 * Try to match and execute a slash command.
 * Returns the command result, or null if the input is not a command.
 */
export function tryCommand(text: string, state: RenderState): CommandResult | null {
  if (!text.startsWith("/")) return null;

  const name = text.split(/\s+/)[0];
  const cmd = commands.find(c => c.name === name);
  if (!cmd) return null;

  return cmd.handler(text, state);
}

// ── Completion data ────────────────────────────────────────────────

/** Command names shown in the autocomplete popup. */
export const COMMAND_LIST: CompletionItem[] = commands
  .filter(c => c.name !== "/exit")   // /exit is an alias — only show /quit
  .map(c => ({ name: c.name, desc: c.description }));

/** Model arguments for /model completion. */
export const MODEL_ARGS: CompletionItem[] = [
  { name: "sonnet", desc: "Claude Sonnet 4" },
  { name: "haiku", desc: "Claude Haiku 4" },
  { name: "opus", desc: "Claude Opus 4" },
];
