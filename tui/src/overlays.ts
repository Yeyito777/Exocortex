/**
 * Modal overlay renderers.
 *
 * Renders the queue-prompt and edit-message box overlays that float
 * over the message area. Uses a shared box-drawing helper so both
 * overlays have identical chrome (borders, padding, scroll indicators).
 *
 * Pure rendering — takes data, returns ANSI strings. No state mutation.
 */

import type { QueuePromptState, EditMessageState } from "./state";
import { theme } from "./theme";
import { formatSize, imageLabel } from "./clipboard";
import { padRightToWidth, termWidth, truncateToWidth } from "./textwidth";
import { computeEditMessageOverlayLayout, EDIT_MESSAGE_TITLE } from "./editmessage-layout";
import type { ScreenRect } from "./historyimages";

// ── ANSI positioning ──────────────────────────────────────────────

const ESC = "\x1b[";
const move_to = (row: number, col: number) => `${ESC}${row};${col}H`;

// ── Types ─────────────────────────────────────────────────────────

/** A single line inside a box overlay, with its styling info. */
interface BoxOverlayLine {
  /** Text to display (may be empty for blank lines). */
  text: string;
  /** Foreground ANSI escape. */
  fg: string;
  /** Background ANSI escape. */
  bg: string;
}

/** Parameters for the shared box overlay renderer. */
interface BoxOverlayParams {
  /** Styled content lines to draw inside the box. */
  lines: BoxOverlayLine[];
  /** Inner width of the box (excluding the │ borders). */
  innerWidth: number;
  /** 1-based column where the chat area starts. */
  chatCol: number;
  /** Total width available for the chat area. */
  chatW: number;
  /** Screen row below which we must not draw (the input separator row). */
  sepRow: number;
  /** Top row of the box (1-based). */
  boxTop: number;
  /** Optional scroll indicators: { upRow, downRow } (1-based screen rows). */
  scrollIndicators?: { upRow?: number; downRow?: number };
}

// ── Shared box renderer ───────────────────────────────────────────

/**
 * Render a centered box overlay with top/bottom borders and styled
 * content lines, returning the ANSI payload and the screen box it draws on. Used by both the queue-prompt and edit-message overlays.
 *
 * The box never extends past the chat area: the inner width is clamped to
 * it, and each line is cut to the inner width (with "…") so the right border
 * always lands on its column.
 */
function renderBoxOverlay(params: BoxOverlayParams): { payload: string; rect: ScreenRect } {
  const { lines, chatCol, chatW, sepRow, boxTop, scrollIndicators } = params;
  const innerWidth = Math.max(0, Math.min(params.innerWidth, chatW - 2));
  const boxWidth = innerWidth + 2;
  const boxLeft = chatCol + Math.max(0, Math.floor((chatW - boxWidth) / 2));
  if (chatW < boxWidth) {
    return { payload: "", rect: { top: boxTop, bottom: boxTop, left: chatCol, right: chatCol } };
  }

  let result = "";

  // Top border
  result += move_to(boxTop, boxLeft);
  result += `${theme.sidebarBg}${theme.accent}┌${"─".repeat(innerWidth)}┐${theme.reset}`;

  // Content lines
  for (let i = 0; i < lines.length; i++) {
    const row = boxTop + 1 + i;
    if (row >= sepRow) break; // don't overlap input area
    const entry = lines[i];

    result += move_to(row, boxLeft);
    result += `${theme.sidebarBg}${theme.accent}│${entry.bg}${entry.fg}`;
    result += padRightToWidth(entry.text, innerWidth);
    result += `${theme.reset}${theme.sidebarBg}${theme.accent}│${theme.reset}`;
  }

  // Scroll indicators (two cells at the right edge of the content)
  if (scrollIndicators && innerWidth >= 2) {
    if (scrollIndicators.upRow !== undefined) {
      result += move_to(scrollIndicators.upRow, boxLeft + boxWidth - 3);
      result += `${theme.sidebarBg}${theme.dim} ▲${theme.reset}`;
    }
    if (scrollIndicators.downRow !== undefined) {
      result += move_to(scrollIndicators.downRow, boxLeft + boxWidth - 3);
      result += `${theme.sidebarBg}${theme.dim} ▼${theme.reset}`;
    }
  }

  // Bottom border
  const bottomRow = boxTop + 1 + lines.length;
  if (bottomRow < sepRow) {
    result += move_to(bottomRow, boxLeft);
    result += `${theme.sidebarBg}${theme.accent}└${"─".repeat(innerWidth)}┘${theme.reset}`;
  }

  return {
    payload: result,
    // Last row drawn: the bottom border, or the last content row when the input area cuts the box off.
    rect: { top: boxTop, bottom: Math.min(bottomRow, sepRow - 1), left: boxLeft, right: boxLeft + boxWidth - 1 },
  };
}

// ── Queue prompt overlay ──────────────────────────────────────────

const QUEUE_PROMPT_TITLE = "Queue message:";
const QUEUE_PROMPT_SHORT_TITLE = "Queue:";
/** Widest the quoted preview gets, however wide the terminal. */
const QUEUE_PROMPT_PREVIEW_MAX_WIDTH = 40;
/** Below this many cells the preview says too little to show at all. */
const QUEUE_PROMPT_PREVIEW_MIN_WIDTH = 8;
/** Narrower chat areas give up the box's side margins to keep room for the text. */
const QUEUE_PROMPT_MARGIN_MIN_WIDTH = 20;

/** The queue prompt's ANSI payload and the screen box it draws on (images are cropped around it). */
export function renderQueuePromptOverlay(
  qp: QueuePromptState,
  chatW: number,
  chatCol: number,
  sepRow: number,
  steersInstantly = true,
): { payload: string; rect: ScreenRect } {
  // Widest the content may get: the chat area minus a column of margin each
  // side, or all of it when the area is too narrow to spare the margins.
  const maxInnerWidth = Math.max(0, chatW - (chatW >= QUEUE_PROMPT_MARGIN_MIN_WIDTH ? 4 : 2));

  // Preview of the message being queued, cut to fit the box with its quotes.
  // When too little of it would show, it goes first, before the options do.
  const previewWidth = Math.min(QUEUE_PROMPT_PREVIEW_MAX_WIDTH, maxInnerWidth - 3);
  const previewSource = qp.text.replace(/\n/g, " ");
  const msgLines = previewWidth >= QUEUE_PROMPT_PREVIEW_MIN_WIDTH
    ? [`"${truncateToWidth(previewSource, previewWidth)}"`]
    : [];

  // Image badge lines (e.g. "📎 PNG (93.1 KB)")
  const imageBadges: string[] = [];
  if (qp.images?.length) {
    for (const img of qp.images) {
      imageBadges.push(`📎 ${imageLabel(img.mediaType)} (${formatSize(img.sizeBytes)})`);
    }
  }

  // Box content lines (plain text; the box cuts any still too wide with "…")
  const titleLine = termWidth(QUEUE_PROMPT_TITLE) <= maxInnerWidth ? QUEUE_PROMPT_TITLE : QUEUE_PROMPT_SHORT_TITLE;
  const optLine1 = `${qp.selection === "message-end" ? "▸ " : "  "}message end`;
  const optLine2 = `${qp.selection === "next-turn" ? "▸ " : "  "}${steersInstantly ? "steer now" : "next turn"}`;
  const rawLines = [titleLine, ...msgLines, ...imageBadges, "", optLine1, optLine2];
  const innerWidth = Math.min(
    Math.max(...rawLines.map((line) => termWidth(line))) + 4,
    maxInnerWidth,
  );

  // Indices of the two option lines (always the last two)
  const opt1Idx = rawLines.length - 2; // "message end"
  const opt2Idx = rawLines.length - 1; // "steer now" / "next turn"

  // Build styled lines
  const styledLines: BoxOverlayLine[] = rawLines.map((line, i) => {
    let fg = theme.muted;
    let bg = theme.sidebarBg;
    if (i === 0) fg = theme.text;    // title

    if (i === opt1Idx || i === opt2Idx) {
      // Options
      const isSelected = (i === opt1Idx && qp.selection === "message-end") ||
                         (i === opt2Idx && qp.selection === "next-turn");
      if (isSelected) {
        bg = theme.sidebarSelBg;
        fg = theme.accent;
      } else {
        fg = theme.text;
      }
    }
    return { text: line, fg, bg };
  });

  const boxTop = Math.max(3, sepRow - rawLines.length - 2);

  return renderBoxOverlay({
    lines: styledLines,
    innerWidth,
    chatCol,
    chatW,
    sepRow,
    boxTop,
  });
}

// ── Edit message overlay ──────────────────────────────────────────

/** The edit menu's ANSI payload and the screen box it draws on (images are cropped around it). */
export function renderEditMessageOverlay(
  em: EditMessageState,
  chatW: number,
  chatCol: number,
  sepRow: number,
  messageAreaHeight: number,
): { payload: string; rect: ScreenRect | null } {
  const layout = computeEditMessageOverlayLayout(em, chatW, chatCol, sepRow, messageAreaHeight);
  if (!layout) return { payload: "", rect: null };
  em.scrollOffset = layout.scrollStart;

  // Build styled lines: title, blank, visible items
  const styledLines: BoxOverlayLine[] = [];
  styledLines.push({ text: EDIT_MESSAGE_TITLE, fg: theme.text, bg: theme.sidebarBg });
  styledLines.push({ text: "", fg: theme.text, bg: theme.sidebarBg });
  for (let vi = 0; vi < layout.maxVisible; vi++) {
    const i = layout.scrollStart + vi;
    const marker = em.selection === i ? "▸ " : "  ";
    const isSelected = i === em.selection;
    const isQueued = em.items[i]?.isQueued;
    let fg: string;
    let bg: string;
    if (isSelected) {
      bg = theme.sidebarSelBg;
      fg = isQueued ? theme.muted : theme.accent;
    } else {
      bg = theme.sidebarBg;
      fg = isQueued ? theme.muted : theme.text;
    }
    styledLines.push({ text: marker + layout.previews[i], fg, bg });
  }

  // Scroll indicators
  const scrollIndicators: { upRow?: number; downRow?: number } = {};
  if (layout.scrollStart > 0) {
    scrollIndicators.upRow = layout.firstItemRow;
  }
  if (layout.scrollStart + layout.maxVisible < em.items.length) {
    scrollIndicators.downRow = layout.firstItemRow + layout.maxVisible - 1;
  }

  const { payload } = renderBoxOverlay({
    lines: styledLines,
    innerWidth: layout.innerWidth,
    chatCol,
    chatW,
    sepRow,
    boxTop: layout.boxTop,
    scrollIndicators,
  });
  return {
    payload,
    rect: { top: layout.boxTop, bottom: layout.boxBottom, left: layout.boxLeft, right: layout.boxLeft + layout.boxWidth - 1 },
  };
}
