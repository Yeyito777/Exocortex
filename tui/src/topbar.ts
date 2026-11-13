/**
 * Top bar renderer.
 *
 * Renders the top bar: app name, conversation title/preview, model.
 * This is the only file that knows how to render the top bar.
 */

import { focusedConversation, isStaleCopyMarked, type RenderState } from "./state";
import { convDisplayName, formatModelDisplayName } from "./messages";
import { termWidth, truncateToWidth } from "./textwidth";
import { theme } from "./theme";
import { activeProviderProxy } from "./provider-proxies";
import { ansiColorToRgb, hexToRgb } from "./terminalcolors";
import { terminalColorLevel } from "./theme";
import { renderLadderSegment, type LadderPalette, type Rgb } from "./modelladder-anim";
import type { EffortLevel, ModelId, ProviderId } from "./messages";
import { ladderLabel, queuedModel, syncModelLadder } from "./modelladder";

/** Max visible length for a conversation preview used as label. */
const PREVIEW_MAX = 30;

/**
 * " — via <alias>" while the conversation's provider goes through /proxy, so a
 * borrowed login is visible next to the model it serves. Says so when the
 * link is not usable.
 */
function proxyLabel(state: RenderState): string {
  const proxy = activeProviderProxy(state);
  if (!proxy) return "";
  const problem = proxy.state === "connecting" ? " (connecting)"
    : proxy.state === "disconnected" ? proxy.apiCredits?.active ? " (down, API credits)" : " (down)"
      : proxy.remoteLoggedIn === false ? " (not logged in)"
        : "";
  return ` — via ${proxy.alias}${problem}`;
}

/** Resolve a display label for the current conversation from the sidebar list. */
function convLabel(state: RenderState): string {
  if (state.sshConnecting) return "";
  if (!state.convId) return "";
  const conv = focusedConversation(state);
  if (!conv) return "";
  return truncateToWidth(convDisplayName(conv), PREVIEW_MAX);
}

/**
 * The model label on the right of the bar, e.g. `Anthropic/Opus-5.5 — high`.
 * `model`/`effort` give the label the conversation would have with them.
 */
export function topbarModelLabel(
  state: RenderState,
  model: ModelId = state.model,
  effort: EffortLevel = state.effort,
  provider: ProviderId = state.provider,
): string {
  if (state.sshConnecting || !(state.hasChosenProvider || state.convId)) return "";
  const providerId = typeof provider === "string" && provider.length > 0 ? provider : "unknown";
  const providerLabel = state.providerRegistry.find((provider) => provider.id === providerId)?.label
    ?? (providerId === "openai" ? "OpenAI" : providerId.charAt(0).toUpperCase() + providerId.slice(1));
  return `${providerLabel}/${formatModelDisplayName(model)} — ${effort}${state.fastMode === "ultrafast" ? " — ultrafast" : state.fastMode ? " — fast" : ""}${proxyLabel(state)}`;
}

const WHITE: Rgb = [255, 255, 255];

/**
 * Colours the ladder animation blends between: the bar's background and its
 * label colour. The label is drawn in the terminal's default foreground, which
 * is the theme's `terminalFg` when it sets one.
 */
export function topbarLadderPalette(): LadderPalette {
  return {
    bg: ansiColorToRgb(theme.topbarBg, 48) ?? [29, 155, 240],
    fg: theme.terminalFg ? hexToRgb(theme.terminalFg) : WHITE,
    light: ansiColorToRgb(theme.ladderLight, 38) ?? undefined,
    refused: ansiColorToRgb(theme.ladderRefused, 38) ?? undefined,
    level: terminalColorLevel,
  };
}

/** Ends `topbarDim`, which is SGR faint or a colour, without touching the bar's background. */
const TOPBAR_DIM_OFF = "\x1b[22;39m";

export function renderTopbar(state: RenderState, width?: number, now = Date.now()): string {
  const w = width ?? state.cols;

  // The daemon cannot reach the network; turns wait for it to come back.
  const offline = state.daemonOfflineSince != null ? " ⚠ offline" : "";
  const titleStyled = `${theme.bold} Exocortex${offline}${theme.boldOff}`;
  const titlePlain = ` Exocortex${offline}`;
  let label = convLabel(state);
  // A cached copy shown until the daemon confirms or updates it (cachedopen.ts).
  const updating = label && isStaleCopyMarked(state) ? " ↻ updating" : "";

  // A model switch waiting for the turn to end shows as the model it switches to.
  syncModelLadder(state, now);
  const queued = queuedModel(state);
  let rightLabel = ladderLabel(state, queued);

  const maxLeftWidth = Math.max(0, w - (rightLabel ? termWidth(rightLabel) + 1 : 0));
  const maxLabelWidth = Math.max(0, maxLeftWidth - termWidth(titlePlain) - (label ? termWidth(" — ") + termWidth(updating) : 0));
  label = truncateToWidth(label, maxLabelWidth);
  const separator = label ? " — " : "";
  const marker = label ? updating : "";

  const leftPlain = `${titlePlain}${separator}${label}${marker}`;
  const rightSpace = Math.max(0, w - termWidth(leftPlain));
  rightLabel = truncateToWidth(rightLabel, Math.max(0, rightSpace - 1));
  const rightWidth = rightLabel ? termWidth(rightLabel) + 1 : 0;
  const padding = Math.max(0, w - termWidth(leftPlain) - rightWidth);

  const markerStyled = marker ? `${theme.topbarDim}${marker}${TOPBAR_DIM_OFF}` : "";
  // Shift+Up/Down: the model ladder plays over the right of the bar. It only
  // takes cells the bar leaves blank, so nothing to its left moves.
  const ladder = state.modelLadder?.anim;
  if (ladder && rightLabel && ladder.convId === state.convId) {
    const available = padding + rightWidth;
    const segment = renderLadderSegment(ladder, rightLabel, now, topbarLadderPalette(), available);
    if (segment) {
      return `${theme.topbarBg}${titleStyled}${separator}${label}${markerStyled}${" ".repeat(available - segment.width)}${segment.text}${theme.reset}`;
    }
  }
  // Without the animation a waiting switch is simply dimmed.
  const rightStyled = queued && rightLabel ? `${theme.topbarDim}${rightLabel}${TOPBAR_DIM_OFF}` : rightLabel;
  return `${theme.topbarBg}${titleStyled}${separator}${label}${markerStyled}${" ".repeat(padding)}${rightStyled}${rightLabel ? " " : ""}${theme.reset}`;
}
