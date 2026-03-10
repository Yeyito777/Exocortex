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
import { copyToClipboard } from "./vim/clipboard";

// ── Types ───────────────────────────────────────────────────────────

export interface CompletionItem {
  name: string;
  desc: string;
}

export type CommandResult =
  | { type: "handled" }
  | { type: "quit" }
  | { type: "new_conversation" }
  | { type: "model_changed"; model: ModelId }
  | { type: "rename_conversation"; title: string };

export interface SlashCommand {
  name: string;
  description: string;
  handler: (text: string, state: RenderState) => CommandResult;
}

// ── Command definitions ─────────────────────────────────────────────

const MODELS: ModelId[] = ["sonnet", "haiku", "opus"];

/** Build a human-readable info string for the current conversation. */
function formatConvoInfo(state: RenderState): string | null {
  if (!state.convId) return null;

  const conv = state.sidebar.conversations.find(c => c.id === state.convId);
  const title = conv?.title || conv?.preview || "(untitled)";
  const model = conv?.model ?? state.model;
  const msgs = conv?.messageCount ?? state.messages.filter(m => m.role !== "system").length;
  const created = conv ? new Date(conv.createdAt).toLocaleString() : "unknown";
  const updated = conv ? new Date(conv.updatedAt).toLocaleString() : "unknown";
  const flags = [
    conv?.pinned && "pinned",
    conv?.marked && "marked",
  ].filter(Boolean).join(", ");

  const lines = [
    `Title:    ${title}`,
    `ID:       ${state.convId}`,
    `Model:    ${model}`,
    `Messages: ${msgs}`,
    `Created:  ${created}`,
    `Updated:  ${updated}`,
  ];
  if (flags) lines.push(`Flags:    ${flags}`);

  return lines.join("\n");
}

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
    name: "/rename",
    description: "Rename the current conversation",
    handler: (text, state) => {
      const title = text.slice("/rename".length).trim();
      if (!title) {
        state.messages.push({ role: "system", text: "Usage: /rename <title>", metadata: null });
        clearPrompt(state);
        return { type: "handled" };
      }
      if (!state.convId) {
        state.messages.push({ role: "system", text: "No active conversation to rename.", metadata: null });
        clearPrompt(state);
        return { type: "handled" };
      }
      // Optimistic update: immediately reflect in sidebar
      const conv = state.sidebar.conversations.find(c => c.id === state.convId);
      if (conv) conv.title = title;
      clearPrompt(state);
      return { type: "rename_conversation", title };
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
  {
    name: "/convo",
    description: "Copy conversation info to clipboard",
    handler: (_text, state) => {
      if (!state.convId) {
        state.messages.push({ role: "system", text: "No active conversation.", metadata: null });
        clearPrompt(state);
        return { type: "handled" };
      }

      const info = formatConvoInfo(state);
      if (!info) {
        state.messages.push({ role: "system", text: "No active conversation.", metadata: null });
        clearPrompt(state);
        return { type: "handled" };
      }

      copyToClipboard(info);
      state.messages.push({ role: "system", text: "Conversation info copied to clipboard.", metadata: null });
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

/** All command argument lists, keyed by command name. Used by autocomplete and prompt highlighting. */
export const COMMAND_ARGS: Record<string, CompletionItem[]> = {
  "/model": MODEL_ARGS,
};
