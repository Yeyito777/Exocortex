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
import { DEFAULT_EFFORT, EFFORT_LEVELS, normalizeEffortForModel, type ProviderId, type ModelId, type EffortLevel, type ModelInfo, type ReasoningEffortInfo } from "./messages";
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
  | { type: "get_system_prompt" };

export interface SlashCommand {
  name: string;
  description: string;
  args?: CompletionItem[];
  handler: (text: string, state: RenderState) => CommandResult;
}

// ── Command definitions ─────────────────────────────────────────────

function availableProviders(state: RenderState): ProviderId[] {
  const ids = state.providerRegistry.map((p) => p.id);
  return ids.length > 0 ? ids : ["anthropic", "openai"];
}

function providerInfo(state: RenderState, provider = state.provider) {
  return state.providerRegistry.find((candidate) => candidate.id === provider) ?? null;
}

function providerModels(state: RenderState, provider = state.provider): ModelId[] {
  return providerInfo(state, provider)?.models.map((model) => model.id) ?? [];
}

function modelInfo(state: RenderState, provider = state.provider, model = state.model): ModelInfo | null {
  return providerInfo(state, provider)?.models.find((candidate) => candidate.id === model) ?? null;
}

function defaultModelForProvider(state: RenderState, provider = state.provider): ModelId | null {
  return providerInfo(state, provider)?.defaultModel ?? null;
}

function providerAllowsCustomModels(state: RenderState, provider = state.provider): boolean {
  return providerInfo(state, provider)?.allowsCustomModels ?? false;
}

function providerCompletionItems(state: RenderState): CompletionItem[] {
  return availableProviders(state).map((provider) => ({
    name: provider,
    desc: providerInfo(state, provider)?.label ?? `${provider} models`,
  }));
}

function providerModelItems(state: RenderState, provider = state.provider): CompletionItem[] {
  const info = providerInfo(state, provider);
  const models = info?.models ?? [];
  return models.map((model) => ({
    name: model.id,
    desc: model.id === info?.defaultModel ? `${model.label} (default)` : model.label,
  }));
}

function supportedEfforts(state: RenderState, provider = state.provider, model = state.model): ReasoningEffortInfo[] {
  return modelInfo(state, provider, model)?.supportedEfforts ?? EFFORT_LEVELS.map((effort) => ({ effort, description: effort }));
}

function defaultEffortFor(state: RenderState, provider = state.provider, model = state.model): EffortLevel {
  return normalizeEffortForModel(modelInfo(state, provider, model), null);
}

function effortItems(state: RenderState, provider = state.provider, model = state.model): CompletionItem[] {
  const defaultEffort = defaultEffortFor(state, provider, model);
  return supportedEfforts(state, provider, model).map((candidate) => ({
    name: candidate.effort,
    desc: candidate.effort === defaultEffort ? `${candidate.description} (default)` : candidate.description,
  }));
}

function normalizeStateEffort(state: RenderState, provider = state.provider, model = state.model): void {
  state.effort = normalizeEffortForModel(modelInfo(state, provider, model), state.effort);
}

function formatProviderModels(state: RenderState, provider: ProviderId): string {
  const models = providerModels(state, provider);
  if (models.length === 0) return `${provider}: (waiting for daemon)`;
  return `${provider}: ${models.join(", ")}${providerAllowsCustomModels(state, provider) ? " (custom ids allowed)" : ""}`;
}

function formatEffortChoices(candidates: ReasoningEffortInfo[], current: EffortLevel, defaultEffort: EffortLevel): string {
  return candidates
    .map((candidate) => {
      const suffix = [
        candidate.effort === current ? "current" : "",
        candidate.effort === defaultEffort ? "default" : "",
      ].filter(Boolean).join(", ");
      return suffix ? `${candidate.effort} (${suffix})` : candidate.effort;
    })
    .join(", ");
}

/** Build a human-readable info string for the current conversation. */
function formatConvoInfo(state: RenderState): string | null {
  if (!state.convId) return null;

  const conv = state.sidebar.conversations.find(c => c.id === state.convId);
  const title = conv ? convDisplayName(conv, "(untitled)") : "(untitled)";
  const provider = conv?.provider ?? state.provider;
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
    `Provider: ${provider}`,
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
    description: "Set or show the current provider/model",
    args: [
      { name: "anthropic", desc: "Anthropic models" },
      { name: "openai", desc: "OpenAI models" },
    ],
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      const providers = availableProviders(state);

      if (parts.length === 1) {
        state.messages.push({
          role: "system",
          text: `Current: ${state.provider}/${state.model}\nAvailable:\n${providers.map((provider) => formatProviderModels(state, provider)).join("\n")}\nUsage: /model <provider> <model>`,
          metadata: null,
        });
        clearPrompt(state);
        return { type: "handled" };
      }

      const provider = parts[1] as ProviderId;
      if (!providers.includes(provider)) {
        state.messages.push({
          role: "system",
          text: `Unknown provider: ${parts[1]}. Available: ${providers.join(", ")}`,
          metadata: null,
        });
        clearPrompt(state);
        return { type: "handled" };
      }

      if (parts.length === 2) {
        const currentModel = provider === state.provider ? state.model : defaultModelForProvider(state, provider) ?? "(unknown)";
        const efforts = effortItems(state, provider, currentModel);
        state.messages.push({
          role: "system",
          text: `Current: ${currentModel}\nAvailable: ${providerModels(state, provider).join(", ") || "(waiting for daemon)"}\nEffort: ${efforts.map((item) => item.name).join(", ") || DEFAULT_EFFORT}${providerAllowsCustomModels(state, provider) ? "\nThis provider also accepts custom model ids." : ""}`,
          metadata: null,
        });
        clearPrompt(state);
        return { type: "handled" };
      }

      const model = parts[2] as ModelId;
      if (state.convId && provider !== state.provider) {
        state.messages.push({ role: "system", text: "Provider is locked for the active conversation. Start a new conversation to switch providers.", metadata: null });
        clearPrompt(state);
        return { type: "handled" };
      }

      state.provider = provider;
      state.model = model;
      const previousEffort = state.effort;
      normalizeStateEffort(state, provider, model);
      const effortSuffix = state.effort !== previousEffort ? ` (effort ${state.effort})` : "";
      state.messages.push({ role: "system", text: `Model set to ${state.provider}/${state.model}${effortSuffix}`, metadata: null });
      clearPrompt(state);
      return state.convId ? { type: "model_changed", model } : { type: "handled" };
    },
  },
  {
    name: "/effort",
    description: "Set or show reasoning effort level",
    handler: (text, state) => {
      const parts = text.split(/\s+/);
      const arg = parts[1];
      const supported = supportedEfforts(state);
      const supportedLevels = supported.map((candidate) => candidate.effort);
      const defaultEffort = defaultEffortFor(state);
      if (arg && supportedLevels.includes(arg as EffortLevel)) {
        const effort = arg as EffortLevel;
        state.effort = effort;
        state.messages.push({ role: "system", text: `Effort set to ${effort}`, metadata: null });
        clearPrompt(state);
        return { type: "effort_changed", effort };
      } else {
        const detail = supported
          .map((candidate) => `${candidate.effort}: ${candidate.description}`)
          .join("\n");
        state.messages.push({
          role: "system",
          text: `Current: ${state.effort}. Available: ${formatEffortChoices(supported, state.effort, defaultEffort)}${detail ? `\n${detail}` : ""}`,
          metadata: null,
        });
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
    name: "/login",
    description: "Authenticate with the current provider",
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
const STATIC_COMMAND_ARGS: Record<string, CompletionItem[]> = Object.fromEntries(
  commands
    .filter((command) => command.name !== "/model" && command.args && command.args.length > 0)
    .map((command) => [command.name, command.args!]),
);

export function getCommandArgs(state: RenderState): Record<string, CompletionItem[]> {
  const registry: Record<string, CompletionItem[]> = { ...STATIC_COMMAND_ARGS };
  registry["/model"] = providerCompletionItems(state);
  for (const provider of availableProviders(state)) {
    registry[`/model ${provider}`] = providerModelItems(state, provider);
  }
  registry["/effort"] = effortItems(state);
  return registry;
}
