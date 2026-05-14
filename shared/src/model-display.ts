/**
 * Deterministic UI display labels derived from canonical model ids.
 *
 * Keep raw provider ids for persistence / API calls, and derive concise,
 * provider-consistent labels for passive UI surfaces.
 */

import type { ModelId } from "./messages";

const DEEPSEEK_MODEL_RE = /^deepseek-v(\d+)-(.+)$/i;

function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function formatDeepSeekModelDisplayName(modelId: string): string | null {
  const match = DEEPSEEK_MODEL_RE.exec(modelId);
  if (!match) return null;

  const [, version, tier] = match;
  return `DeepSeek V${version} ${capitalizeFirst(tier.toLowerCase())}`;
}

/**
 * Convert a canonical provider model id into a short deterministic UI label.
 *
 * Examples:
 *   gpt-5.4                    -> Gpt-5.4
 *   gpt-5.4-mini               -> Gpt-5.4-mini
 *   deepseek-v4-pro            -> DeepSeek V4 Pro
 */
export function formatModelDisplayName(modelId: ModelId): string {
  return formatDeepSeekModelDisplayName(modelId) ?? capitalizeFirst(modelId);
}
