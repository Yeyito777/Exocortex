import type { EffortLevel, ModelInfo, ReasoningEffortInfo } from "@exocortex/shared/messages";
import { log } from "../../log";
import { getVerifiedSession } from "./auth";
import { OPENAI_CODEX_CLIENT_VERSION, OPENAI_MODELS_URL, OPENAI_ORIGINATOR } from "./constants";

const FALLBACK_OPENAI_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
];

export const FALLBACK_OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.4",
    label: "gpt-5.4",
    maxContext: 272_000,
    supportedEfforts: FALLBACK_OPENAI_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    maxContext: 272_000,
    supportedEfforts: FALLBACK_OPENAI_EFFORTS,
    defaultEffort: "medium",
  },
];

interface OpenAICodexModel {
  slug?: string;
  display_name?: string;
  context_window?: number;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  default_reasoning_level?: EffortLevel;
  supported_reasoning_levels?: Array<{
    effort?: EffortLevel;
    description?: string;
  }>;
}

interface OpenAIModelsResponse {
  models?: OpenAICodexModel[];
}

function isPreferredLatestModel(model: OpenAICodexModel): boolean {
  return typeof model.slug === "string" && /^gpt-5\.4(?:-|$)/.test(model.slug);
}

function toModelInfo(model: OpenAICodexModel): ModelInfo | null {
  if (!model.slug) return null;
  const supportedEfforts = (model.supported_reasoning_levels ?? [])
    .filter((candidate): candidate is { effort: EffortLevel; description?: string } => typeof candidate.effort === "string")
    .map((candidate) => ({
      effort: candidate.effort,
      description: candidate.description?.trim() || candidate.effort,
    }));
  return {
    id: model.slug,
    label: model.display_name?.trim() || model.slug,
    maxContext: model.context_window ?? 272_000,
    supportedEfforts: supportedEfforts.length > 0 ? supportedEfforts : FALLBACK_OPENAI_EFFORTS,
    defaultEffort: model.default_reasoning_level ?? "medium",
  };
}

export async function fetchOpenAIModels(): Promise<ModelInfo[]> {
  const session = await getVerifiedSession();
  const url = `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "application/json",
      originator: OPENAI_ORIGINATOR,
      "User-Agent": "exocortexd/openai",
      ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Codex model fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as OpenAIModelsResponse;
  const models = (data.models ?? [])
    .filter((model) => model.supported_in_api !== false)
    .filter((model) => model.visibility !== "hide")
    .filter(isPreferredLatestModel)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map(toModelInfo)
    .filter((model): model is ModelInfo => model !== null);

  if (models.length === 0) {
    log("warn", "openai models: Codex endpoint returned no GPT-5.4 models, keeping fallback list");
    return FALLBACK_OPENAI_MODELS;
  }

  return models;
}
