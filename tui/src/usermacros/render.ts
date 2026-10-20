/**
 * The /macro help panel drawn above the prompt in place of the autocomplete
 * popup: the syntax with the current part lit, what that part is for, any
 * Tab completions, a preview of the macro, and what Enter will do.
 */
import type { SlashCompletion } from "../slashsearch";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { theme } from "../theme";
import type { MacroGuide, MacroPreviewLine } from "./guide";

const UNDERLINE = "\x1b[4m";

function clean(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "");
}

/** `text` padded or cut to `width` columns, in `color`, on the panel background. */
function cell(text: string, width: number, color: string): string {
  return color + padRightToWidth(clean(text), width) + theme.reset + theme.sidebarBg;
}

function syntaxRow(guide: MacroGuide, width: number): string {
  let out = " ";
  let used = 1;
  for (const [index, segment] of guide.syntax.entries()) {
    const text = (index > 0 ? " " : "") + segment.text;
    if (used + termWidth(text) > width) break;
    const style = segment.wrong
      ? theme.error + theme.bold + UNDERLINE
      : segment.active
        ? theme.accent + theme.bold + UNDERLINE
        : segment.optional ? theme.muted + theme.italic : theme.muted;
    out += (index > 0 ? " " : "") + style + segment.text + theme.reset + theme.sidebarBg;
    used += termWidth(text);
  }
  return out + " ".repeat(Math.max(0, width - used));
}

function previewRow(line: MacroPreviewLine, width: number): string {
  const labelColor = line.tone === "new" ? theme.success : line.tone === "removed" ? theme.error : theme.muted;
  const textColor = line.tone === "old" ? theme.muted : theme.text;
  const label = `   ${line.label} → `;
  const labelWidth = Math.min(width, termWidth(label));
  return cell(label, labelWidth, labelColor) + cell(line.text, width - labelWidth, textColor);
}

function completionRow(match: SlashCompletion, selected: boolean, nameWidth: number, width: number): string {
  const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
  const marker = selected ? " ▸ " : "   ";
  const name = padRightToWidth(clean(match.name), nameWidth);
  const descWidth = Math.max(0, width - 3 - nameWidth - 2);
  return bg + theme.accent + marker + theme.text + name + "  " + theme.muted + padRightToWidth(clean(match.desc), descWidth) + theme.reset + theme.sidebarBg;
}

/**
 * The panel's rows, top to bottom, each exactly `width` columns on the panel
 * background. At most `maxRows`: completions are cut first, then preview lines.
 */
export function renderMacroGuideRows(
  guide: MacroGuide,
  completions: readonly SlashCompletion[],
  selection: number,
  width: number,
  maxRows: number,
): string[] {
  if (width < 12 || maxRows < 1) return [];
  const statusColor = guide.status.tone === "error" ? theme.error : guide.status.tone === "ready" ? theme.accent : theme.muted;
  const statusText = guide.status.tone === "ready" ? `↵ ${guide.status.text}` : guide.status.text;
  const fixed = [
    syntaxRow(guide, width),
    cell(` ${guide.hint}`, width, theme.text),
  ];
  const status = cell(` ${statusText}`, width, statusColor);
  let room = Math.max(0, maxRows - fixed.length - 1);
  const preview = guide.preview.slice(0, room).map(line => previewRow(line, width));
  room -= preview.length;

  // A window of completions that keeps the selection visible.
  const shown = Math.min(completions.length, room);
  let start = 0;
  if (selection >= shown) start = selection - shown + 1;
  const visible = completions.slice(start, start + shown);
  const nameWidth = Math.min(Math.floor(width / 3), Math.max(0, ...visible.map(match => termWidth(clean(match.name)))));
  const rows = [
    ...fixed,
    ...visible.map((match, index) => completionRow(match, start + index === selection, nameWidth, width)),
    ...preview,
    status,
  ];
  return rows.slice(-maxRows).map(row => theme.sidebarBg + row + theme.reset);
}

/** Ghost text that fits after `usedCols` columns of a `width`-column prompt line. */
export function fitGhostText(ghost: string, usedCols: number, width: number): string {
  const room = width - usedCols - 1;
  if (!ghost || room < 2) return "";
  return theme.dim + theme.italic + truncateToWidth(clean(ghost), room) + theme.italicOff + theme.reset;
}
