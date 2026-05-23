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
  if (ms < 1000) return "0s";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${minutes}m ${seconds}s`;
  const hours = totalHours % 24;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 7) return `${totalDays}d ${hours}h ${minutes}m ${seconds}s`;
  const days = totalDays % 7;
  const weeks = Math.floor(totalDays / 7);

  return `${weeks}w ${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function formatTokenCount(tokens: number): string {
  if (Number.isInteger(tokens) && tokens > -1000 && tokens < 1000) return `${tokens}`;
  return tokens.toLocaleString("en-US");
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
  parts.push(`${formatTokenCount(metadata.tokens)} tokens`);

  // Duration
  const elapsed = (metadata.endedAt ?? Date.now()) - metadata.startedAt;
  parts.push(formatDuration(elapsed));

  const line = parts.join(" | ");
  return [`  ${theme.dim}${line}${theme.reset}`];
}
