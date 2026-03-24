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
import { clearPendingAI } from "./state";
import { clearPrompt } from "./promptline";
import { DEFAULT_EFFORT, EFFORT_LEVELS, type ModelId, type EffortLevel } from "./messages";
import { convDisplayName } from "./messages";
import { copyToClipboard } from "./vim/clipboard";
import { PENDING_TITLE } from "./titlegen";
import { getMarkPrefix, getMarkFromTitle } from "./marks";
import { theme, themes, THEME_NAMES, setTheme } from "./theme";

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
  | { type: "effort_changed"; effort: EffortLevel }
  | { type: "rename_conversation"; title: string }
  | { type: "generate_title" }
  | { type: "login" }
  | { type: "logout" }
  | { type: "theme_changed" }
  | { type: "get_system_prompt" }
  | { type: "get_system_instructions" }
  | { type: "set_system_instructions"; instructions: string }
  | { type: "clear_system_instructions" };

export interface SlashCommand {
  name: string;
  description: string;
  args?: CompletionItem[];
  handler: (text: string, state: RenderState) => CommandResult;
}

// ── Command definitions ─────────────────────────────────────────────

const MODELS: ModelId[] = ["sonnet", "haiku", "opus"];

/** Build a human-readable info string for the current conversation. */
function formatConvoInfo(state: RenderState): string | null {
  if (!state.convId) return null;

  const conv = state.sidebar.conversations.find(c => c.id === state.convId);
  const title = conv ? convDisplayName(conv, "(untitled)") : "(untitled)";
  const model = conv?.model ?? state.model;
  const msgs = conv?.messageCount ?? state.messages.filter(m => m.role !== "system").length;
  const created = conv ? new Date(conv.createdAt).toLocaleString() : "unknown";
  const updated = conv ? new Date(conv.updatedAt).toLocaleString() : "unknown";
  const markLabel = conv ? getMarkFromTitle(conv.title)?.label ?? null : null;
  const flags = [
    conv?.pinned && "pinned",
    conv?.marked && "starred",
    markLabel,
  ].filter(Boolean).join(", ");

  const lines = [
    `Title:    ${title}`,
    `ID:       ${state.convId}`,
    `Model:    ${model}`,
    `Effort:   ${state.effort}`,
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
      clearPendingAI(state);
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
      if (!state.convId) {
        state.messages.push({ role: "system", text: "No active conversation to rename.", metadata: null });
        clearPrompt(state);
        return { type: "handled" };
      }
      const rawTitle = text.slice("/rename".length).trim();
      if (!rawTitle) {
        // Auto-generate: set placeholder and request LLM-generated title
        const conv = state.sidebar.conversations.find(c => c.id === state.convId);
        if (conv) conv.title = PENDING_TITLE;
        clearPrompt(state);
        return { type: "generate_title" };
      }
      // Preserve any existing emoji mark prefix
      const conv = state.sidebar.conversations.find(c => c.id === state.convId);
      const markPrefix = conv ? getMarkPrefix(conv.title) : null;
      const title = markPrefix ? markPrefix + " " + rawTitle : rawTitle;
      // Optimistic update: immediately reflect in sidebar
      if (conv) conv.title = title;
      clearPrompt(state);
      return { type: "rename_conversation", title };
    },
  },
  {
    name: "/model",
    description: "Set or show the current model",
    args: [
      { name: "sonnet", desc: "Claude Sonnet 4" },
      { name: "haiku", desc: "Claude Haiku 4" },
      { name: "opus", desc: "Claude Opus 4" },
    ],
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
    name: "/effort",
    description: "Set or show reasoning effort level",
    args: EFFORT_LEVELS.map(e => ({ name: e, desc: e === DEFAULT_EFFORT ? `${e} (default)` : e })),
    handler: (text, state) => {
      const parts = text.split(/\s+/);
      const arg = parts[1];
      if (arg && EFFORT_LEVELS.includes(arg as EffortLevel)) {
        const effort = arg as EffortLevel;
        state.effort = effort;
        state.messages.push({ role: "system", text: `Effort set to ${effort}`, metadata: null });
        clearPrompt(state);
        return { type: "effort_changed", effort };
      } else {
        state.messages.push({ role: "system", text: `Current: ${state.effort}. Available: ${EFFORT_LEVELS.join(", ")}`, metadata: null });
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
  {
    name: "/theme",
    description: "Set or show the current theme",
    args: THEME_NAMES.map(n => ({ name: n, desc: n === theme.name ? `${n} (active)` : n })),
    handler: (text, state) => {
      const parts = text.split(/\s+/);
      const arg = parts[1];
      if (arg && arg in themes) {
        if (arg === theme.name) {
          state.messages.push({ role: "system", text: `Theme is already ${arg}`, metadata: null });
          clearPrompt(state);
          return { type: "handled" };
        }
        setTheme(arg);
        state.messages.push({ role: "system", text: `Theme set to ${arg}`, metadata: null });
        clearPrompt(state);
        return { type: "theme_changed" };
      } else {
        state.messages.push({ role: "system", text: `Current: ${theme.name}. Available: ${THEME_NAMES.join(", ")}`, metadata: null });
      }
      clearPrompt(state);
      return { type: "handled" };
    },
  },
  {
    name: "/system",
    description: "Show the current system prompt",
    handler: (_text, state) => {
      clearPrompt(state);
      return { type: "get_system_prompt" };
    },
  },
  {
    name: "/instructions",
    description: "View, set, or clear per-conversation system instructions",
    args: [
      { name: "clear", desc: "Remove custom instructions" },
    ],
    handler: (text, state) => {
      if (!state.convId) {
        state.messages.push({ role: "system", text: "No active conversation.", metadata: null });
        clearPrompt(state);
        return { type: "handled" };
      }
      const arg = text.slice("/instructions".length).trim();
      if (!arg) {
        clearPrompt(state);
        return { type: "get_system_instructions" };
      }
      if (arg === "clear") {
        state.messages.push({ role: "system", text: "System instructions cleared.", metadata: null });
        clearPrompt(state);
        return { type: "clear_system_instructions" };
      }
      // Everything after the command name is the instructions text
      state.messages.push({ role: "system", text: "System instructions updated.", metadata: null });
      clearPrompt(state);
      return { type: "set_system_instructions", instructions: arg };
    },
  },
  {
    name: "/login",
    description: "Authenticate with Anthropic",
    handler: (_text, state) => {
      clearPrompt(state);
      return { type: "login" };
    },
  },
  {
    name: "/logout",
    description: "Log out and clear credentials",
    handler: (_text, state) => {
      clearPrompt(state);
      return { type: "logout" };
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

// ── Derived completion data ────────────────────────────────────────

/** Command names shown in the autocomplete popup. */
export const COMMAND_LIST: CompletionItem[] = commands
  .filter(c => c.name !== "/exit")   // /exit is an alias — only show /quit
  .map(c => ({ name: c.name, desc: c.description }));

/** All command argument lists, keyed by command name. Used by autocomplete and prompt highlighting. */
export const COMMAND_ARGS: Record<string, CompletionItem[]> = Object.fromEntries(
  commands.filter(c => c.args && c.args.length > 0).map(c => [c.name, c.args!]),
);
