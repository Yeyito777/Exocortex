/**
 * Context status block — current context tokens and max context.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";

const MAX_CONTEXT = 200_000;

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function contextBlock(state: RenderState): StatusBlock | null {
  const ctxLabel = "  Context: ";
  const ctxValue = formatTokenCount(state.contextTokens ?? 0);
  const maxLabel = "  Max Context: ";
  const maxValue = formatTokenCount(MAX_CONTEXT);

  const width = Math.max(
    ctxLabel.length + ctxValue.length,
    maxLabel.length + maxValue.length,
  );

  const ctxPad = Math.max(0, width - ctxLabel.length - ctxValue.length);
  const maxPad = Math.max(0, width - maxLabel.length - maxValue.length);

  return {
    id: "context",
    priority: 2,
    width,
    height: 2,
    rows: [
      `${theme.muted}${ctxLabel}${theme.accent}${ctxValue}${" ".repeat(ctxPad)}${theme.reset}`,
      `${theme.muted}${maxLabel}${theme.accent}${maxValue}${" ".repeat(maxPad)}${theme.reset}`,
    ],
  };
}
