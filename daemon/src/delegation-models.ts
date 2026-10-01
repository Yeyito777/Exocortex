import type { FastMode } from "@exocortex/shared/messages";
import { effectiveConversationDefaults } from "@exocortex/shared/config";
import type { EffortLevel, ModelId, ProviderId } from "./messages";
import {
  allowsCustomModels, canonicalizeModel, getDefaultModel, getProvider,
  isKnownModel, normalizeEffort, supportsFastMode,
} from "./providers/registry";

export const OPENAI_SIZES = ["astra", "sol", "terra", "luna"] as const;
const sizedModel = /^gpt-(\d+(?:\.\d+)*)-(astra|sol|terra|luna)$/;
const numberedModel = /^gpt-(\d+(?:\.\d+)*)(?:-|$)/;

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** Resolve from catalog metadata, never a hardcoded "current generation". */
export function latestSizeModel(size: string, models: readonly string[]): string | undefined {
  return models.filter(id => sizedModel.exec(id)?.[2] === size)
    .sort((a, b) => compareVersions(sizedModel.exec(b)![1], sizedModel.exec(a)![1]))[0];
}

export function isLegacyDelegationModel(provider: ProviderId, model: string, models: readonly string[]): boolean {
  if (provider !== "openai") return false;
  const sized = sizedModel.exec(model);
  if (sized) {
    const latest = latestSizeModel(sized[2], models);
    return latest !== undefined && compareVersions(sizedModel.exec(latest)![1], sized[1]) > 0;
  }
  const version = numberedModel.exec(model)?.[1];
  return version !== undefined && models.some(id => {
    const candidate = numberedModel.exec(id)?.[1];
    return candidate !== undefined && compareVersions(candidate, version) > 0;
  });
}

export function inferModelProvider(model: string | undefined): ProviderId | undefined {
  const lowered = model?.trim().toLowerCase();
  if (!lowered) return undefined;
  if (OPENAI_SIZES.some(size => size === lowered) || /^(gpt-|o1|o3|o4)/.test(lowered)) return "openai";
  if (isKnownModel("openrouter", lowered)) return "openrouter";
  if (lowered === "pro" || lowered === "flash" || lowered.startsWith("deepseek-") || lowered.startsWith("v4-")) return "deepseek";
  return undefined;
}

export function parseRequestedModel(providerValue: unknown, modelValue: unknown): { provider?: ProviderId; model?: ModelId } {
  const parseProvider = (value: unknown): ProviderId | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (value === "openai" || value === "deepseek" || value === "opencode" || value === "openrouter") return value;
    throw new Error(`Unknown provider: ${String(value)}`);
  };
  let provider = parseProvider(providerValue);
  let model = typeof modelValue === "string" && modelValue.trim() ? modelValue.trim() : undefined;
  if (model && /^(openai|deepseek|opencode|openrouter)\//i.test(model)) {
    const slash = model.indexOf("/");
    const specProvider = parseProvider(model.slice(0, slash).toLowerCase());
    if (provider && provider !== specProvider) throw new Error(`Provider ${provider} conflicts with model spec provider ${specProvider}`);
    provider = specProvider;
    model = model.slice(slash + 1).trim();
    if (!model) throw new Error("Missing model name in model spec");
  }
  provider ??= inferModelProvider(model);
  if (provider === "openai" && model && OPENAI_SIZES.some(size => size === model!.toLowerCase())) {
    const alias = model.toLowerCase();
    model = latestSizeModel(alias, getProvider("openai")!.models.map(candidate => candidate.id));
    if (!model) throw new Error(`Model size "${alias}" is unavailable. Inspect the provider catalog for available models.`);
  }
  if (provider && model) model = canonicalizeModel(provider, model);
  return { provider, model };
}

export function assertDelegationModel(provider: ProviderId, model: string, legacy = false): void {
  if (typeof legacy !== "boolean") throw new Error("legacy must be a boolean");
  const models = getProvider(provider)?.models.map(candidate => candidate.id) ?? [];
  // Delegation cannot establish "latest" for an invented OpenAI identifier.
  // Ordinary interactive conversations retain their custom-model support.
  if (!isKnownModel(provider, model) && (provider === "openai" || !allowsCustomModels(provider))) {
    const available = models.filter(id => legacy || !isLegacyDelegationModel(provider, id, models));
    throw new Error(`Unknown model for provider ${provider}: ${model}. Available delegation models: ${available.join(", ") || "none"}`);
  }
  if (!legacy && isLegacyDelegationModel(provider, model, models)) {
    const size = sizedModel.exec(model)?.[2];
    const latest = size ? latestSizeModel(size, models) : undefined;
    throw new Error(`Legacy delegation model "${model}" requires explicit legacy:true (CLI: --legacy). ${latest ? `Use ${size} or ${latest} instead.` : "Inspect the provider catalog for current choices."}`);
  }
}

export interface DelegationModelRequest {
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: FastMode;
  legacy?: boolean;
}

/** /default-model owns defaults. Only implicit outdated sizes are upgraded. */
export function resolveDelegationModel(input: DelegationModelRequest) {
  if (input.legacy !== undefined && typeof input.legacy !== "boolean") throw new Error("legacy must be a boolean");
  const requested = parseRequestedModel(input.provider, input.model);
  const defaults = effectiveConversationDefaults();
  const provider = requested.provider ?? defaults.provider;
  if (!getProvider(provider)) throw new Error(`Unknown provider: ${provider}`);
  let model = requested.model ?? (provider === defaults.provider ? defaults.model : getDefaultModel(provider));
  const usesConfiguredDefault = provider === defaults.provider && model === defaults.model;
  if (!requested.model && provider === "openai") {
    // Config may contain a size alias or an exact ID from an older release.
    model = parseRequestedModel(provider, model).model!;
    const size = sizedModel.exec(model)?.[2];
    if (size && !input.legacy) model = latestSizeModel(size, getProvider(provider)!.models.map(candidate => candidate.id)) ?? model;
  }
  assertDelegationModel(provider, model, input.legacy);
  const effort = normalizeEffort(provider, model, input.effort ?? (usesConfiguredDefault ? defaults.effort : undefined));
  const requestedFastMode = input.fastMode ?? (usesConfiguredDefault && defaults.fastMode);
  const fastMode = supportsFastMode(provider, model, requestedFastMode) ? requestedFastMode : false;
  return { provider, model, effort, fastMode };
}
