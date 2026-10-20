/**
 * The /macro panel drawn above the prompt in place of the autocomplete popup:
 * the syntax with the current part lit, then the error, the Tab completions,
 * or what the macro expands to.
 */
import type { SlashCompletion } from "../slashsearch";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { theme } from "../theme";
import type { MacroGuide, MacroGuideDetail } from "./guide";

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

function detailRow(detail: MacroGuideDetail, width: number): string {
  if (detail.kind === "error") return cell(` ✗ ${detail.text}`, width, theme.error);
  if (detail.kind === "note") return cell(` ${detail.text}`, width, theme.muted);
  const labelColor = detail.tone === "new" ? theme.success : theme.error;
  const label = `   ${detail.label} → `;
  const labelWidth = Math.min(width, termWidth(label));
  return cell(label, labelWidth, labelColor) + cell(detail.text, width - labelWidth, theme.text);
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
 * background: the syntax, then an error, the completions (at most
 * `maxRows - 1`, keeping the selection visible) or the detail row.
 */
export function renderMacroGuideRows(
  guide: MacroGuide,
  completions: readonly SlashCompletion[],
  selection: number,
  width: number,
  maxRows: number,
): string[] {
  if (width < 12 || maxRows < 1) return [];
  const rows = [syntaxRow(guide, width)];
  const room = maxRows - 1;
  if (guide.detail?.kind === "error" || (guide.detail && completions.length === 0)) {
    if (room > 0) rows.push(detailRow(guide.detail, width));
  } else if (completions.length > 0 && room > 0) {
    const shown = Math.min(completions.length, room);
    const start = selection >= shown ? selection - shown + 1 : 0;
    const visible = completions.slice(start, start + shown);
    const nameWidth = Math.min(Math.floor(width / 3), Math.max(0, ...visible.map(match => termWidth(clean(match.name)))));
    rows.push(...visible.map((match, index) => completionRow(match, start + index === selection, nameWidth, width)));
  }
  return rows.map(row => theme.sidebarBg + row + theme.reset);
}

/** Ghost text that fits after `usedCols` columns of a `width`-column prompt line. */
export function fitGhostText(ghost: string, usedCols: number, width: number): string {
  const room = width - usedCols - 1;
  if (!ghost || room < 2) return "";
  return theme.dim + theme.italic + truncateToWidth(clean(ghost), room) + theme.italicOff + theme.reset;
}
