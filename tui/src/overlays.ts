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
import { padVisibleRightToWidth, termWidth, truncateToWidth } from "./textwidth";
import { computeEditMessageOverlayLayout, EDIT_MESSAGE_TITLE } from "./editmessage-layout";

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
 * content lines. Used by both the queue-prompt and edit-message overlays.
 */
function renderBoxOverlay(params: BoxOverlayParams): string {
  const { lines, innerWidth, chatCol, chatW, sepRow, boxTop, scrollIndicators } = params;
  const boxWidth = innerWidth + 2;
  const boxLeft = chatCol + Math.floor((chatW - boxWidth) / 2);

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
    result += padVisibleRightToWidth(entry.text, innerWidth);
    result += `${theme.reset}${theme.sidebarBg}${theme.accent}│${theme.reset}`;
  }

  // Scroll indicators
  if (scrollIndicators) {
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

  return result;
}

// ── Queue prompt overlay ──────────────────────────────────────────

export function renderQueuePromptOverlay(
  qp: QueuePromptState,
  chatW: number,
  chatCol: number,
  sepRow: number,
): string {
  // Preview of the message being queued (truncated)
  const previewSource = qp.text.replace(/\n/g, " ");
  const previewLabel = truncateToWidth(previewSource, 40);

  // Image badge lines (e.g. "📎 PNG (93.1 KB)")
  const imageBadges: string[] = [];
  if (qp.images?.length) {
    for (const img of qp.images) {
      imageBadges.push(`📎 ${imageLabel(img.mediaType)} (${formatSize(img.sizeBytes)})`);
    }
  }

  // Box content lines (plain text)
  const titleLine = "Queue message:";
  const msgLine = `"${previewLabel}"`;
  const optLine1 = `${qp.selection === "message-end" ? "▸ " : "  "}message end`;
  const optLine2 = `${qp.selection === "next-turn" ? "▸ " : "  "}next turn`;
  const rawLines = [titleLine, msgLine, ...imageBadges, "", optLine1, optLine2];
  const innerWidth = Math.min(
    Math.max(...rawLines.map((line) => termWidth(line))) + 4,
    chatW - 4,
  );

  // Indices of the two option lines (always the last two)
  const opt1Idx = rawLines.length - 2; // "message end"
  const opt2Idx = rawLines.length - 1; // "next turn"

  // Build styled lines
  const styledLines: BoxOverlayLine[] = rawLines.map((line, i) => {
    let fg = theme.muted;
    let bg = theme.sidebarBg;
    if (i === 0) fg = theme.text;    // title
    if (i === 1) fg = theme.muted;   // preview

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

export function renderEditMessageOverlay(
  em: EditMessageState,
  chatW: number,
  chatCol: number,
  sepRow: number,
  messageAreaHeight: number,
): string {
  const layout = computeEditMessageOverlayLayout(em, chatW, chatCol, sepRow, messageAreaHeight);
  if (!layout) return "";
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

  return renderBoxOverlay({
    lines: styledLines,
    innerWidth: layout.innerWidth,
    chatCol,
    chatW,
    sepRow,
    boxTop: layout.boxTop,
    scrollIndicators,
  });
}
