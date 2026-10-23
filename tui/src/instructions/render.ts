/**
 * Instructions modal rendering: the scope picker and the editor, each a card
 * centred over the whole screen in the Accounts screen's chrome (rounded
 * accent border, title in the top edge, keys in the bottom edge). Sized to
 * the terminal on every frame, so a resize just reflows them.
 */

import type { ScreenRect } from "../historyimages";
import { moveTo } from "../frame";
import { theme } from "../theme";
import { termWidth, truncateToWidth } from "../textwidth";
import { nextGraphemeEnd } from "../graphemes";
import { getInputLines } from "../promptline";
import { sanitizePromptTextForInsertion } from "../prompttext";
import {
  INSTRUCTION_SCOPES,
  isInstructionsEditorDirty,
  scopeAvailable,
  scopeLabel,
  scopeReach,
  summarizeInstructions,
  type InstructionsEditorState,
  type InstructionsModalState,
  type InstructionsNoticeTone,
  type InstructionsPickerState,
} from "./state";
import { shortSource, type ToolLineStyle, type ToolSection } from "./tools";

export interface RenderedInstructionsModal {
  payload: string;
  rect: ScreenRect;
  /** Hardware cursor for the editor (1-based screen cell and shape), or null to hide it. */
  cursor: { row: number; col: number; shape: "bar" | "block" | "underline" } | null;
}

/** Columns kept clear on each side of a card. */
const MARGIN = 2;
/** Border plus two columns of padding on each side. */
const SIDE = 6;

function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function pad(width: number): string {
  return " ".repeat(Math.max(0, width));
}

/** `╭─ title ──── right ─╮`-style edge with optional text at both ends. */
function edge(corners: [string, string], width: number, left: string, right: string, leftColor: string, rightColor = theme.muted): string {
  const inner = width - 2;
  const framed = (text: string) => text ? termWidth(text) + 3 : 0;
  const rightText = framed(left) + framed(right) <= inner ? right : "";
  const leftText = truncateToWidth(left, Math.max(0, inner - framed(rightText) - 3));
  const fill = "─".repeat(Math.max(0, inner - framed(leftText) - framed(rightText)));
  const border = theme.accent;
  const bg = theme.sidebarBg;
  return bg + border + corners[0]
    + (leftText ? `─ ${leftColor}${leftText}${theme.reset}${bg}${theme.boldOff}${border} ` : "")
    + fill
    + (rightText ? ` ${rightColor}${rightText}${theme.reset}${bg}${border} ─` : "")
    + corners[1] + theme.reset;
}

/** One body row: `│  content  │`, content already exactly `inner` columns wide. */
function bodyRow(content: string, rowBg = theme.sidebarBg): string {
  const bg = theme.sidebarBg;
  return bg + theme.accent + "│ " + rowBg + " " + content + theme.reset + rowBg + " " + bg + theme.accent + " │" + theme.reset;
}

/** `left` and right-aligned `right` in exactly `width` columns; `right` drops first when tight. */
function spread(left: string, leftColor: string, right: string, rightColor: string, width: number, bg: string): string {
  const leftText = truncateToWidth(clean(left), width);
  const room = width - termWidth(leftText);
  const rightText = right && termWidth(right) + 2 <= room ? right : "";
  return leftColor + leftText + theme.reset + bg + pad(room - termWidth(rightText)) + rightColor + rightText + theme.reset + bg;
}

function cardGeometry(totalRows: number, totalCols: number, width: number, height: number) {
  const top = Math.max(1, Math.floor((totalRows - height) / 2) + 1);
  const left = Math.max(1, Math.floor((totalCols - width) / 2) + 1);
  return { top, left };
}

// ── Picker ───────────────────────────────────────────────────────────

const PICKER_TITLE = "Instructions";

function pickerEntries(picker: InstructionsPickerState, inner: number): Array<{ text: string; bg: string }> {
  const rows: Array<{ text: string; bg: string }> = [];
  const blank = (bg = theme.sidebarBg) => ({ text: pad(inner), bg });
  rows.push(blank());
  INSTRUCTION_SCOPES.forEach((scope, index) => {
    const selected = picker.selection === index;
    const available = scopeAvailable(scope, picker.target);
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const marker = selected ? `${theme.accent}▸ ` : "  ";
    const labelColor = !available ? theme.muted : selected ? theme.accent + theme.bold : theme.text + theme.bold;
    const number = `${index + 1}`;
    const heading = spread(`${number}  ${scopeLabel(scope)}`, labelColor, scopeReach(scope, picker.target), theme.muted, inner - 2, bg);
    rows.push({ text: marker + theme.reset + bg + heading + theme.boldOff, bg });

    let detail: string;
    if (!available) {
      detail = spread("   No folder: this conversation is at the top level", theme.dim, "", "", inner - 2, bg);
    } else {
      const summary = summarizeInstructions(picker.texts[scope]);
      const failure = picker.failures[scope];
      if (failure) {
        detail = spread(`   ✗ Not saved: ${clean(failure).replace(/\.$/, "")}`, theme.error, "", "", inner - 2, bg);
      }
      else if (!summary) detail = spread("   loading…", theme.muted, "", "", inner - 2, bg);
      else if (!summary.preview) detail = spread("   empty", theme.dim + theme.italic, "", "", inner - 2, bg) + theme.italicOff;
      else {
        // Shorten the first line rather than drop the size beside it.
        const room = inner - 2 - 3 - 2 - termWidth(summary.size) - 2;
        detail = spread(`   “${truncateToWidth(clean(summary.preview), Math.max(8, room)).replace(/\s+…$/, "…")}”`, theme.text, summary.size, theme.muted, inner - 2, bg);
      }
    }
    rows.push({ text: "  " + bg + detail, bg });
    if (index < INSTRUCTION_SCOPES.length - 1) rows.push(blank());
  });
  rows.push(blank());
  if (picker.error) {
    rows.push({ text: spread(`✗ ${picker.error}`, theme.error, "", "", inner, theme.sidebarBg), bg: theme.sidebarBg });
    rows.push(blank());
  }
  return rows;
}

export function renderInstructionsPicker(picker: InstructionsPickerState, totalRows: number, totalCols: number): RenderedInstructionsModal {
  const width = Math.max(30, Math.min(76, totalCols - MARGIN * 2));
  const inner = width - SIDE;
  const entries = pickerEntries(picker, inner);
  const bodyRows = Math.max(1, Math.min(entries.length, totalRows - 2));
  const height = bodyRows + 2;
  const { top, left } = cardGeometry(totalRows, totalCols, width, height);

  let payload = moveTo(top, left) + edge(["╭", "╮"], width, PICKER_TITLE, "", theme.bold + theme.text);
  for (let i = 0; i < bodyRows; i++) {
    const entry = entries[i];
    payload += moveTo(top + 1 + i, left) + bodyRow(entry.text, entry.bg);
  }
  payload += moveTo(top + height - 1, left) + edge(["╰", "╯"], width, "", "", theme.muted);
  return { payload, rect: { top, bottom: top + height - 1, left, right: left + width - 1 }, cursor: null };
}

// ── Editor ───────────────────────────────────────────────────────────

function noticeColor(tone: InstructionsNoticeTone): string {
  switch (tone) {
    case "success": return theme.success;
    case "warning": return theme.warning;
    case "error": return theme.error;
    case "info": return theme.muted;
  }
}

function modeBadge(editor: InstructionsEditorState): { text: string; color: string } {
  if (editor.command !== null) return { text: "COMMAND", color: theme.vimNormal };
  switch (editor.vim.mode) {
    case "insert": return { text: "INSERT", color: theme.vimInsert };
    case "visual": return { text: "VISUAL", color: theme.vimVisual };
    case "visual-line": return { text: "V-LINE", color: theme.vimVisual };
    default: return { text: "NORMAL", color: theme.vimNormal };
  }
}

/** The visual selection as inclusive buffer offsets, linewise expanded. */
function selectionRange(editor: InstructionsEditorState): { start: number; end: number } | null {
  const mode = editor.vim.mode;
  if (mode !== "visual" && mode !== "visual-line") return null;
  let start = Math.min(editor.vim.visualAnchor, editor.cursor);
  let end = Math.max(editor.vim.visualAnchor, editor.cursor);
  if (mode === "visual-line") {
    const before = editor.buffer.lastIndexOf("\n", start - 1);
    start = before === -1 ? 0 : before + 1;
    const after = editor.buffer.indexOf("\n", end);
    end = after === -1 ? editor.buffer.length : after;
  } else {
    end = Math.max(end, nextGraphemeEnd(editor.buffer, end) - 1);
  }
  return { start, end };
}

/** A wrapped buffer row with the selection drawn in, padded to `width`. */
function editorLine(text: string, lineStart: number, width: number, selection: { start: number; end: number } | null, bg: string): string {
  let out = theme.text;
  let used = 0;
  let selected = false;
  for (let i = 0; i < text.length;) {
    const end = nextGraphemeEnd(text, i);
    const cluster = clean(text.slice(i, end));
    const inSelection = selection !== null && lineStart + i >= selection.start && lineStart + i <= selection.end;
    if (inSelection !== selected) {
      out += inSelection ? theme.selectionBg : theme.reset + bg + theme.text;
      selected = inSelection;
    }
    out += cluster;
    used += termWidth(cluster);
    i = end;
  }
  // A selected line break shows as one selected cell, like Vim.
  const lineBreak = lineStart + text.length;
  if (selection && lineBreak >= selection.start && lineBreak <= selection.end && used < width && text.length === 0) {
    out += theme.selectionBg + " ";
    used += 1;
  }
  return out + theme.reset + bg + pad(width - used);
}

// ── Tools view decorations ───────────────────────────────────────────

/** `…` and the end of `text`, in at most `width` columns. */
function truncateStart(text: string, width: number): string {
  const chars = [...text];
  let used = 1;
  let start = chars.length;
  while (start > 0 && used + termWidth(chars[start - 1]) <= width) used += termWidth(chars[--start]);
  return "…" + chars.slice(start).join("");
}

/** Columns before a rule's label: the label text sits where the cursor expects it. */
const RULE_LEAD = 3;

/** A section header drawn as a rule: `━━ Internal tools · 6 ━━━━` or `── exo ───── daemon/src/tools/exo.ts ──`. */
function ruleLine(section: ToolSection, width: number, bg: string): string {
  const group = section.kind === "group";
  const char = group ? "━" : "─";
  const ruleColor = group ? theme.accent : theme.muted;
  const label = truncateToWidth(clean(group ? `${section.name} · ${section.count ?? 0}` : section.name), Math.max(1, width - RULE_LEAD - 1));
  const labelColor = group ? theme.accent + theme.bold : theme.text + theme.bold;
  let used = RULE_LEAD + termWidth(label) + 1;
  let source = section.source ? clean(shortSource(section.source)) : "";
  if (source && used + termWidth(source) + 5 > width) source = "";
  const fill = Math.max(0, width - used - (source ? termWidth(source) + 4 : 0));
  return ruleColor + char.repeat(2) + " " + labelColor + label + theme.boldOff + theme.reset + bg + " "
    + ruleColor + char.repeat(fill)
    + (source ? ` ${theme.muted}${source}${theme.reset}${bg} ${ruleColor}${char.repeat(2)}` : "")
    + theme.reset + bg;
}

/** Newline offsets, to find each view row's logical line. */
function newlineOffsets(buffer: string): number[] {
  const offsets: number[] = [];
  for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n", i + 1)) offsets.push(i);
  return offsets;
}

function lineOf(newlines: number[], offset: number): number {
  let low = 0;
  let high = newlines.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (newlines[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A view row of the tools view (or the Global base), decorated by its logical line's style. */
function decoratedRow(
  lineStyles: Array<ToolLineStyle | undefined>,
  text: string,
  lineStart: number,
  line: number,
  firstRow: boolean,
  width: number,
  selection: { start: number; end: number } | null,
  bg: string,
): string {
  const style = lineStyles[line];
  if (style?.kind === "rule") return firstRow ? ruleLine(style.section, width, bg) : pad(width);
  const plain = editorLine(text, lineStart, width, selection, bg);
  if (style?.kind === "field") return theme.accent + theme.italic + plain.replace(theme.text, "") + theme.italicOff;
  if (style?.kind === "note") return theme.muted + theme.italic + plain.replace(theme.text, "") + theme.italicOff;
  return plain;
}

/** The base's rule and the one over the editable text, drawn like the tools view's tool rules. */
const BASE_RULE = { name: "Base · read-only", source: "config/system.base.md" };
const OWN_RULE = { name: "Yours", source: "config/system.md" };

/**
 * Global's read-only base, shown above the buffer: its rule, the text, a blank
 * line and the rule over the editable text. Display only: the buffer, the
 * cursor and every edit stay in the buffer after it.
 */
function basePrefix(editor: InstructionsEditorState): { text: string; lineStyles: Array<ToolLineStyle | undefined> } | null {
  if (!editor.base?.trim() || editor.tools || editor.macro || editor.loadReqId) return null;
  const lines: string[] = [];
  const lineStyles: Array<ToolLineStyle | undefined> = [];
  let offset = 0;
  const push = (text: string, rule?: { name: string; source: string }) => {
    if (rule) lineStyles[lines.length] = { kind: "rule", section: { kind: "tool", ...rule, offset, line: lines.length } };
    lines.push(text);
    offset += text.length + 1;
  };
  push(BASE_RULE.name, BASE_RULE);
  for (const line of sanitizePromptTextForInsertion(editor.base).trim().split("\n")) push(line);
  push("");
  push(OWN_RULE.name, OWN_RULE);
  return { text: lines.join("\n") + "\n", lineStyles };
}

function editorTitle(editor: InstructionsEditorState): string {
  if (editor.tools) {
    const route = [editor.tools.provider, editor.tools.model].filter(Boolean).join(" · ");
    return `Tool instructions · ${route}`;
  }
  if (editor.macro) {
    const desc = editor.macro.description ? ` · ${editor.macro.description}` : "";
    return `${editor.macro.create ? "New macro" : "Edit macro"} ${editor.macro.name}${desc}`;
  }
  const reach = editor.scope === "conversation" && editor.target.convId
    ? editor.target.convTitle?.trim() || "this conversation"
    : scopeReach(editor.scope, editor.target);
  return `${scopeLabel(editor.scope)} instructions · ${reach}`;
}

function placeholder(editor: InstructionsEditorState): string {
  if (editor.tools) return "No tools on this route";
  if (editor.macro) return `What ${editor.macro.name} expands to, anywhere in a message…`;
  switch (editor.scope) {
    case "conversation": return "Instructions for this conversation only…";
    case "folder": return `Instructions for every conversation in ${editor.target.folderName ?? "this folder"}/…`;
    case "global": return "Instructions for every conversation…";
  }
}

export function renderInstructionsEditor(editor: InstructionsEditorState, totalRows: number, totalCols: number): RenderedInstructionsModal {
  const width = Math.max(30, Math.min(100, totalCols - MARGIN * 2));
  const inner = width - SIDE;
  // Top edge, blank, body, blank, separator, status, bottom edge.
  const chrome = 6;
  const height = Math.max(chrome + 3, Math.min(totalRows - 2, Math.max(16, Math.round(totalRows * 0.65))));
  const bodyRows = Math.max(1, height - chrome);
  const { top, left } = cardGeometry(totalRows, totalCols, width, height);
  const bg = theme.sidebarBg;

  editor.viewRows = bodyRows;
  editor.viewWidth = inner;
  // Global's base is drawn above the buffer; offsets below are into both, in that order.
  const prefix = basePrefix(editor);
  const shift = prefix?.text.length ?? 0;
  const display = prefix ? prefix.text + editor.buffer : editor.buffer;
  let view = getInputLines(display, shift + editor.cursor, inner, bodyRows, editor.scroll);
  // On the first line of the editable text, show the base above it when both fit.
  if (prefix && view.scrollOffset > 0 && view.scrollOffset + view.cursorLine < bodyRows
    && (editor.cursor === 0 || editor.buffer.lastIndexOf("\n", editor.cursor - 1) === -1)) {
    view = getInputLines(display, shift + editor.cursor, inner, bodyRows, 0);
  }
  editor.scroll = view.scrollOffset;
  const visual = selectionRange(editor);
  const selection = visual && { start: visual.start + shift, end: visual.end + shift };

  const dirty = isInstructionsEditorDirty(editor);
  const state = editor.readOnly ? "read-only" : dirty ? "● modified" : "";
  let payload = moveTo(top, left) + edge(["╭", "╮"], width, editorTitle(editor), state, theme.bold + theme.text, dirty ? theme.warning : theme.muted);
  const tools = editor.tools && !editor.loadReqId ? editor.tools : null;
  const lineStyles = tools?.lineStyles ?? prefix?.lineStyles ?? null;
  const newlines = lineStyles ? newlineOffsets(display) : [];
  let cursorOnRule = false;
  payload += moveTo(top + 1, left) + bodyRow(pad(inner));
  for (let i = 0; i < bodyRows; i++) {
    let content: string;
    if (editor.loadReqId) {
      content = i === 0 ? spread("Loading…", theme.muted, "", "", inner, bg) : pad(inner);
    } else if (!editor.buffer && i < view.lines.length && view.lineStarts[i] === shift) {
      content = spread(placeholder(editor), theme.dim + theme.italic, "", "", inner, bg) + theme.italicOff;
    } else if (i < view.lines.length && lineStyles) {
      const start = view.lineStarts[i];
      const line = lineOf(newlines, start);
      const firstRow = start === 0 || display[start - 1] === "\n";
      content = decoratedRow(lineStyles, view.lines[i], start, line, firstRow, inner, selection, bg);
      if (i === view.cursorLine && tools && lineStyles[line]?.kind === "rule") cursorOnRule = true;
    } else if (i < view.lines.length) {
      content = editorLine(view.lines[i], view.lineStarts[i], inner, selection, bg);
    } else {
      content = spread("~", theme.dim, "", "", inner, bg);
    }
    payload += moveTo(top + 2 + i, left) + bodyRow(content);
  }
  payload += moveTo(top + 2 + bodyRows, left) + bodyRow(pad(inner));
  payload += moveTo(top + 3 + bodyRows, left) + bg + theme.accent + "├" + "─".repeat(width - 2) + "┤" + theme.reset;

  // Status: mode, then the command line or a notice, then the cursor position.
  const badge = modeBadge(editor);
  const badgeText = `${badge.color}${theme.bold}${badge.text}${theme.boldOff}${theme.reset}${bg}`;
  const badgeWidth = termWidth(badge.text) + 2;
  const lines = editor.buffer.split("\n");
  const cursorLine = editor.buffer.slice(0, editor.cursor).split("\n").length;
  const lineStart = editor.buffer.lastIndexOf("\n", editor.cursor - 1) + 1;
  const position = `Ln ${cursorLine}, Col ${termWidth(editor.buffer.slice(lineStart, editor.cursor)) + 1} · ${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
  let middle: string;
  let commandCursorCol: number | null = null;
  if (editor.command !== null) {
    const shown = truncateToWidth(clean(editor.command), Math.max(0, inner - badgeWidth - 2));
    middle = spread(`:${shown}`, theme.text, "", "", inner - badgeWidth, bg);
    commandCursorCol = badgeWidth + 1 + termWidth(shown);
  } else if (editor.notice) {
    // A source path keeps its end (the file) when it does not fit.
    const room = inner - badgeWidth;
    const text = editor.tools && termWidth(editor.notice.text) > room ? truncateStart(editor.notice.text, room) : editor.notice.text;
    middle = spread(text, noticeColor(editor.notice.tone), position, theme.muted, room, bg);
  } else {
    middle = spread("", "", position, theme.muted, inner - badgeWidth, bg);
  }
  payload += moveTo(top + 4 + bodyRows, left) + bodyRow(badgeText + "  " + middle);
  payload += moveTo(top + height - 1, left) + edge(["╰", "╯"], width, "", "", theme.muted);

  // Body text starts after the border and two columns of padding.
  const textCol = left + 3;
  let cursor: RenderedInstructionsModal["cursor"] = null;
  if (commandCursorCol !== null) {
    cursor = { row: top + 4 + bodyRows, col: textCol + commandCursorCol, shape: "bar" };
  } else if (!editor.loadReqId) {
    const pendingOperator = editor.vim.pendingOperator || editor.vim.pendingReplace
      || editor.vim.pendingKeys === "<" || editor.vim.pendingKeys === ">";
    cursor = {
      row: top + 2 + view.cursorLine,
      // On a rule the label is drawn after its lead-in.
      col: textCol + Math.min(inner - 1, view.cursorCol + (cursorOnRule ? RULE_LEAD : 0)),
      shape: editor.vim.mode === "insert" ? "bar" : pendingOperator ? "underline" : "block",
    };
  }
  return { payload, rect: { top, bottom: top + height - 1, left, right: left + width - 1 }, cursor };
}

export function renderInstructionsModal(modal: InstructionsModalState, totalRows: number, totalCols: number): RenderedInstructionsModal | null {
  if (modal.editor) return renderInstructionsEditor(modal.editor, totalRows, totalCols);
  if (modal.picker) return renderInstructionsPicker(modal.picker, totalRows, totalCols);
  return null;
}
