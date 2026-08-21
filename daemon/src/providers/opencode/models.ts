import type { ModelInfo, ReasoningEffortInfo } from "@exocortex/shared/messages";
import { log } from "../../log";
import { getApiKey } from "./auth";
import { OPENCODE_MODELS_PATH, OX_ALPHA_MODEL_ID, OX_ALPHA_UPSTREAM_MODEL_ID } from "./constants";
import { buildOpenCodeJsonHeaders, buildOpenCodeUrl } from "./http";
import type { OpenCodeModelsResponse } from "./types";

export const OX_ALPHA_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "low", description: "Ox Alpha reasoning, low effort" },
  { effort: "high", description: "Ox Alpha reasoning, high effort" },
  { effort: "max", description: "Ox Alpha reasoning, maximum effort" },
];

export const OX_ALPHA_MODEL: ModelInfo = {
  id: OX_ALPHA_MODEL_ID,
  label: "Ox Alpha",
  maxContext: 1_000_000,
  supportedEfforts: OX_ALPHA_EFFORTS,
  defaultEffort: "high",
  supportsImages: true,
};

export const FALLBACK_OPENCODE_MODELS: ModelInfo[] = [OX_ALPHA_MODEL];

export async function fetchOpenCodeModels(): Promise<ModelInfo[]> {
  const res = await fetch(buildOpenCodeUrl(OPENCODE_MODELS_PATH), {
    headers: buildOpenCodeJsonHeaders(getApiKey()),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenCode Zen model fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as OpenCodeModelsResponse;
  const available = data.data?.some((model) => model.id === OX_ALPHA_UPSTREAM_MODEL_ID) ?? false;
  if (!available) {
    log("warn", "opencode models: Ox Alpha is no longer advertised; the limited-time preview may have ended");
    return [];
  }
  return FALLBACK_OPENCODE_MODELS;
}
