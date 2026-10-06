import type { FastMode } from "@exocortex/shared/messages";
import type { ConversationDefaults } from "@exocortex/shared/config";
import { clearPrompt } from "../promptstate";
import { getModelInfo, getProviderInfo, pushSystemMessage } from "../state";
import { formatConversationDefaults } from "../events/conversation-defaults";
import { EFFORT_LEVELS, defaultEffortForModelId, normalizeEffortForModel, type EffortLevel, type ModelId, type ProviderId } from "../messages";
import {
  availableProviders,
  defaultEffortFor,
  effortItems,
  providerCompletionItems,
  providerModels,
  providerAllowsCustomModels,
  providerModelItems,
  supportedEfforts,
} from "./shared";
import type { CompletionItem, SlashCommand } from "./types";

const USAGE = [
  "Usage:",
  "  /default-model",
  "  /default-model current",
  "  /default-model reset",
  "  /default-model <provider> <model> <effort> <fast|ultrafast|off|na>",
].join("\n");

const FAST_ITEMS: CompletionItem[] = [
  { name: "fast", desc: "Enable fast mode for new conversations" },
  { name: "off", desc: "Disable fast mode for new conversations" },
];

const FAST_UNAVAILABLE_ITEMS: CompletionItem[] = [
  { name: "na", desc: "Fast mode is not available for this provider" },
];

const DEEPSEEK_ALIASES: Record<string, ModelId> = {
  pro: "deepseek-v4-pro",
  "v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro": "deepseek-v4-pro",
  flash: "deepseek-v4-flash",
  "v4-flash": "deepseek-v4-flash",
  "deepseek-v4-flash": "deepseek-v4-flash",
};

type FastParseResult =
  | { ok: true; value: FastMode }
  | { ok: false };

function isProviderId(value: string): value is ProviderId {
  return value === "openai" || value === "deepseek" || value === "opencode" || value === "openrouter";
}

function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

function parseFast(value: string): FastParseResult {
  switch (value.toLowerCase()) {
    case "ultrafast":
      return { ok: true, value: "ultrafast" };
    case "fast":
    case "on":
    case "true":
    case "yes":
      return { ok: true, value: true };
    case "off":
    case "na":
    case "n/a":
    case "standard":
    case "normal":
    case "false":
    case "no":
      return { ok: true, value: false };
    default:
      return { ok: false };
  }
}

function normalizeModelForProvider(provider: ProviderId, model: string): ModelId {
  const trimmed = model.trim();
  const lowered = trimmed.toLowerCase();
  if (provider === "deepseek") return DEEPSEEK_ALIASES[lowered] ?? trimmed;
  return trimmed;
}

function inferProviderForBareModel(stateProvider: ProviderId, model: string): ProviderId {
  const lowered = model.trim().toLowerCase();
  if (lowered in DEEPSEEK_ALIASES || lowered.startsWith("deepseek-")) return "deepseek";
  if (lowered.startsWith("gpt-") || lowered.startsWith("o1") || lowered.startsWith("o3") || lowered.startsWith("o4")) return "openai";
  return stateProvider;
}

interface ParsedSelectionArgs {
  provider: ProviderId;
  model: ModelId;
  rest: string[];
}

function parseSelectionArgs(args: string[], stateProvider: ProviderId): ParsedSelectionArgs | null {
  const first = args[0];
  if (!first) return null;

  if (isProviderId(first)) {
    const modelArg = args[1];
    if (!modelArg) return null;
    return {
      provider: first,
      model: normalizeModelForProvider(first, modelArg),
      rest: args.slice(2),
    };
  }

  const slash = first.indexOf("/");
  if (slash !== -1) {
    const providerPart = first.slice(0, slash).trim().toLowerCase();
    const modelPart = first.slice(slash + 1).trim();
    if (!isProviderId(providerPart) || !modelPart) return null;
    return {
      provider: providerPart,
      model: normalizeModelForProvider(providerPart, modelPart),
      rest: args.slice(1),
    };
  }

  const provider = inferProviderForBareModel(stateProvider, first);
  return {
    provider,
    model: normalizeModelForProvider(provider, first),
    rest: args.slice(1),
  };
}

interface ParsedOptions {
  effort?: EffortLevel;
  fastMode: FastMode;
}

function parseSelectionOptions(args: string[]): ParsedOptions | { error: string } {
  let effort: EffortLevel | undefined;
  let fastMode: FastMode = false;
  let sawFast = false;

  for (const raw of args) {
    const arg = raw.toLowerCase();
    if (isEffortLevel(arg)) {
      if (effort) return { error: `Effort specified twice: ${effort}, ${arg}` };
      effort = arg;
      continue;
    }

    const fast = parseFast(arg);
    if (fast.ok) {
      if (sawFast) return { error: "Fast mode specified twice." };
      sawFast = true;
      fastMode = fast.value;
      continue;
    }

    return { error: `Unknown default-model option: ${raw}\n\n${USAGE}` };
  }

  return { effort, fastMode };
}

function providerSupportsFastFallback(state: Parameters<SlashCommand["handler"]>[1], provider: ProviderId, model: ModelId): boolean {
  const info = getProviderInfo(state, provider);
  if (!info) return provider === "openai" && model !== "gpt-daybreak-blue-latest";
  return info.supportsFastMode && getModelInfo(state, provider, model)?.supportsFastMode !== false;
}

function defaultEffortForSelection(state: Parameters<SlashCommand["handler"]>[1], provider: ProviderId, model: ModelId): EffortLevel {
  const info = getModelInfo(state, provider, model);
  return info ? defaultEffortFor(state, provider, model) : defaultEffortForModelId(provider, model);
}

function validateSelection(
  state: Parameters<SlashCommand["handler"]>[1],
  provider: ProviderId,
  model: ModelId,
  effort: EffortLevel | undefined,
  fastMode: FastMode,
): ConversationDefaults | { error: string } {
  const providers = availableProviders(state);
  if (!providers.includes(provider)) {
    return { error: `Unknown provider: ${provider}. Available: ${providers.join(", ")}` };
  }

  const knownModels = providerModels(state, provider);
  const providerLoaded = getProviderInfo(state, provider) !== null;
  if (providerLoaded && knownModels.length > 0 && !knownModels.includes(model) && !providerAllowsCustomModels(state, provider)) {
    return { error: `Unknown model for provider ${provider}: ${model}. Available: ${knownModels.join(", ")}` };
  }

  const levels = supportedEfforts(state, provider, model).map((candidate) => candidate.effort);
  if (effort && !levels.includes(effort)) {
    return { error: `Invalid effort for ${provider}/${model}: ${effort}. Valid: ${levels.join(", ")}` };
  }

  if (fastMode && !providerSupportsFastFallback(state, provider, model)) {
    return { error: `Fast mode is only available for ${provider} conversations that support it.` };
  }
  if (fastMode === "ultrafast" && getModelInfo(state, provider, model)?.supportsUltrafastMode !== true) {
    return { error: "Ultrafast is not advertised for this model/account." };
  }

  const finalEffort = effort ?? defaultEffortForSelection(state, provider, model);
  const modelInfo = getModelInfo(state, provider, model);
  return {
    provider,
    model,
    effort: modelInfo ? normalizeEffortForModel(modelInfo, finalEffort) : finalEffort,
    fastMode,
  };
}

function showDefaults(state: Parameters<SlashCommand["handler"]>[1]) {
  const snapshot = state.conversationDefaults;
  pushSystemMessage(state, snapshot
    ? `${snapshot.configured ? "User default" : "App default"}:\n${formatConversationDefaults(snapshot.defaults)}\n\n${USAGE}`
    : "Waiting for conversation defaults from the connected daemon.");
  clearPrompt(state);
  return { type: "handled" } as const;
}

function requestDefaults(state: Parameters<SlashCommand["handler"]>[1], defaults: ConversationDefaults): ReturnType<SlashCommand["handler"]> {
  clearPrompt(state);
  return { type: "conversation_defaults_changed", defaults };
}

function fastItems(state: Parameters<SlashCommand["handler"]>[1], provider: ProviderId, model: ModelId): CompletionItem[] {
  return providerSupportsFastFallback(state, provider, model)
    ? [...FAST_ITEMS, ...(getModelInfo(state, provider, model)?.supportsUltrafastMode
      ? [{ name: "ultrafast", desc: "Use Ultrafast for new conversations" }] : [])]
    : FAST_UNAVAILABLE_ITEMS;
}

function addPositionalCompletions(registry: Record<string, CompletionItem[]>, state: Parameters<SlashCommand["handler"]>[1], key: string, provider: ProviderId, model: ModelId): void {
  registry[key] = effortItems(state, provider, model);
  for (const effort of effortItems(state, provider, model)) {
    registry[`${key} ${effort.name}`] = fastItems(state, provider, model);
  }
}

export const DEFAULT_MODEL_COMMAND: SlashCommand = {
  name: "/default-model",
  description: "Set or show defaults for new conversations",
  getArgs: (state) => {
    const registry: Record<string, CompletionItem[]> = {
      "/default-model": providerCompletionItems(state),
    };

    for (const provider of availableProviders(state)) {
      registry[`/default-model ${provider}`] = providerModelItems(state, provider);
      for (const model of providerModels(state, provider)) {
        addPositionalCompletions(registry, state, `/default-model ${provider} ${model}`, provider, model);
      }
    }

    return registry;
  },
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const args = parts.slice(1);
    const command = args[0]?.toLowerCase();

    if (!command) return showDefaults(state);

    if (["reset", "clear", "product", "default"].includes(command)) {
      clearPrompt(state);
      return { type: "conversation_defaults_reset" };
    }

    if (command === "current") {
      const current = validateSelection(state, state.provider, state.model, state.effort, state.fastMode);
      if ("error" in current) {
        pushSystemMessage(state, current.error);
        clearPrompt(state);
        return { type: "handled" };
      }
      return requestDefaults(state, current);
    }

    const parsedSelection = parseSelectionArgs(args, state.provider);
    if (!parsedSelection) {
      pushSystemMessage(state, USAGE);
      clearPrompt(state);
      return { type: "handled" };
    }

    const parsedOptions = parseSelectionOptions(parsedSelection.rest);
    if ("error" in parsedOptions) {
      pushSystemMessage(state, parsedOptions.error);
      clearPrompt(state);
      return { type: "handled" };
    }

    const defaults = validateSelection(
      state,
      parsedSelection.provider,
      parsedSelection.model,
      parsedOptions.effort,
      parsedOptions.fastMode,
    );
    if ("error" in defaults) {
      pushSystemMessage(state, defaults.error);
      clearPrompt(state);
      return { type: "handled" };
    }

    return requestDefaults(state, defaults);
  },
};
