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
import { clearPendingAI, clearSystemMessageBuffer, isStreaming, pushSystemMessage } from "./state";
import type { TrimMode } from "./protocol";
import { clearPrompt } from "./promptstate";
import {
  DEFAULT_EFFORT,
  DEFAULT_PROVIDER_ORDER,
  normalizeEffortForModel,
  EFFORT_LEVELS,
  type ProviderId,
  type ModelId,
  type EffortLevel,
  type ModelInfo,
  type ReasoningEffortInfo,
} from "./messages";
import { convDisplayName } from "./messages";
import { copyToClipboard } from "./vim/clipboard";
import { getMarkPrefix, getMarkFromTitle } from "./marks";
import { theme, themes, THEME_NAMES, setTheme } from "./theme";
import { buildLoginInfoMessage } from "./logininfo";
import { availableProviders, setChosenProvider } from "./providerselection";

// ── Types ───────────────────────────────────────────────────────────

export interface CompletionItem {
  name: string;
  desc: string;
}

interface ProviderCommandParseSuccess {
  ok: true;
  provider?: ProviderId;
  providers: ProviderId[];
}

interface ProviderCommandParseFailure {
  ok: false;
  result: CommandResult;
}

type ProviderCommandParseResult = ProviderCommandParseSuccess | ProviderCommandParseFailure;

export type CommandResult =
  | { type: "handled" }
  | { type: "quit" }
  | { type: "new_conversation" }
  | { type: "create_conversation_for_instructions"; text: string }
  | { type: "model_changed"; provider: ProviderId; model: ModelId }
  | { type: "trim_requested"; mode: TrimMode; count: number }
  | { type: "effort_changed"; effort: EffortLevel }
  | { type: "fast_mode_changed"; enabled: boolean }
  | { type: "rename_conversation"; title: string }
  | { type: "generate_title" }
  | { type: "login"; provider?: ProviderId }
  | { type: "logout"; provider?: ProviderId }
  | { type: "theme_changed" }
  | { type: "get_system_prompt" }
  | { type: "set_system_instructions"; text: string };

export interface SlashCommand {
  name: string;
  description: string;
  args?: CompletionItem[];
  handler: (text: string, state: RenderState) => CommandResult;
}

// ── Command definitions ─────────────────────────────────────────────

function showNoSystemInstructions(state: RenderState): CommandResult {
  pushSystemMessage(state, "No system instructions set for this conversation.");
  clearPrompt(state);
  return { type: "handled" };
}

function providerInfo(state: RenderState, provider = state.provider) {
  return state.providerRegistry.find((candidate) => candidate.id === provider) ?? null;
}

function providerModels(state: RenderState, provider = state.provider): ModelId[] {
  return providerInfo(state, provider)?.models.map((model) => model.id) ?? [];
}

function showLoginInfo(state: RenderState): CommandResult {
  pushSystemMessage(state, buildLoginInfoMessage(state));
  clearPrompt(state);
  return { type: "handled" };
}

function handleProviderCommandError(state: RenderState, message: string): ProviderCommandParseFailure {
  pushSystemMessage(state, message);
  clearPrompt(state);
  return { ok: false, result: { type: "handled" } };
}

function parseOptionalProviderCommand(
  text: string,
  state: RenderState,
  commandName: "/login" | "/logout",
): ProviderCommandParseResult {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const providers = availableProviders(state);

  if (parts.length > 2) {
    return handleProviderCommandError(state, `Usage: ${commandName} [${providers.join("|")}]`);
  }

  const provider = parts[1] as ProviderId | undefined;
  if (provider && !providers.includes(provider)) {
    return handleProviderCommandError(state, `Unknown provider: ${provider}. Available: ${providers.join(", ")}`);
  }

  return { ok: true, provider, providers };
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

function providerSupportsFastMode(state: RenderState, provider = state.provider): boolean {
  return providerInfo(state, provider)?.supportsFastMode ?? false;
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

function maxContextFor(state: RenderState, provider = state.provider, model = state.model): number | null {
  return modelInfo(state, provider, model)?.maxContext ?? null;
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

function buildContextWindowWarning(
  previousContextTokens: number | null,
  provider: ProviderId,
  model: ModelId,
  nextMaxContext: number | null,
): string | null {
  if (previousContextTokens == null || nextMaxContext == null || nextMaxContext <= 0 || previousContextTokens <= nextMaxContext) {
    return null;
  }
  return `Warning: last known context (${previousContextTokens.toLocaleString("en-US")} tokens) exceeds ${provider}/${model}'s max context (${nextMaxContext.toLocaleString("en-US")}). The next turn may fail unless you trim the conversation (for example: /trim thinking 20, /trim toolresult 20, or /trim messages 5) or start a new one.`;
}

function applyProviderModelSelection(state: RenderState, provider: ProviderId, model: ModelId): {
  effortChanged: boolean;
  fastDisabled: boolean;
  contextWarning: string | null;
} {
  const previousEffort = state.effort;
  const previousFastMode = state.fastMode;
  const previousContextTokens = state.contextTokens;
  const nextMaxContext = maxContextFor(state, provider, model);

  setChosenProvider(state, provider);
  state.model = model;
  normalizeStateEffort(state, provider, model);
  if (!providerSupportsFastMode(state, provider)) state.fastMode = false;
  state.contextTokens = null;

  return {
    effortChanged: state.effort !== previousEffort,
    fastDisabled: previousFastMode && !state.fastMode,
    contextWarning: buildContextWindowWarning(previousContextTokens, provider, model, nextMaxContext),
  };
}

const TRIM_MODE_ITEMS: CompletionItem[] = [
  { name: "messages", desc: "Trim oldest history entries first" },
  { name: "thinking", desc: "Strip oldest assistant thinking blocks first" },
  { name: "toolresult", desc: "Strip oldest tool result payloads first" },
];

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function trimHelpText(state: RenderState): string {
  const current = state.contextTokens != null ? state.contextTokens.toLocaleString("en-US") : "unknown";
  const maxContext = maxContextFor(state);
  const maxLabel = maxContext != null ? maxContext.toLocaleString("en-US") : "unknown";
  return [
    `Current context: ${current} / ${maxLabel} tokens`,
    "Usage:",
    "  /trim messages <n>",
    "  /trim thinking <n>",
    "  /trim toolresult <n>",
    "",
    "messages   Removes the oldest history entries first.",
    "thinking   Removes thinking blocks from the oldest assistant turns first.",
    "toolresult Replaces the oldest tool result payloads with placeholders first.",
  ].join("\n");
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
  const msgs = conv?.messageCount ?? state.messages.filter(m => m.role !== "system" && m.role !== "system_instructions").length;
  const created = conv ? new Date(conv.createdAt).toLocaleString() : "unknown";
  const updated = conv ? new Date(conv.updatedAt).toLocaleString() : "unknown";
  const markLabel = conv ? getMarkFromTitle(conv.title)?.label ?? null : null;
  const flags = [
    conv?.pinned && "pinned",
    conv?.marked && "starred",
    conv?.fastMode && "fast",
    markLabel,
  ].filter(Boolean).join(", ");

  const lines = [
    `Title:    ${title}`,
    `ID:       ${state.convId}`,
    `Provider: ${provider}`,
    `Model:    ${model}`,
    `Effort:   ${state.effort}`,
    `Fast:     ${state.fastMode ? "on" : "off"}`,
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
      pushSystemMessage(state, lines.join("\n"));
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
      clearSystemMessageBuffer(state);
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
        pushSystemMessage(state, "No active conversation to rename.");
        clearPrompt(state);
        return { type: "handled" };
      }
      const rawTitle = text.slice("/rename".length).trim();
      if (!rawTitle) {
        // Auto-generate title via the title model.
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
    args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
      name: provider,
      desc: provider === "openai" ? "OpenAI models" : "Anthropic models",
    })),
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      const providers = availableProviders(state);

      if (parts.length === 1) {
        pushSystemMessage(state, `Current: ${state.provider}/${state.model}\nAvailable:\n${providers.map((provider) => formatProviderModels(state, provider)).join("\n")}\nUsage: /model <provider> <model>`);
        clearPrompt(state);
        return { type: "handled" };
      }

      if (parts.length > 3) {
        pushSystemMessage(state, "Usage: /model <provider> <model>");
        clearPrompt(state);
        return { type: "handled" };
      }

      const provider = parts[1] as ProviderId;
      if (!providers.includes(provider)) {
        pushSystemMessage(state, `Unknown provider: ${parts[1]}. Available: ${providers.join(", ")}`);
        clearPrompt(state);
        return { type: "handled" };
      }

      if (parts.length === 2) {
        const currentModel = provider === state.provider ? state.model : defaultModelForProvider(state, provider) ?? "(unknown)";
        const efforts = effortItems(state, provider, currentModel);
        pushSystemMessage(state, `Current: ${currentModel}\nAvailable: ${providerModels(state, provider).join(", ") || "(waiting for daemon)"}\nEffort: ${efforts.map((item) => item.name).join(", ") || DEFAULT_EFFORT}${providerAllowsCustomModels(state, provider) ? "\nThis provider also accepts custom model ids." : ""}`);
        clearPrompt(state);
        return { type: "handled" };
      }

      if (state.convId && isStreaming(state)) {
        pushSystemMessage(state, "Cannot switch provider/model while this conversation is streaming.");
        clearPrompt(state);
        return { type: "handled" };
      }

      const model = parts[2] as ModelId;
      const selection = applyProviderModelSelection(state, provider, model);

      const effortSuffix = selection.effortChanged ? ` (effort ${state.effort})` : "";
      const fastSuffix = selection.fastDisabled ? " (fast off)" : "";
      pushSystemMessage(state, `Model set to ${state.provider}/${state.model}${effortSuffix}${fastSuffix}`);

      if (selection.contextWarning) {
        pushSystemMessage(state, selection.contextWarning, "warning");
      }

      clearPrompt(state);
      return state.convId ? { type: "model_changed", provider, model } : { type: "handled" };
    },
  },
  {
    name: "/trim",
    description: "Trim old context from the current conversation",
    args: TRIM_MODE_ITEMS,
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        pushSystemMessage(state, trimHelpText(state));
        clearPrompt(state);
        return { type: "handled" };
      }

      const rawMode = parts[1]?.toLowerCase();
      const mode = rawMode === "messages" || rawMode === "thinking" || rawMode === "toolresult"
        ? rawMode
        : null;

      if (!mode) {
        pushSystemMessage(state, `${trimHelpText(state)}\n\nUnknown trim mode: ${parts[1] ?? ""}`);
        clearPrompt(state);
        return { type: "handled" };
      }

      if (parts.length !== 3) {
        pushSystemMessage(state, trimHelpText(state));
        clearPrompt(state);
        return { type: "handled" };
      }

      if (!state.convId) {
        pushSystemMessage(state, "No active conversation to trim.");
        clearPrompt(state);
        return { type: "handled" };
      }

      if (isStreaming(state)) {
        pushSystemMessage(state, "Cannot trim the conversation while it is streaming.");
        clearPrompt(state);
        return { type: "handled" };
      }

      const count = parsePositiveInt(parts[2]);
      if (count == null) {
        pushSystemMessage(state, `Trim count must be a positive integer.\n\n${trimHelpText(state)}`);
        clearPrompt(state);
        return { type: "handled" };
      }

      clearPrompt(state);
      return { type: "trim_requested", mode, count };
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
        pushSystemMessage(state, `Effort set to ${effort}`);
        clearPrompt(state);
        return { type: "effort_changed", effort };
      } else {
        const detail = supported
          .map((candidate) => `${candidate.effort}: ${candidate.description}`)
          .join("\n");
        pushSystemMessage(state, `Current: ${state.effort}. Available: ${formatEffortChoices(supported, state.effort, defaultEffort)}${detail ? `\n${detail}` : ""}`);
      }
      clearPrompt(state);
      return { type: "handled" };
    },
  },
  {
    name: "/fast",
    description: "Enable or disable OpenAI fast mode",
    args: [
      { name: "on", desc: "Enable fast mode for this conversation" },
      { name: "off", desc: "Disable fast mode for this conversation" },
      { name: "toggle", desc: "Toggle fast mode for this conversation" },
    ],
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      const arg = parts[1]?.toLowerCase();
      const supportsFast = providerSupportsFastMode(state);
      const providerLabel = state.provider;

      if (!arg) {
        const availability = supportsFast
          ? `Fast mode is ${state.fastMode ? "on" : "off"}.`
          : `Fast mode is unavailable for provider ${providerLabel}.`;
        pushSystemMessage(state, availability);
        clearPrompt(state);
        return { type: "handled" };
      }

      if (!["on", "off", "toggle"].includes(arg)) {
        pushSystemMessage(state, "Usage: /fast [on|off|toggle]");
        clearPrompt(state);
        return { type: "handled" };
      }

      if (!supportsFast) {
        pushSystemMessage(state, `Fast mode is only available for ${providerLabel} conversations that support it.`);
        clearPrompt(state);
        return { type: "handled" };
      }

      const enabled = arg === "toggle" ? !state.fastMode : arg === "on";
      if (enabled === state.fastMode) {
        pushSystemMessage(state, `Fast mode already ${enabled ? "on" : "off"}.`);
        clearPrompt(state);
        return { type: "handled" };
      }

      state.fastMode = enabled;
      pushSystemMessage(state, `Fast mode ${enabled ? "enabled" : "disabled"}.`);
      clearPrompt(state);
      return state.convId ? { type: "fast_mode_changed", enabled } : { type: "handled" };
    },
  },
  {
    name: "/convo",
    description: "Copy conversation info to clipboard",
    handler: (_text, state) => {
      if (!state.convId) {
        pushSystemMessage(state, "No active conversation.");
        clearPrompt(state);
        return { type: "handled" };
      }

      const info = formatConvoInfo(state);
      if (!info) {
        pushSystemMessage(state, "No active conversation.");
        clearPrompt(state);
        return { type: "handled" };
      }

      copyToClipboard(info);
      pushSystemMessage(state, "Conversation info copied to clipboard.");
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
          pushSystemMessage(state, `Theme is already ${arg}`);
          clearPrompt(state);
          return { type: "handled" };
        }
        setTheme(arg);
        pushSystemMessage(state, `Theme set to ${arg}`);
        clearPrompt(state);
        return { type: "theme_changed" };
      } else {
        pushSystemMessage(state, `Current: ${theme.name}. Available: ${THEME_NAMES.join(", ")}`);
      }
      clearPrompt(state);
      return { type: "handled" };
    },
  },
  {
    name: "/instructions",
    description: "Set, show, or clear per-conversation system instructions",
    args: [{ name: "clear", desc: "Clear instructions" }],
    handler: (text, state) => {
      const arg = text.slice("/instructions".length);
      const trimmed = arg.trimStart();
      if (!trimmed) {
        if (!state.convId) {
          return showNoSystemInstructions(state);
        }
        // Show current instructions
        const instrMsg = state.messages.find((m): m is import("./messages").SystemInstructionsMessage => m.role === "system_instructions");
        if (instrMsg?.text.trim()) {
          pushSystemMessage(state, `Current instructions:\n${instrMsg.text}`);
          clearPrompt(state);
          return { type: "handled" };
        }
        return showNoSystemInstructions(state);
      }
      if (trimmed === "clear") {
        if (!state.convId) {
          return showNoSystemInstructions(state);
        }
        clearPrompt(state);
        return { type: "set_system_instructions", text: "" };
      }
      if (!state.convId) {
        clearPrompt(state);
        return { type: "create_conversation_for_instructions", text: trimmed };
      }
      clearPrompt(state);
      return { type: "set_system_instructions", text: trimmed };
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
    description: "Show login status or authenticate with a provider",
    args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
      name: provider,
      desc: provider === "openai" ? "Sign in with OpenAI" : "Sign in with Anthropic",
    })),
    handler: (text, state) => {
      const parsed = parseOptionalProviderCommand(text, state, "/login");
      if (!parsed.ok) return parsed.result;

      const { provider } = parsed;
      if (!provider) {
        return showLoginInfo(state);
      }

      if (!state.convId) {
        setChosenProvider(state, provider);
        const nextModel = defaultModelForProvider(state, provider) ?? state.model;
        state.model = nextModel;
        normalizeStateEffort(state, provider, nextModel);
        if (!providerSupportsFastMode(state, provider)) state.fastMode = false;
      }

      clearPrompt(state);
      return { type: "login", provider };
    },
  },
  {
    name: "/logout",
    description: "Log out and clear credentials for a provider",
    args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
      name: provider,
      desc: provider === "openai" ? "Log out from OpenAI" : "Log out from Anthropic",
    })),
    handler: (text, state) => {
      const parsed = parseOptionalProviderCommand(text, state, "/logout");
      if (!parsed.ok) return parsed.result;

      const { provider, providers } = parsed;
      if (!provider) {
        pushSystemMessage(state, `Choose a provider first: ${providers.map((p) => `/logout ${p}`).join(" or ")}`);
        clearPrompt(state);
        return { type: "handled" };
      }

      clearPrompt(state);
      return { type: "logout", provider };
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
  registry["/trim"] = TRIM_MODE_ITEMS;
  registry["/login"] = providerCompletionItems(state);
  registry["/logout"] = providerCompletionItems(state);
  for (const provider of availableProviders(state)) {
    registry[`/model ${provider}`] = providerModelItems(state, provider);
  }
  registry["/effort"] = effortItems(state);
  registry["/fast"] = STATIC_COMMAND_ARGS["/fast"] ?? [];
  return registry;
}
