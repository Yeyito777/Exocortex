/**
 * The /macro panel drawn above the prompt in place of the autocomplete popup:
 * the syntax with the current part lit, then the error, the Tab completions,
 * or what the macro expands to.
 */
import type { SlashCompletion } from "../slashsearch";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { theme } from "../theme";
import type { MacroGuide, MacroGuideDetail } from "./guide";
import { macroStyle, type MacroStyle } from "./styles";

function clean(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "");
}

/** `text` padded or cut to `width` columns, in `color`, on the panel background. */
function cell(text: string, width: number, color: string): string {
  return color + padRightToWidth(clean(text), width) + theme.reset + theme.sidebarBg;
}

function syntaxRow(guide: MacroGuide, width: number, style: MacroStyle): string {
  let out = " ";
  let used = 1;
  for (const [index, segment] of guide.syntax.entries()) {
    const text = (index > 0 ? " " : "") + segment.text;
    if (used + termWidth(text) > width) break;
    const color = style.syntaxColor(segment);
    out += (index > 0 ? " " : "") + color + segment.text + theme.reset + theme.sidebarBg;
    used += termWidth(text);
  }
  return out + " ".repeat(Math.max(0, width - used));
}

function detailRow(detail: MacroGuideDetail, width: number, style: MacroStyle): string {
  if (detail.kind === "error") return cell(` ✗ ${detail.text}`, width, theme.error);
  if (detail.kind === "note") return cell(` ${detail.text}`, width, theme.muted);
  const label = `   ${detail.label} → `;
  const labelWidth = Math.min(width, termWidth(label));
  return cell(label, labelWidth, style.previewLabelColor(detail)) + cell(detail.text, width - labelWidth, style.previewTextColor);
}

function completionRow(match: SlashCompletion, selected: boolean, nameWidth: number, width: number, style: MacroStyle): string {
  const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
  const marker = selected ? " ▸ " : "   ";
  const name = padRightToWidth(clean(match.name), nameWidth);
  const descWidth = Math.max(0, width - 3 - nameWidth - 2);
  return bg + style.markerColor + marker + theme.text + name + "  " + theme.muted + padRightToWidth(clean(match.desc), descWidth) + theme.reset + theme.sidebarBg;
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
  style: MacroStyle = macroStyle(),
): string[] {
  if (width < 12 || maxRows < 1) return [];
  const rows = [syntaxRow(guide, width, style)];
  const room = maxRows - 1;
  if (guide.detail?.kind === "error" || (guide.detail && completions.length === 0)) {
    if (room > 0) rows.push(detailRow(guide.detail, width, style));
  } else if (completions.length > 0 && room > 0) {
    const shown = Math.min(completions.length, room);
    const start = selection >= shown ? selection - shown + 1 : 0;
    const visible = completions.slice(start, start + shown);
    const nameWidth = Math.min(Math.floor(width / 3), Math.max(0, ...visible.map(match => termWidth(clean(match.name)))));
    rows.push(...visible.map((match, index) => completionRow(match, start + index === selection, nameWidth, width, style)));
  }
  return rows.map(row => theme.sidebarBg + row + theme.reset);
}

/** Ghost text that fits after `usedCols` columns of a `width`-column prompt line. */
export function fitGhostText(ghost: string, usedCols: number, width: number, color = theme.dim + theme.italic): string {
  const room = width - usedCols - 1;
  if (!ghost || room < 2) return "";
  return color + truncateToWidth(clean(ghost), room) + theme.reset;
}
