/**
 * Context status block — current context tokens and max context.
 */

import type { RenderState } from "../state";
import { MAX_CONTEXT } from "../messages";
import type { StatusBlock } from "../statusline";
import { termWidth } from "../textwidth";
import { theme } from "../theme";

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function contextBlock(state: RenderState): StatusBlock | null {
  const registry = state.providerRegistry ?? [];
  const provider = registry.find((p) => p.id === state.provider);
  const model = provider?.models.find((m) => m.id === state.model);
  const maxCtx = model?.maxContext ?? MAX_CONTEXT[state.model] ?? 0;
  const ctxLabel = "  Context: ";
  const ctxValue = formatTokenCount(state.contextTokens ?? 0);
  const maxLabel = "  Max Context: ";
  const maxValue = maxCtx > 0 ? formatTokenCount(maxCtx) : "?";

  const width = Math.max(
    termWidth(ctxLabel) + termWidth(ctxValue),
    termWidth(maxLabel) + termWidth(maxValue),
  );

  const ctxPad = Math.max(0, width - termWidth(ctxLabel) - termWidth(ctxValue));
  const maxPad = Math.max(0, width - termWidth(maxLabel) - termWidth(maxValue));

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
