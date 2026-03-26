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
import { stripAnsi } from "./historycursor";
import { formatSize, imageLabel } from "./clipboard";

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
    const padRight = Math.max(0, innerWidth - stripAnsi(entry.text).length);

    result += move_to(row, boxLeft);
    result += `${theme.sidebarBg}${theme.accent}│${entry.bg}${entry.fg}`;
    result += `${entry.text}${" ".repeat(padRight)}`;
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
  const preview = qp.text.replace(/\n/g, " ").slice(0, 40);
  const previewLabel = preview.length < qp.text.replace(/\n/g, " ").length ? preview + "…" : preview;

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
    Math.max(...rawLines.map(l => l.length)) + 4,
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
  const titleLine = "Edit message:";

  // Build display lines: truncated previews of each item
  const maxPreviewLen = Math.min(50, chatW - 12);
  const previews = em.items.map((item) => {
    const raw = item.text.replace(/\n/g, " ");
    return raw.length > maxPreviewLen ? raw.slice(0, maxPreviewLen) + "…" : raw;
  });
  const maxContentLen = Math.max(
    titleLine.length,
    ...previews.map(p => p.length + 2), // +2 for marker "▸ "
  );
  const innerWidth = Math.min(maxContentLen + 4, chatW - 4);

  // Max visible items (leave room for title, blank line, borders)
  const maxVisible = Math.min(em.items.length, Math.max(3, messageAreaHeight - 4));

  // Scroll window to keep selection visible
  let scrollStart = em.scrollOffset;
  if (em.selection < scrollStart) scrollStart = em.selection;
  if (em.selection >= scrollStart + maxVisible) scrollStart = em.selection - maxVisible + 1;
  scrollStart = Math.max(0, Math.min(scrollStart, em.items.length - maxVisible));
  em.scrollOffset = scrollStart;

  // Build styled lines: title, blank, visible items
  const styledLines: BoxOverlayLine[] = [];
  styledLines.push({ text: titleLine, fg: theme.text, bg: theme.sidebarBg });
  styledLines.push({ text: "", fg: theme.text, bg: theme.sidebarBg });
  for (let vi = 0; vi < maxVisible; vi++) {
    const i = scrollStart + vi;
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
    styledLines.push({ text: marker + previews[i], fg, bg });
  }

  const boxTop = Math.max(3, sepRow - styledLines.length - 2);

  // Scroll indicators
  const scrollIndicators: { upRow?: number; downRow?: number } = {};
  if (scrollStart > 0) {
    scrollIndicators.upRow = boxTop + 3; // first item row
  }
  if (scrollStart + maxVisible < em.items.length) {
    scrollIndicators.downRow = boxTop + 2 + maxVisible; // last item row
  }

  return renderBoxOverlay({
    lines: styledLines,
    innerWidth,
    chatCol,
    chatW,
    sepRow,
    boxTop,
    scrollIndicators,
  });
}
