/**
 * Deterministic UI display labels derived from canonical model ids.
 *
 * Keep raw provider ids for persistence / API calls, and derive concise,
 * provider-consistent labels for passive UI surfaces.
 */

import type { ModelId } from "./messages";

const DEEPSEEK_MODEL_RE = /^deepseek-v(\d+)-(.+)$/i;
const CLAUDE_MODEL_RE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|[-[])/i;

function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function formatDeepSeekModelDisplayName(modelId: string): string | null {
  const match = DEEPSEEK_MODEL_RE.exec(modelId);
  if (!match) return null;

  const [, version, tier] = match;
  return `DeepSeek V${version} ${capitalizeFirst(tier.toLowerCase())}`;
}

function formatClaudeModelDisplayName(modelId: string): string | null {
  const match = CLAUDE_MODEL_RE.exec(modelId);
  if (!match) return null;

  // Ignore any trailing date/build or [1m] suffix and keep the family + semantic version.
  const [, family, major, minor] = match;
  return `${capitalizeFirst(family.toLowerCase())}-${major}${minor ? `.${minor}` : ""}`;
}

/**
 * Convert a canonical provider model id into a short deterministic UI label.
 *
 * Examples:
 *   gpt-5.4                    -> Gpt-5.4
 *   gpt-5.4-mini               -> Gpt-5.4-mini
 *   deepseek-v4-pro            -> DeepSeek V4 Pro
 *   claude-opus-5-5            -> Opus-5.5
 */
export function formatModelDisplayName(modelId: ModelId): string {
  if (modelId === "ox-alpha") return "Ox Alpha";
  if (modelId === "gpt-6-astra") return "GPT-6-Astra";
  if (modelId === "gpt-6.1-sol") return "GPT-6.1-Sol";
  if (modelId === "gpt-6-sol") return "GPT-6-Sol";
  if (modelId === "gpt-6-sol-daybreak") return "GPT-6-Sol-Daybreak";
  if (modelId === "gpt-6-luna") return "GPT-6-Luna";
  if (modelId === "gpt-daybreak-blue-latest") return "Daybreak Blue";
  return formatDeepSeekModelDisplayName(modelId) ?? formatClaudeModelDisplayName(modelId) ?? capitalizeFirst(modelId);
}
