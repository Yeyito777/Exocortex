/**
 * Message metadata renderer.
 *
 * Takes MessageMetadata and produces display lines.
 * This is the only file that knows how to render metadata.
 */

import { formatModelDisplayName, type MessageMetadata } from "./messages";
import { theme } from "./theme";

// ── Formatting ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const totalDays = Math.floor(totalHours / 24);
  const days = totalDays % 7;
  const weeks = Math.floor(totalDays / 7);

  if (weeks > 0) return `${weeks}w ${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ── Renderer ────────────────────────────────────────────────────────

/**
 * Render message metadata into display lines.
 *
 * Format: model · N tokens · Xs
 *
 * @param metadata  The metadata to render (null = no output).
 * @returns Lines to append below the message content.
 */
export function renderMetadata(metadata: MessageMetadata | null): string[] {
  if (!metadata) return [];

  const parts: string[] = [];

  // Model
  parts.push(formatModelDisplayName(metadata.model));

  // Tokens
  parts.push(`${metadata.tokens.toLocaleString("en-US")} tokens`);

  // Duration
  const elapsed = (metadata.endedAt ?? Date.now()) - metadata.startedAt;
  parts.push(formatDuration(elapsed));

  const line = parts.join(" | ");
  return [`  ${theme.dim}${line}${theme.reset}`];
}
