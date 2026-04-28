/**
 * Deterministic UI display labels derived from canonical model ids.
 *
 * Keep raw provider ids for persistence / API calls, and derive concise,
 * provider-consistent labels for passive UI surfaces.
 */

import type { ModelId } from "./messages";

const ANTHROPIC_MODEL_RE = /^claude-([a-z]+)-(\d+)-(\d+)(?:-.+)?$/i;
const DEEPSEEK_MODEL_RE = /^deepseek-v(\d+)-(.+)$/i;

function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function formatAnthropicModelDisplayName(modelId: string): string | null {
  const match = ANTHROPIC_MODEL_RE.exec(modelId);
  if (!match) return null;

  const [, family, major, minor] = match;
  // Ignore any trailing date/build suffix and keep the family + semantic version.
  return `${capitalizeFirst(family.toLowerCase())}-${major}.${minor}`;
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
 *   claude-opus-4-6            -> Opus-4.6
 *   claude-haiku-4-5-20251001  -> Haiku-4.5
 */
export function formatModelDisplayName(modelId: ModelId): string {
  return formatAnthropicModelDisplayName(modelId) ?? formatDeepSeekModelDisplayName(modelId) ?? capitalizeFirst(modelId);
}
