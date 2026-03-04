/**
 * Top bar renderer.
 *
 * Renders the top bar: app name, status dot, conversation ID, model.
 * This is the only file that knows how to render the top bar.
 */

import type { RenderState } from "./state";
import { isStreaming } from "./state";
import { theme } from "./theme";

export function renderTopbar(state: RenderState, width?: number): string {
  const w = width ?? state.cols;

  const title = `${theme.bold} Exocortex${theme.reset}${theme.topbarBg}`;
  const modelLabel = state.model.charAt(0).toUpperCase() + state.model.slice(1);
  const convLabel = state.convId ? state.convId.slice(0, 12) : "";
  const statusDot = isStreaming(state) ? `${theme.warning}●${theme.reset}${theme.topbarBg}` : `${theme.success}●${theme.reset}${theme.topbarBg}`;

  const inner = `${title}  ${statusDot}  ${convLabel}`;
  const visibleUsed = " Exocortex".length + 2 + 1 + 2 + convLabel.length;
  const padding = Math.max(0, w - visibleUsed - modelLabel.length - 1);

  return `${theme.topbarBg}${inner}${" ".repeat(padding)}${modelLabel} ${theme.reset}`;
}
