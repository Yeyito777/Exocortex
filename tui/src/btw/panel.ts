/** Compact foreground panel for a conversation-owned `/btw` aside history. */

import { renderBlockCached, renderSystemMessage, renderUserMessageCached } from "../blockrenderer";
import type { Block, ExternalToolStyle, ToolDisplayInfo } from "../messages";
import { padRightToWidth, padVisibleRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { theme } from "../theme";
import type { BtwPanelState } from "./state";
import type { MessageBound, RenderLineAnchor } from "../conversation";
import type { WrapCopyLine } from "../textwrap";
import { clampCursor, contentBounds, logicalLineRange, stripAnsi } from "../historycursor";
import { renderLineWithCursor, renderLineWithSearch, renderLineWithSelection } from "../cursorrender";
import { findSearchMatches } from "../search";
import type { VimMode } from "../vim";
import { applyBtwConversationScroll } from "../conversationscroll/btw";
import { pinBottomRelativeScrollOffset } from "../viewportscroll";

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
  focused?: boolean;
  vimMode?: VimMode;
  searchQuery?: string | null;
}

const EMPTY_TOOL_REGISTRY: ToolDisplayInfo[] = [];
const EMPTY_EXTERNAL_TOOL_STYLES: ExternalToolStyle[] = [];

function cleanInline(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
}

function turnBlocks(turn: BtwPanelState["turns"][number], latest?: BtwPanelState): Block[] {
  const blocks = latest?.blocks ?? turn.blocks ?? [];
  const text = latest?.text ?? turn.text;
  return blocks.length ? blocks : text ? [{ type: "text", text }] : [];
}

interface BtwContentDocument {
  lines: string[];
  cont: boolean[];
  join: string[];
  copy: Array<WrapCopyLine | null>;
  messageBounds: MessageBound[];
  lineAnchors: RenderLineAnchor[];
  finalTextRows: { start: number; end: number } | null;
}

/** Render BTW blocks through the ordinary assistant-history block renderer. */
function renderBtwContent(
  btw: BtwPanelState,
  contentWidth: number,
  options: BtwPanelRenderOptions,
): BtwContentDocument {
  const toolRegistry = options.toolRegistry ?? EMPTY_TOOL_REGISTRY;
  const externalToolStyles = options.externalToolStyles ?? EMPTY_EXTERNAL_TOOL_STYLES;
  const rows: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const copy: Array<WrapCopyLine | null> = [];
  const lineAnchors: RenderLineAnchor[] = [];
  const messageBounds: MessageBound[] = [];
  let finalTextRows: { start: number; end: number } | null = null;

  const pushRendered = (
    owner: object,
    segment: RenderLineAnchor["segment"],
    rendered: { lines: string[]; cont: boolean[]; join: string[]; copy?: Array<WrapCopyLine | null> },
  ) => {
    let logicalIndex = -1;
    let subIndex = 0;
    for (let index = 0; index < rendered.lines.length; index++) {
      if (index === 0 || !rendered.cont[index]) {
        logicalIndex++;
        subIndex = 0;
      } else {
        subIndex++;
      }
      rows.push(rendered.lines[index]);
      cont.push(rendered.cont[index]);
      join.push(rendered.join[index]);
      copy.push(rendered.copy?.[index] ?? null);
      lineAnchors.push({ owner, segment, index: logicalIndex, subIndex });
    }
  };
  const pushBlank = (owner: object, segment: RenderLineAnchor["segment"]) => {
    rows.push("");
    cont.push(false);
    join.push("");
    copy.push(null);
    lineAnchors.push({ owner, segment, index: 0, subIndex: 0 });
  };

  for (let turnIndex = 0; turnIndex < btw.turns.length; turnIndex++) {
    const turn = btw.turns[turnIndex];
    if (turnIndex > 0) {
      const userStart = rows.length;
      pushBlank(turn, "user_margin_top");
      const userContentStart = rows.length;
      pushRendered(turn, "user_content", renderUserMessageCached(turn, turn.query, contentWidth));
      const userContentEnd = rows.length;
      pushBlank(turn, "user_margin_bottom");
      messageBounds.push({ role: "user", start: userStart, end: rows.length, contentStart: userContentStart, contentEnd: userContentEnd });
    }

    const latest = turnIndex === btw.turns.length - 1 ? btw : undefined;
    const blocks = turnBlocks(turn, latest);
    const erroredToolCallIds = new Set(
      blocks
        .filter((block): block is Extract<Block, { type: "tool_result" }> => block.type === "tool_result" && block.isError)
        .map(block => block.toolCallId),
    );
    const assistantStart = rows.length;
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
      const blockStart = rows.length;
      pushRendered(block, "assistant_block", rendered);
      if (turnIndex === btw.turns.length - 1 && block === blocks.at(-1) && block.type === "text" && rows.length > blockStart) {
        finalTextRows = { start: blockStart, end: rows.length };
      }
    }

    // A follow-up's user bubble should remain visible while its first assistant
    // block has not arrived. The original turn keeps the compact legacy fallback.
    if (turnIndex > 0 && blocks.length === 0 && turn.phase !== "error") {
      const pending = renderSystemMessage(turn.status || "Thinking…", contentWidth, theme.muted);
      pushRendered(turn, "system_message", pending);
    }

    if (rows.length > assistantStart) {
      messageBounds.push({
        role: "assistant",
        start: assistantStart,
        end: rows.length,
        contentStart: assistantStart,
        contentEnd: rows.length,
      });
    }
    if (turn.phase === "error" && turn.status) {
      const errorStart = rows.length;
      const error = renderSystemMessage(`✗ ${turn.status}`, contentWidth, theme.error);
      pushRendered(turn, "system_message", error);
      messageBounds.push({
        role: "system",
        start: errorStart,
        end: rows.length,
        contentStart: errorStart,
        contentEnd: rows.length,
      });
    }
  }

  return { lines: rows, cont, join, copy, messageBounds, lineAnchors, finalTextRows };
}

/** Grow with assistant history, then use a scrolling viewport after 20 rows. */
export function getBtwPanelPreferredHeight(
  btw: BtwPanelState,
  width: number,
  options: BtwPanelRenderOptions = {},
): number {
  if (width < 22) return 1;
  const contentWidth = Math.max(1, width - 4);
  const answerRows = renderBtwContent(btw, contentWidth, options).lines.length;
  if (answerRows === 0) return 3;
  return Math.min(MAX_BTW_PANEL_HEIGHT, answerRows + 2);
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
    const label = truncateToWidth(` ${cleanInline(btw.turns[0]?.query ?? btw.query)}`, width);
    btw.maxScroll = 0;
    btw.viewportRows = 1;
    btw.scrollOffset = 0;
    btw.streamingResponseAutoscroll = null;
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

  const query = cleanInline(btw.turns[0]?.query ?? btw.query);
  const labelBudget = Math.max(1, width - termWidth("╭─  ╮"));
  const label = truncateToWidth(query, labelBudget);
  const topLeftPlain = `╭─ ${label} `;
  const fillWidth = Math.max(0, width - termWidth(topLeftPlain) - 1);
  const topLine = `${theme.bold}${outline}╭─ ${theme.text}${label}${theme.boldOff}${outline} ${"─".repeat(fillWidth)}╮`;
  const lines: string[] = [applyPanelBg(topLine)];

  const document = renderBtwContent(btw, contentWidth, options);
  const wrapped = document.lines.length > 0
    ? document.lines
    : [`${theme.muted}${truncateToWidth(btw.phase === "error" ? "No answer was produced." : btw.status || "Thinking…", contentWidth)}${theme.reset}${panelBg}`];
  const previousTotal = btw.historyLines.length;
  const previousScrollOffset = btw.scrollOffset;
  btw.historyLines = wrapped;
  btw.historyWrapContinuation = document.lines.length > 0 ? document.cont : [false];
  btw.historyWrapJoiners = document.lines.length > 0 ? document.join : [""];
  btw.historyCopyLines = document.lines.length > 0 ? document.copy : [null];
  btw.historyMessageBounds = document.messageBounds;
  btw.historyLineAnchors = document.lineAnchors;
  const maxScroll = Math.max(0, wrapped.length - contentRows);
  btw.maxScroll = maxScroll;
  btw.viewportRows = contentRows;
  btw.scrollOffset = pinBottomRelativeScrollOffset(btw.scrollOffset, previousTotal, wrapped.length);
  btw.scrollOffset = Math.max(0, Math.min(btw.scrollOffset, maxScroll));
  applyBtwConversationScroll(
    btw,
    document.finalTextRows,
    previousScrollOffset,
    wrapped.length,
    contentRows,
    maxScroll,
  );
  btw.historyCursor = clampCursor(btw.historyCursor, wrapped);
  const start = Math.max(0, wrapped.length - contentRows - btw.scrollOffset);
  const visible = wrapped.slice(start, start + contentRows).map((line, visibleIndex) => {
    const row = start + visibleIndex;
    const cursor = btw.historyCursor;
    const anchor = btw.historyVisualAnchor;
    const inVisual = options.focused && (options.vimMode === "visual" || options.vimMode === "visual-line");
    let rendered = line;
    if (inVisual) {
      let startRow = Math.min(anchor.row, cursor.row);
      let endRow = Math.max(anchor.row, cursor.row);
      if (options.vimMode === "visual-line") {
        startRow = logicalLineRange(startRow, btw.historyWrapContinuation).first;
        endRow = logicalLineRange(endRow, btw.historyWrapContinuation).last;
      }
      if (row >= startRow && row <= endRow) {
        const bounds = contentBounds(stripAnsi(line));
        let from = bounds.start;
        let to = bounds.end;
        if (options.vimMode !== "visual-line") {
          if (startRow === endRow) {
            from = Math.min(anchor.col, cursor.col);
            to = Math.max(anchor.col, cursor.col);
          } else if (row === startRow) {
            from = anchor.row <= cursor.row ? anchor.col : cursor.col;
          } else if (row === endRow) {
            to = anchor.row <= cursor.row ? cursor.col : anchor.col;
          }
        }
        rendered = renderLineWithSelection(rendered, from, to);
      }
    }
    if (options.searchQuery) {
      const matches = findSearchMatches(stripAnsi(line), options.searchQuery);
      if (matches.length > 0) rendered = renderLineWithSearch(rendered, matches);
    }
    if (options.focused && row === cursor.row) rendered = renderLineWithCursor(rendered, cursor.col);
    return rendered;
  });
  for (let i = 0; i < contentRows; i++) lines.push(contentLine(visible[i] ?? ""));

  lines.push(applyPanelBg(`${outline}╰${"─".repeat(innerWidth)}╯`));

  let payload = "";
  for (let index = 0; index < lines.length; index++) {
    payload += moveTo(top + index, left) + lines[index];
  }
  return { payload, width, height: panelHeight, top, left };
}
