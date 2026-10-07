/**
 * Message metadata renderer.
 *
 * Takes MessageMetadata and produces display lines.
 * This is the only file that knows how to render metadata.
 */

import { formatModelDisplayName, type MessageMetadata } from "./messages";
import { theme } from "./theme";
import { truncateToWidth } from "./textwidth";

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

function formatTokenRate(tokens: number, elapsedMs: number): string {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return "—";
  const rate = tokens / (elapsedMs / 1000);
  return Number.isFinite(rate) ? rate.toFixed(1) : "—";
}

// ── Renderer ────────────────────────────────────────────────────────

/**
 * Render message metadata into display lines.
 *
 * Format: model | N tokens/s | Xs [| N tokens with diagnostics enabled]
 *
 * Throughput is average output tokens over the response's wall-clock span
 * (including tool time), not provider decoding speed. Use startedAt, not the
 * work-stretch timer: that timer can include earlier responses whose tokens
 * are not part of this message's count.
 *
 * @param metadata  The metadata to render (null = no output).
 * @param options.active  Keep elapsed time live even if endedAt is persisted.
 * @param options.width  Available pane columns, including the assistant indent.
 * @param options.diagnostics  Also display the accumulated output-token count.
 * @returns Lines to append below the message content.
 */
export function renderMetadata(
  metadata: MessageMetadata | null,
  options: { active?: boolean; now?: number; width?: number; diagnostics?: boolean } = {},
): string[] {
  if (!metadata) return [];

  const parts: string[] = [];

  // Model
  parts.push(formatModelDisplayName(metadata.model));

  const now = options.now ?? Date.now();
  const end = options.active ? now : metadata.endedAt ?? now;

  // Output throughput over the same response span as the token count.
  parts.push(`${formatTokenRate(metadata.tokens, end - metadata.startedAt)} tokens/s`);

  // Duration retains the independent work-stretch timer.
  const elapsed = end - (metadata.workTimerStartedAt ?? metadata.startedAt);
  parts.push(formatDuration(elapsed));

  if (options.diagnostics) parts.push(`${formatTokenCount(metadata.tokens)} tokens`);

  // Metadata is single-line chrome, not a wrapped content block. Include the
  // indent in its column budget so it cannot paint into a neighboring pane.
  const line = truncateToWidth(`  ${parts.join(" | ")}`, options.width ?? Infinity);
  return [`${theme.dim}${line}${theme.reset}`];
}
