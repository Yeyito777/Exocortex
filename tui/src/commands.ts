import type { RenderState } from "./state";
import { clearPendingAI, clearStreamingTailMessages, getProviderInfo, isStreaming, pushSystemMessage } from "./state";
import { clearPrompt } from "./promptstate";
import { formatTimestamp } from "./time";
import {
  DEFAULT_EFFORT,
  DEFAULT_PROVIDER_ORDER,
  type ProviderId,
  type EffortLevel,
} from "./messages";
import { convDisplayName } from "./messages";
import { copyToClipboard } from "./vim/clipboard";
import { getMarkPrefix, getMarkFromTitle } from "./marks";
import { theme, themes, THEME_NAMES, setTheme } from "./theme";
import { availableProviders, setChosenProvider } from "./providerselection";
import { INSTRUCTIONS_COMMAND } from "./commands/instructions";
import { MODEL_COMMAND } from "./commands/model";
import {
  conversationalMessages,
  defaultEffortFor,
  defaultModelForProvider,
  effortItems,
  formatEffortChoices,
  normalizeStateEffort,
  parseNonNegativeInt,
  providerCompletionItems,
  providerModelItems,
  providerSupportsFastMode,
  showLoginInfo,
  supportedEfforts,
} from "./commands/shared";
import { TOKENS_COMMAND } from "./commands/tokens";
import { TRIM_COMMAND, TRIM_MODE_ITEMS } from "./commands/trim";
import type { CommandResult, CompletionItem, SlashCommand } from "./commands/types";

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
      clearStreamingTailMessages(state);
      clearPrompt(state);
      state.scrollOffset = 0;
      state.contextTokens = null;
      return { type: "new_conversation" };
    },
  },
  {
    name: "/replay",
    description: "Replay the current history so the AI can continue",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 1) {
        pushSystemMessage(state, "Usage: /replay");
        clearPrompt(state);
        return { type: "handled" };
      }
      if (!state.convId) {
        pushSystemMessage(state, "No active conversation to replay.");
        clearPrompt(state);
        return { type: "handled" };
      }
      if (isStreaming(state)) {
        pushSystemMessage(state, "Cannot replay the conversation while it is streaming.");
        clearPrompt(state);
        return { type: "handled" };
      }
      if (conversationalMessages(state).length === 0) {
        pushSystemMessage(state, "No conversation history to replay.");
        clearPrompt(state);
        return { type: "handled" };
      }
      clearPrompt(state);
      return { type: "replay_requested" };
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
        clearPrompt(state);
        return { type: "generate_title" };
      }
      const conv = state.sidebar.conversations.find(c => c.id === state.convId);
      const markPrefix = conv ? getMarkPrefix(conv.title) : null;
      const title = markPrefix ? markPrefix + " " + rawTitle : rawTitle;
      if (conv) conv.title = title;
      clearPrompt(state);
      return { type: "rename_conversation", title };
    },
  },
  MODEL_COMMAND,
  TRIM_COMMAND,
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
    description: "Toggle or set OpenAI fast mode",
    args: [
      { name: "on", desc: "Enable fast mode for this conversation" },
      { name: "off", desc: "Disable fast mode for this conversation" },
    ],
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      const arg = parts[1]?.toLowerCase();
      const supportsFast = providerSupportsFastMode(state);
      const providerLabel = state.provider;

      if (parts.length > 2 || (arg && !["on", "off"].includes(arg))) {
        pushSystemMessage(state, "Usage: /fast [on|off]");
        clearPrompt(state);
        return { type: "handled" };
      }

      if (!supportsFast) {
        pushSystemMessage(state, `Fast mode is only available for ${providerLabel} conversations that support it.`);
        clearPrompt(state);
        return { type: "handled" };
      }

      const enabled = arg ? arg === "on" : !state.fastMode;
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
  TOKENS_COMMAND,
  {
    name: "/time",
    description: "Show the timestamp of the last chat message",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 2) {
        pushSystemMessage(state, "Usage: /time [n]");
        clearPrompt(state);
        return { type: "handled" };
      }

      const offset = parts.length === 2 ? parseNonNegativeInt(parts[1]) : 0;
      if (parts.length === 2 && offset === null) {
        pushSystemMessage(state, "Usage: /time [n]\n\nn must be a non-negative integer starting at 0.");
        clearPrompt(state);
        return { type: "handled" };
      }

      const history = conversationalMessages(state);
      if (history.length === 0) {
        pushSystemMessage(state, "No chat messages yet.");
        clearPrompt(state);
        return { type: "handled" };
      }

      const indexFromEnd = offset ?? 0;
      if (indexFromEnd >= history.length) {
        pushSystemMessage(state, `Only ${history.length} chat message${history.length === 1 ? "" : "s"} available.`);
        clearPrompt(state);
        return { type: "handled" };
      }

      const target = history[history.length - 1 - indexFromEnd];
      const timestamp = target.metadata?.startedAt;
      if (typeof timestamp !== "number") {
        pushSystemMessage(state, "No timestamp available for that message.");
        clearPrompt(state);
        return { type: "handled" };
      }

      pushSystemMessage(state, formatTimestamp(timestamp));
      clearPrompt(state);
      return { type: "handled" };
    },
  },
  {
    name: "/theme",
    description: "Set or show the current theme",
    args: THEME_NAMES.map((n) => ({ name: n, desc: n === theme.name ? `${n} (active)` : n })),
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
  INSTRUCTIONS_COMMAND,
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

export function tryCommand(text: string, state: RenderState): CommandResult | null {
  if (!text.startsWith("/")) return null;

  const name = text.split(/\s+/)[0];
  const cmd = commands.find(c => c.name === name);
  if (!cmd) return null;

  return cmd.handler(text, state);
}

export const COMMAND_LIST: CompletionItem[] = commands
  .filter(c => c.name !== "/exit")
  .map(c => ({ name: c.name, desc: c.description }));

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

export type { CommandResult, CompletionItem, SlashCommand } from "./commands/types";
