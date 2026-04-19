import type { RenderState } from "../state";
import type { AIMessage, UserMessage } from "../messages";
import {
  EFFORT_LEVELS,
  normalizeEffortForModel,
  type ProviderId,
  type ModelId,
  type EffortLevel,
  type ReasoningEffortInfo,
} from "../messages";
import { clearPrompt } from "../promptstate";
import { getModelInfo, getProviderInfo, pushSystemMessage } from "../state";
import { availableProviders, setChosenProvider } from "../providerselection";
import type { CommandResult, CompletionItem } from "./types";

export function showNoSystemInstructions(state: RenderState): CommandResult {
  pushSystemMessage(state, "No system instructions set for this conversation.");
  clearPrompt(state);
  return { type: "handled" };
}

export function providerModels(state: RenderState, provider = state.provider): ModelId[] {
  return getProviderInfo(state, provider)?.models.map((model) => model.id) ?? [];
}

export function defaultModelForProvider(state: RenderState, provider = state.provider): ModelId | null {
  return getProviderInfo(state, provider)?.defaultModel ?? null;
}

export function providerAllowsCustomModels(state: RenderState, provider = state.provider): boolean {
  return getProviderInfo(state, provider)?.allowsCustomModels ?? false;
}

export function providerSupportsFastMode(state: RenderState, provider = state.provider): boolean {
  return getProviderInfo(state, provider)?.supportsFastMode ?? false;
}

export function providerCompletionItems(state: RenderState): CompletionItem[] {
  return availableProviders(state).map((provider) => ({
    name: provider,
    desc: getProviderInfo(state, provider)?.label ?? `${provider} models`,
  }));
}

export function providerModelItems(state: RenderState, provider = state.provider): CompletionItem[] {
  const info = getProviderInfo(state, provider);
  const models = info?.models ?? [];
  return models.map((model) => ({
    name: model.id,
    desc: model.id === info?.defaultModel ? `${model.label} (default)` : model.label,
  }));
}

export function supportedEfforts(state: RenderState, provider = state.provider, model = state.model): ReasoningEffortInfo[] {
  return getModelInfo(state, provider, model)?.supportedEfforts ?? EFFORT_LEVELS.map((effort) => ({ effort, description: effort }));
}

export function defaultEffortFor(state: RenderState, provider = state.provider, model = state.model): EffortLevel {
  return normalizeEffortForModel(getModelInfo(state, provider, model), null);
}

export function maxContextFor(state: RenderState, provider = state.provider, model = state.model): number | null {
  return getModelInfo(state, provider, model)?.maxContext ?? null;
}

export function effortItems(state: RenderState, provider = state.provider, model = state.model): CompletionItem[] {
  const defaultEffort = defaultEffortFor(state, provider, model);
  return supportedEfforts(state, provider, model).map((candidate) => ({
    name: candidate.effort,
    desc: candidate.effort === defaultEffort ? `${candidate.description} (default)` : candidate.description,
  }));
}

export function normalizeStateEffort(state: RenderState, provider = state.provider, model = state.model): void {
  state.effort = normalizeEffortForModel(getModelInfo(state, provider, model), state.effort);
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
  return `Warning: last known context (${previousContextTokens.toLocaleString("en-US")} tokens) exceeds ${provider}/${model}'s max context (${nextMaxContext.toLocaleString("en-US")}). The next turn may fail unless you trim the conversation (for example: /trim thinking 20, /trim toolresults 20, or /trim messages 5) or start a new one.`;
}

export function applyProviderModelSelection(state: RenderState, provider: ProviderId, model: ModelId): {
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

export function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseNonNegativeInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Chat-history messages only (user/assistant), with pending AI treated as the latest entry. */
export function conversationalMessages(state: RenderState): Array<UserMessage | AIMessage> {
  const history = state.messages.filter((msg): msg is UserMessage | AIMessage => msg.role === "user" || msg.role === "assistant");
  if (state.pendingAI) history.push(state.pendingAI);
  return history;
}

export function trimHelpText(state: RenderState): string {
  const current = state.contextTokens != null ? state.contextTokens.toLocaleString("en-US") : "unknown";
  const maxContext = maxContextFor(state);
  const maxLabel = maxContext != null ? maxContext.toLocaleString("en-US") : "unknown";
  return [
    `Current context: ${current} / ${maxLabel} tokens`,
    "Usage:",
    "  /trim messages <n>",
    "  /trim thinking <n>",
    "  /trim toolresults <n>",
    "",
    "messages   Removes the oldest history entries first.",
    "thinking   Removes thinking blocks from the oldest assistant turns first.",
    "toolresults Replaces the oldest tool result payloads with placeholders first.",
  ].join("\n");
}

export function formatProviderModels(state: RenderState, provider: ProviderId): string {
  const models = providerModels(state, provider);
  if (models.length === 0) return `${provider}: (waiting for daemon)`;
  return `${provider}: ${models.join(", ")}${providerAllowsCustomModels(state, provider) ? " (custom ids allowed)" : ""}`;
}

export function formatEffortChoices(candidates: ReasoningEffortInfo[], current: EffortLevel, defaultEffort: EffortLevel): string {
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

export { availableProviders };
