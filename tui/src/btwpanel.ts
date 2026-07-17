/** Compact foreground panel for an ephemeral `/btw` answer. */

import { formatModelDisplayName } from "./messages";
import { markdownWordWrap } from "./markdown";
import type { BtwPanelState } from "./state";
import { padRightToWidth, padVisibleRightToWidth, termWidth, truncateToWidth } from "./textwidth";
import { theme } from "./theme";

const ESC = "\x1b[";
const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;

export interface BtwPanelRender {
  payload: string;
  width: number;
  height: number;
  top: number;
  left: number;
}

export const MAX_BTW_PANEL_HEIGHT = 20;

function cleanInline(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
}

function phaseLabel(btw: BtwPanelState): { text: string; color: string } {
  switch (btw.phase) {
    case "complete": return { text: "✓ complete", color: theme.success };
    case "error": return { text: "✗ error", color: theme.error };
    case "starting": return { text: "◌ starting", color: theme.warning };
    case "running": return { text: "● running", color: theme.accent };
  }
}

/** Keep streaming compact, then expand completed answers to fit up to 20 rows. */
export function getBtwPanelPreferredHeight(btw: BtwPanelState, width: number): number {
  if (width < 22) return 1;
  if (btw.phase !== "complete" || !btw.text) return 4;
  const contentWidth = Math.max(1, width - 4);
  const answerRows = markdownWordWrap(btw.text, contentWidth, theme.sidebarBg).lines.length;
  return Math.min(MAX_BTW_PANEL_HEIGHT, Math.max(4, answerRows + 2));
}

/**
 * Render a compact-to-expanded card at an explicit screen position. The caller
 * anchors it directly above the prompt; constrained layouts use one row.
 */
export function renderBtwPanel(
  btw: BtwPanelState,
  width: number,
  height = 4,
  top = 1,
  left = 1,
): BtwPanelRender | null {
  if (width <= 0 || height <= 0 || top <= 0 || left <= 0) return null;

  const phase = phaseLabel(btw);
  if (width < 22 || height < 4) {
    const label = truncateToWidth(` BTW · ${phase.text}`, width);
    btw.maxScroll = 0;
    btw.viewportRows = 1;
    btw.scrollOffset = 0;
    return {
      payload: moveTo(top, left) + theme.sidebarBg + phase.color + padRightToWidth(label, width) + theme.reset,
      width,
      height: 1,
      top,
      left,
    };
  }

  const panelHeight = Math.min(MAX_BTW_PANEL_HEIGHT, height);
  const innerWidth = width - 2;
  const contentWidth = Math.max(1, innerWidth - 2);
  const contentRows = panelHeight - 2;
  const panelBg = theme.sidebarBg;
  const outline = theme.accent;

  const applyPanelBg = (line: string): string => {
    const persistent = line.replaceAll(theme.reset, `${theme.reset}${panelBg}`);
    return `${panelBg}${persistent}${theme.reset}`;
  };
  const contentLine = (text: string): string => applyPanelBg(
    `${outline}│${theme.reset}${panelBg} ${padVisibleRightToWidth(text, contentWidth)} ${outline}│`,
  );

  const model = cleanInline(formatModelDisplayName(btw.model));
  const query = cleanInline(btw.query);
  const identity = `BTW · ${model} · ${query}`;
  const topLeftFixedWidth = termWidth("╭─ ") + 1;
  const topRightPlain = ` ${phase.text} ─╮`;
  const labelBudget = Math.max(1, width - topLeftFixedWidth - termWidth(topRightPlain));
  const label = truncateToWidth(identity, labelBudget);
  const topLeftPlain = `╭─ ${label} `;
  const fillWidth = Math.max(0, width - termWidth(topLeftPlain) - termWidth(topRightPlain));
  const topLine = `${theme.bold}${outline}╭─ ${theme.text}${label}${theme.boldOff}${outline} ${"─".repeat(fillWidth)}${phase.color}${topRightPlain}`;
  const lines: string[] = [applyPanelBg(topLine)];

  const wrapped = btw.text
    ? markdownWordWrap(btw.text, contentWidth, panelBg).lines
    : [`${theme.muted}${truncateToWidth(btw.phase === "error" ? "No answer was produced." : btw.status || "Thinking…", contentWidth)}${theme.reset}${panelBg}`];
  const maxScroll = Math.max(0, wrapped.length - contentRows);
  btw.maxScroll = maxScroll;
  btw.viewportRows = contentRows;
  btw.scrollOffset = Math.max(0, Math.min(btw.scrollOffset, maxScroll));
  const start = Math.max(0, wrapped.length - contentRows - btw.scrollOffset);
  const visible = wrapped.slice(start, start + contentRows);
  for (let i = 0; i < contentRows; i++) lines.push(contentLine(visible[i] ?? ""));

  lines.push(applyPanelBg(`${outline}╰${"─".repeat(innerWidth)}╯`));

  let payload = "";
  for (let index = 0; index < lines.length; index++) {
    payload += moveTo(top + index, left) + lines[index];
  }
  return { payload, width, height: panelHeight, top, left };
}
