/**
 * Gemini models the signed-in Google AI plan can use, from `agy models`.
 *
 * The CLI lists one id per model and thinking level
 * (`gemini-4-neon-high`); Exocortex shows one model per family
 * (`gemini-4-neon`) with the levels as its efforts, and sets both on the ACP
 * session (`model`, `thought_level`). Only Gemini models are offered: the
 * plan's Claude and GPT-OSS models are left to their own providers.
 */

import { DEFAULT_MODEL_BY_PROVIDER, type EffortLevel, type ModelInfo, type ReasoningEffortInfo } from "@exocortex/shared/messages";
import { log } from "../../log";
import { GeminiUnreachableError, isAgyUnreachableText, runAgy } from "./cli";

export const GEMINI_CONTEXT_TOKENS = 1_048_576;

const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh"];
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: "Low thinking level",
  medium: "Medium thinking level",
  high: "High thinking level",
  xhigh: "Extra thinking level",
};

const MODEL_LEVEL_RE = /^(gemini-\d+(?:\.\d+)?-[a-z]+)-(low|medium|high|xhigh)$/;

/** Preferred order in the picker. */
const PREFERRED_ORDER = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash"];

const LABELS: Record<string, string> = {
  "gemini-4-neon": "Gemini 4 Neon",
  "gemini-4-carbon": "Gemini 4 Carbon",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
};

function efforts(levels: Iterable<string>): ReasoningEffortInfo[] {
  const set = new Set(levels);
  return EFFORT_ORDER.filter(level => set.has(level)).map(effort => ({ effort, description: EFFORT_DESCRIPTIONS[effort] }));
}

function modelInfo(id: string, levels: Iterable<string>, label?: string): ModelInfo {
  const supportedEfforts = efforts(levels);
  return {
    id,
    label: label ?? LABELS[id] ?? id,
    maxContext: GEMINI_CONTEXT_TOKENS,
    supportedEfforts,
    defaultEffort: supportedEfforts.some(e => e.effort === "high") ? "high" : supportedEfforts.at(-1)?.effort ?? "high",
    supportsImages: true,
  };
}

/** Seen live on a Google AI Pro account (Nov 2026); replaced by `agy models` once it answers. */
export const FALLBACK_GEMINI_MODELS: ModelInfo[] = [
  modelInfo(DEFAULT_MODEL_BY_PROVIDER.gemini, ["low", "medium", "high", "xhigh"]),
  modelInfo("gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]),
  modelInfo("gemini-4-argon", ["low", "medium", "high"]),
  modelInfo("gemini-3.8-flash", ["low", "medium", "high"]),
];

/** `agy models` output (`id<TAB>name` lines) as Exocortex models. */
export function parseAgyModels(output: string): ModelInfo[] {
  const families = new Map<string, { levels: Set<string>; name: string | null }>();
  for (const line of output.split("\n")) {
    const [rawId, rawName] = line.split("\t");
    const match = MODEL_LEVEL_RE.exec(rawId?.trim() ?? "");
    if (!match) continue;
    const [, family, level] = match;
    const entry = families.get(family) ?? { levels: new Set<string>(), name: null };
    entry.levels.add(level);
    // "Gemini 4 Neon (High)" -> "Gemini 4 Neon"
    const name = rawName?.trim().replace(/\s*\([^)]*\)\s*$/, "");
    if (name) entry.name = name;
    families.set(family, entry);
  }
  const rank = (id: string) => {
    const index = PREFERRED_ORDER.indexOf(id);
    return index < 0 ? PREFERRED_ORDER.length : index;
  };
  return [...families.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([id, entry]) => modelInfo(id, entry.levels, entry.name ?? undefined));
}

export class AgyNotSignedInError extends Error {
  override readonly name = "AgyNotSignedInError";
}

/** Runs `agy models`; throws AgyNotSignedInError when the CLI has no Google sign-in. */
export async function listAgyModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  const result = await runAgy(["models"], { timeoutMs: 30_000, signal });
  const text = `${result.stdout}\n${result.stderr}`;
  if (/sign in/i.test(text) && !MODEL_LEVEL_RE.test(text.split("\n").find(line => line.startsWith("gemini-"))?.split("\t")[0] ?? "")) {
    throw new AgyNotSignedInError("The Antigravity CLI is not signed in to Google.");
  }
  const detail = text.replace(/^Fetching available models\.\.\.\s*/m, "").trim().slice(0, 300);
  // Offline, the CLI gives up waiting for Google's model list: a network failure, not a sign-in one.
  if (result.timedOut) throw new GeminiUnreachableError(`agy models did not answer in time${detail ? ` (${detail})` : ""}`);
  if (result.exitCode !== 0 && isAgyUnreachableText(text)) throw new GeminiUnreachableError(`agy models failed (${detail})`);
  if (result.exitCode !== 0) throw new Error(`agy models failed (exit ${result.exitCode}): ${detail}`);
  return parseAgyModels(result.stdout);
}

export async function fetchGeminiModels(): Promise<ModelInfo[]> {
  const models = await listAgyModels();
  if (models.length === 0) {
    log("warn", "gemini models: agy models listed no Gemini models, keeping the fallback list");
    return FALLBACK_GEMINI_MODELS;
  }
  return models;
}

/** The CLI model id for a family at an effort: the effort if the family has it, else the nearest it has. */
export function agyModelLevel(model: ModelInfo | null | undefined, effort: EffortLevel | undefined): string {
  const levels = (model?.supportedEfforts ?? []).map(e => e.effort);
  const wanted: EffortLevel = effort === "max" || effort === "ultra" ? "xhigh" : effort === "none" || effort === "minimal" ? "low" : effort ?? "high";
  if (levels.length === 0 || levels.includes(wanted)) return wanted;
  const index = EFFORT_ORDER.indexOf(wanted);
  const below = [...EFFORT_ORDER.slice(0, index)].reverse().find(level => levels.includes(level));
  return below ?? levels[0];
}
