/**
 * Earned usage-reset status block — available count and nearest expiry.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatTimeUntil(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "?";
  const diff = Math.floor((expiresAt - now) / 1000);
  if (diff <= 0) return "now";

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d:${hours}h:${pad2(mins)}m`;
  return `${hours}h:${pad2(mins)}m`;
}

export function usageResetsBlock(state: RenderState): StatusBlock | null {
  if (state.provider !== "openai" || !state.authByProvider.openai) return null;
  const resetCredits = state.usageByProvider.openai?.resetCredits;
  if (!resetCredits) return null;

  const countLabel = "  Usage Resets: ";
  const count = String(resetCredits.availableCount);
  const expiryLabel = "  Next Expiriy: ";
  const expiry = formatTimeUntil(resetCredits.nextExpiresAt, Date.now());
  const countWidth = countLabel.length + count.length;
  const expiryWidth = expiryLabel.length + expiry.length;
  const width = Math.max(countWidth, expiryWidth);

  return {
    id: "usage-resets",
    priority: 0,
    width,
    height: 2,
    rows: [
      `${theme.muted}${countLabel}${theme.accent}${count}${theme.reset}${" ".repeat(width - countWidth)}`,
      `${theme.muted}${expiryLabel}${theme.accent}${expiry}${theme.reset}${" ".repeat(width - expiryWidth)}`,
    ],
  };
}
