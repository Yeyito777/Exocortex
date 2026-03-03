/**
 * Message metadata renderer.
 *
 * Takes MessageMetadata and produces display lines.
 * This is the only file that knows how to render metadata.
 */

import type { MessageMetadata } from "./messages";

// ── ANSI ────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;

// ── Formatting ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
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
  parts.push(metadata.model);

  // Tokens
  parts.push(`${metadata.tokens} tokens`);

  // Duration
  const elapsed = (metadata.endedAt ?? Date.now()) - metadata.startedAt;
  parts.push(formatDuration(elapsed));

  const line = parts.join(" · ");
  return [`  ${DIM}${line}${RESET}`];
}
