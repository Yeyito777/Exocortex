/** Compact foreground panel for a conversation-owned `/btw` assistant history. */

import { renderBlockCached, renderSystemMessage } from "../blockrenderer";
import type { Block, ExternalToolStyle, ToolDisplayInfo } from "../messages";
import { padRightToWidth, padVisibleRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { theme } from "../theme";
import type { BtwPanelState } from "./state";

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

export interface BtwPanelRenderOptions {
  toolRegistry?: ToolDisplayInfo[];
  externalToolStyles?: ExternalToolStyle[];
  showToolOutput?: boolean;
}

const EMPTY_TOOL_REGISTRY: ToolDisplayInfo[] = [];
const EMPTY_EXTERNAL_TOOL_STYLES: ExternalToolStyle[] = [];

function cleanInline(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
}

function legacyTextBlock(btw: BtwPanelState): Block[] {
  return btw.text ? [{ type: "text", text: btw.text }] : [];
}

/** Render BTW blocks through the ordinary assistant-history block renderer. */
function renderBtwContentRows(
  btw: BtwPanelState,
  contentWidth: number,
  options: BtwPanelRenderOptions,
): string[] {
  const toolRegistry = options.toolRegistry ?? EMPTY_TOOL_REGISTRY;
  const externalToolStyles = options.externalToolStyles ?? EMPTY_EXTERNAL_TOOL_STYLES;
  const blocks = btw.blocks.length > 0 ? btw.blocks : legacyTextBlock(btw);
  const erroredToolCallIds = new Set(
    blocks
      .filter((block): block is Extract<Block, { type: "tool_result" }> => block.type === "tool_result" && block.isError)
      .map(block => block.toolCallId),
  );
  const rows: string[] = [];

  for (const block of blocks) {
    // Text/thinking blocks add the normal two-space assistant indent after
    // wrapping, while tool blocks account for their own prefixes internally.
    const blockWidth = block.type === "text" || block.type === "thinking"
      ? Math.max(1, contentWidth - 2)
      : contentWidth;
    const rendered = renderBlockCached(
      block,
      blockWidth,
      toolRegistry,
      externalToolStyles,
      options.showToolOutput ?? false,
      block.type === "tool_call" && erroredToolCallIds.has(block.toolCallId),
    );
    rows.push(...rendered.lines);
  }

  // Normal history surfaces terminal stream failures as a visible system notice.
  // Keep the same behavior inside the retained card rather than hiding an error
  // as soon as any partial assistant block exists.
  if (btw.phase === "error" && btw.status) {
    rows.push(...renderSystemMessage(`✗ ${btw.status}`, contentWidth, theme.error).lines);
  }
  return rows;
}

/** Grow with assistant history, then use a scrolling viewport after 20 rows. */
export function getBtwPanelPreferredHeight(
  btw: BtwPanelState,
  width: number,
  options: BtwPanelRenderOptions = {},
): number {
  if (width < 22) return 1;
  const contentWidth = Math.max(1, width - 4);
  const answerRows = renderBtwContentRows(btw, contentWidth, options).length;
  if (answerRows === 0) return 3;
  return Math.min(MAX_BTW_PANEL_HEIGHT, Math.max(4, answerRows + 2));
}

/** Render a compact-to-expanded card at the caller-provided screen position. */
export function renderBtwPanel(
  btw: BtwPanelState,
  width: number,
  height = 4,
  top = 1,
  left = 1,
  options: BtwPanelRenderOptions = {},
): BtwPanelRender | null {
  if (width <= 0 || height <= 0 || top <= 0 || left <= 0) return null;

  const panelBg = theme.appBg ?? "";
  if (width < 22 || height < 3) {
    const label = truncateToWidth(` ${cleanInline(btw.query)}`, width);
    btw.maxScroll = 0;
    btw.viewportRows = 1;
    btw.scrollOffset = 0;
    return {
      payload: moveTo(top, left) + panelBg + theme.accent + padRightToWidth(label, width) + theme.reset,
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
  const outline = theme.accent;

  const applyPanelBg = (line: string): string => {
    const persistent = line.replaceAll(theme.reset, `${theme.reset}${panelBg}`);
    return `${panelBg}${persistent}${theme.reset}`;
  };
  const contentLine = (text: string): string => applyPanelBg(
    `${outline}│${theme.reset}${panelBg} ${padVisibleRightToWidth(text, contentWidth)} ${outline}│`,
  );

  const query = cleanInline(btw.query);
  const labelBudget = Math.max(1, width - termWidth("╭─  ╮"));
  const label = truncateToWidth(query, labelBudget);
  const topLeftPlain = `╭─ ${label} `;
  const fillWidth = Math.max(0, width - termWidth(topLeftPlain) - 1);
  const topLine = `${theme.bold}${outline}╭─ ${theme.text}${label}${theme.boldOff}${outline} ${"─".repeat(fillWidth)}╮`;
  const lines: string[] = [applyPanelBg(topLine)];

  const content = renderBtwContentRows(btw, contentWidth, options);
  const wrapped = content.length > 0
    ? content
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
