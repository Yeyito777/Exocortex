/**
 * Top bar renderer.
 *
 * Renders the top bar: app name, conversation title/preview, model.
 * This is the only file that knows how to render the top bar.
 */

import type { RenderState } from "./state";
import { convDisplayName } from "./messages";
import { theme } from "./theme";

/** Max visible length for a conversation preview used as label. */
const PREVIEW_MAX = 30;

/** Resolve a display label for the current conversation from the sidebar list. */
function convLabel(state: RenderState): string {
  if (!state.convId) return "";
  const conv = state.sidebar.conversations.find(c => c.id === state.convId);
  if (!conv) return "";
  const name = convDisplayName(conv);
  if (name.length > PREVIEW_MAX) return name.slice(0, PREVIEW_MAX) + "…";
  return name;
}

export function renderTopbar(state: RenderState, width?: number): string {
  const w = width ?? state.cols;

  const title = `${theme.bold} Exocortex${theme.reset}${theme.topbarBg}`;
  const providerId = typeof state.provider === "string" && state.provider.length > 0 ? state.provider : "unknown";
  const providerLabel = state.providerRegistry.find((provider) => provider.id === providerId)?.label
    ?? (providerId === "openai" ? "OpenAI" : providerId.charAt(0).toUpperCase() + providerId.slice(1));
  const label = convLabel(state);
  const separator = label ? " — " : "";

  const rightLabel = `${providerLabel}/${state.model} — ${state.effort}${state.fastMode ? " — fast" : ""}`;
  const inner = `${title}${separator}${label}`;
  const visibleUsed = " Exocortex".length + separator.length + label.length;
  const padding = Math.max(0, w - visibleUsed - rightLabel.length - 1);

  return `${theme.topbarBg}${inner}${" ".repeat(padding)}${rightLabel} ${theme.reset}`;
}
