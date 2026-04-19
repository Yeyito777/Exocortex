/**
 * Top bar renderer.
 *
 * Renders the top bar: app name, conversation title/preview, model.
 * This is the only file that knows how to render the top bar.
 */

import type { RenderState } from "./state";
import { convDisplayName, formatModelDisplayName } from "./messages";
import { termWidth, truncateToWidth } from "./textwidth";
import { theme } from "./theme";

/** Max visible length for a conversation preview used as label. */
const PREVIEW_MAX = 30;

/** Resolve a display label for the current conversation from the sidebar list. */
function convLabel(state: RenderState): string {
  if (!state.convId) return "";
  const conv = state.sidebar.conversations.find(c => c.id === state.convId);
  if (!conv) return "";
  return truncateToWidth(convDisplayName(conv), PREVIEW_MAX);
}

export function renderTopbar(state: RenderState, width?: number): string {
  const w = width ?? state.cols;

  const titleStyled = `${theme.bold} Exocortex${theme.reset}${theme.topbarBg}`;
  const titlePlain = " Exocortex";
  let label = convLabel(state);

  let rightLabel = "";
  if (state.hasChosenProvider || state.convId) {
    const providerId = typeof state.provider === "string" && state.provider.length > 0 ? state.provider : "unknown";
    const providerLabel = state.providerRegistry.find((provider) => provider.id === providerId)?.label
      ?? (providerId === "openai" ? "OpenAI" : providerId.charAt(0).toUpperCase() + providerId.slice(1));
    rightLabel = `${providerLabel}/${formatModelDisplayName(state.model)} — ${state.effort}${state.fastMode ? " — fast" : ""}`;
  }

  const maxLeftWidth = Math.max(0, w - (rightLabel ? termWidth(rightLabel) + 1 : 0));
  const maxLabelWidth = Math.max(0, maxLeftWidth - termWidth(titlePlain) - (label ? termWidth(" — ") : 0));
  label = truncateToWidth(label, maxLabelWidth);
  const separator = label ? " — " : "";

  const leftPlain = `${titlePlain}${separator}${label}`;
  const rightSpace = Math.max(0, w - termWidth(leftPlain));
  rightLabel = truncateToWidth(rightLabel, Math.max(0, rightSpace - 1));
  const rightWidth = rightLabel ? termWidth(rightLabel) + 1 : 0;
  const padding = Math.max(0, w - termWidth(leftPlain) - rightWidth);

  return `${theme.topbarBg}${titleStyled}${separator}${label}${" ".repeat(padding)}${rightLabel}${rightLabel ? " " : ""}${theme.reset}`;
}
