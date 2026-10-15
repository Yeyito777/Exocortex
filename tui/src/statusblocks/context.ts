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

/** The context meter's reading: last known context tokens (null: unknown) and the model's max (0: unknown). */
export function contextMeter(state: RenderState): { tokens: number | null; max: number } {
  const registry = state.providerRegistry ?? [];
  const provider = registry.find((p) => p.id === state.provider);
  const model = provider?.models.find((m) => m.id === state.model);
  return { tokens: state.contextTokens, max: model?.maxContext ?? MAX_CONTEXT[state.model] ?? 0 };
}

export function contextBlock(state: RenderState): StatusBlock | null {
  const { tokens, max: maxCtx } = contextMeter(state);
  const ctxLabel = "  Context: ";
  const ctxValue = tokens === null ? "?" : formatTokenCount(tokens);
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
    priority: 1,
    width,
    height: 2,
    rows: [
      `${theme.muted}${ctxLabel}${theme.accent}${ctxValue}${" ".repeat(ctxPad)}${theme.reset}`,
      `${theme.muted}${maxLabel}${theme.accent}${maxValue}${" ".repeat(maxPad)}${theme.reset}`,
    ],
  };
}
