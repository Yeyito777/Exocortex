/**
 * /instructions tools: what the model is told about each tool, as the daemon
 * reports it (load_tool_instructions), with each tool's description and hint
 * editable in place. The buffer is plain text: one header line per section,
 * a label line per block, then the block's text. Headers, labels and route
 * notes are fixed; an edit that would touch them is refused (see
 * acceptToolsEdit), so the buffer always lays out as the same skeleton and
 * each block's text can be read back from it. The rules drawn over header
 * lines are display-only decorations, never part of the text.
 */

import { homedir } from "os";
import type { KeyEvent } from "../input";
import type { ToolInstructionsBlock, ToolInstructionsEdit, ToolInstructionsEntry, ToolInstructionsLoadedEvent, ToolInstructionsSavedEvent } from "../protocol";
import { sanitizePromptTextForInsertion } from "../prompttext";
import { promptDisplayRows } from "../promptline";
import { resetPending } from "../vim/types";
import type { UndoState } from "../undo";
import type { InstructionsEditorState } from "./state";

export type ToolSectionKind = "group" | "tool";

/** A ruled header line: a group (Internal/External tools) or one tool. */
export interface ToolSection {
  kind: ToolSectionKind;
  /** "Internal tools", or the tool's name. */
  name: string;
  /** Buffer offset of the header line. */
  offset: number;
  /** Logical line index of the header line. */
  line: number;
  /** Tools in a group. */
  count?: number;
  /** Where a tool's text comes from (a daemon text file or its manifest). */
  source?: string;
  hintSource?: string;
}

/** How a logical line is drawn: as a rule, its text in a quieter style, or an empty block's placeholder. */
export type ToolLineStyle =
  | { kind: "rule"; section: ToolSection }
  | { kind: "field" }
  | { kind: "note" }
  | { kind: "empty"; placeholder: string };

/** One stored piece of a tool's text, as loaded. */
export interface ToolBlock {
  id: string;
  /** The tool it belongs to. */
  tool: string;
  label: string;
  source: string;
  editable: boolean;
  /** The text as the daemon sent it: what a save expects to replace. */
  loaded: string;
  /** The text as first shown (prompt-safe, trimmed): blocks still showing it are not saved. */
  shown: string;
}

/** The fixed lines of the document, and where each block's text goes. */
type LayoutItem =
  | { kind: "line"; text: string; style?: ToolLineStyle; section?: Omit<ToolSection, "offset" | "line"> }
  | { kind: "block"; index: number };

/** A save in flight. */
export interface ToolsSave {
  reqId: string;
  /** :wq: close once it has saved. */
  close: boolean;
  /** The buffer as saved: clean again once it lands, unless edited meanwhile. */
  buffer: string;
}

export interface ToolInstructionsDoc {
  provider: string;
  model: string | null;
  route: string;
  sections: ToolSection[];
  /** Indexed by logical line; undefined lines are ordinary text. */
  lineStyles: Array<ToolLineStyle | undefined>;
  /** Waiting for a `]`/`[` to complete `]]`/`[[`. */
  pendingBracket?: "]" | "[" | null;
  blocks: ToolBlock[];
  /** Each block's text in the buffer now. */
  texts: string[];
  /** Buffer offsets of each editable block's text, [start, end); undefined for fixed ones. */
  regions: Array<{ start: number; end: number } | undefined>;
  /** Each block from its label line to the end of its text, for saying where the cursor is. */
  spans: Array<{ start: number; end: number }>;
  items: LayoutItem[];
  /** Whether any block can be edited (an older daemon sends none that can). */
  editable: boolean;
  /** Block texts of buffers the editor has held, so undo and redo find their blocks again. */
  history: Map<string, string[]>;
  saving: ToolsSave | null;
}

export const TOOLS_READ_ONLY_NOTICE = "Read-only: this daemon can't save tool text (update it to edit here)";
export const TOOLS_FIXED_NOTICE = "Only description and hint text can be edited; headers and labels stay";
const HISTORY_LIMIT = 500;

function shownText(text: string): string {
  return sanitizePromptTextForInsertion(text).trim();
}

/** Blocks for an entry from a daemon that sends none: its description and hint, read-only. */
function legacyBlocks(entry: ToolInstructionsEntry, external: boolean): ToolInstructionsBlock[] {
  const fields: Array<[string, string, string | undefined]> = external
    ? [["hint", "System prompt · manifest systemHint", entry.hint]]
    : [
      ["description", "Description · tool schema", entry.description],
      ["hint", entry.hintSource ? "MCP server instructions" : "System prompt · # Internal tools", entry.hint],
    ];
  return fields.flatMap(([kind, label, text]) => text?.trim()
    ? [{ id: `legacy:${entry.name}:${kind}`, label, text, source: kind === "hint" ? entry.hintSource ?? entry.source : entry.source, editable: false }]
    : []);
}

/** Lay the document out with these block texts: the buffer and its decorations. */
function layout(items: LayoutItem[], blocks: ToolBlock[], texts: string[]): Pick<ToolInstructionsDoc, "sections" | "lineStyles" | "regions" | "spans"> & { text: string } {
  const lines: string[] = [];
  const lineStyles: Array<ToolLineStyle | undefined> = [];
  const sections: ToolSection[] = [];
  const regions: ToolInstructionsDoc["regions"] = blocks.map(() => undefined);
  const spans: ToolInstructionsDoc["spans"] = [];
  let offset = 0;
  let lineStart = 0;
  const push = (text: string, style?: ToolLineStyle) => {
    lines.push(text);
    lineStyles.push(style);
    lineStart = offset;
    offset += text.length + 1;
  };
  for (const item of items) {
    if (item.kind === "line") {
      if (item.section) {
        const section: ToolSection = { ...item.section, offset, line: lines.length };
        sections.push(section);
        push(item.text, { kind: "rule", section });
      } else push(item.text, item.style);
      continue;
    }
    const block = blocks[item.index];
    const text = texts[item.index];
    // The label line just pushed.
    const labelStart = lineStart;
    const start = offset;
    const blockLines = text.split("\n");
    for (const line of blockLines) push(line, block.editable && text === "" ? { kind: "empty", placeholder: emptyPlaceholder(block) } : undefined);
    if (block.editable) regions[item.index] = { start, end: start + text.length };
    spans[item.index] = { start: labelStart, end: start + text.length };
  }
  return { text: lines.join("\n"), lineStyles, sections, regions, spans };
}

function emptyPlaceholder(block: ToolBlock): string {
  return block.id.endsWith(":description") ? "Empty: type a description" : "Empty: nothing injected; type to add a hint";
}

/** Recompute the decorations for new block texts; the buffer must already read this way. */
function relayout(doc: ToolInstructionsDoc, texts: string[]): string {
  const next = layout(doc.items, doc.blocks, texts);
  doc.texts = texts;
  doc.sections = next.sections;
  doc.lineStyles = next.lineStyles;
  doc.regions = next.regions;
  doc.spans = next.spans;
  return next.text;
}

function remember(doc: ToolInstructionsDoc, buffer: string): void {
  doc.history.delete(buffer);
  doc.history.set(buffer, [...doc.texts]);
  if (doc.history.size > HISTORY_LIMIT) doc.history.delete(doc.history.keys().next().value!);
}

/** The buffer text and its decorations for a daemon answer. */
export function buildToolInstructionsDoc(event: Pick<ToolInstructionsLoadedEvent, "provider" | "model" | "route" | "internal" | "external">): { text: string; doc: ToolInstructionsDoc } {
  const items: LayoutItem[] = [];
  const blocks: ToolBlock[] = [];
  for (const line of shownText(event.route).split("\n")) items.push({ kind: "line", text: line, style: { kind: "note" } });

  const group = (name: string, entries: ToolInstructionsEntry[], external: boolean) => {
    items.push({ kind: "line", text: name, section: { kind: "group", name, count: entries.length } });
    if (entries.length === 0) items.push({ kind: "line", text: "None on this route.", style: { kind: "note" } });
    for (const entry of entries) {
      items.push({ kind: "line", text: entry.name, section: { kind: "tool", name: entry.name, source: entry.source, ...(entry.hintSource ? { hintSource: entry.hintSource } : {}) } });
      let shown = 0;
      for (const block of entry.blocks ?? legacyBlocks(entry, external)) {
        const text = shownText(block.text);
        // A block that can't be edited and is empty has nothing to show.
        if (!block.editable && !text) continue;
        shown++;
        items.push({ kind: "line", text: block.label, style: { kind: "field" } });
        items.push({ kind: "block", index: blocks.length });
        blocks.push({ id: block.id, tool: entry.name, label: block.label, source: block.source, editable: block.editable, loaded: block.text, shown: text });
      }
      if (shown === 0) items.push({ kind: "line", text: "Nothing injected for this tool.", style: { kind: "note" } });
    }
  };
  group("Internal tools", event.internal, false);
  group("External tools", event.external, true);

  const texts = blocks.map(block => block.shown);
  const laid = layout(items, blocks, texts);
  const doc: ToolInstructionsDoc = {
    provider: event.provider,
    model: event.model,
    route: event.route,
    sections: laid.sections,
    lineStyles: laid.lineStyles,
    pendingBracket: null,
    blocks,
    texts,
    regions: laid.regions,
    spans: laid.spans,
    items,
    editable: blocks.some(block => block.editable),
    history: new Map(),
    saving: null,
  };
  remember(doc, laid.text);
  return { text: laid.text, doc };
}

// ── Edits ────────────────────────────────────────────────────────────

/** The editor before a key, to put back when the key would change a fixed line. */
export interface ToolsEditSnapshot {
  buffer: string;
  cursor: number;
  undo: UndoState;
}

export function snapshotToolsEdit(editor: InstructionsEditorState): ToolsEditSnapshot {
  const { undo } = editor;
  return {
    buffer: editor.buffer,
    cursor: editor.cursor,
    undo: { ...undo, undoStack: [...undo.undoStack], redoStack: [...undo.redoStack] },
  };
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

/** The new block texts when `after` differs from `before` only inside one editable block; null otherwise. */
function editInOneBlock(doc: ToolInstructionsDoc, before: string, after: string): { texts: string[]; buffer: string; cursor?: number } | null {
  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before, after);
  for (const [index, region] of doc.regions.entries()) {
    if (!region) continue;
    const tail = before.length - region.end;
    if (region.start <= prefix && tail <= suffix && after.length >= region.start + tail) {
      const texts = [...doc.texts];
      texts[index] = after.slice(region.start, after.length - tail);
      return { texts, buffer: after };
    }
  }
  // dd (or a linewise delete) of a block's every line also takes a newline that
  // is not the block's: leave the block empty instead.
  for (const [index, region] of doc.regions.entries()) {
    if (!region) continue;
    const head = before.slice(0, region.start);
    const rest = before.slice(region.end);
    const emptied = head + rest;
    if (after === head + rest.slice(1) || (region.start > 0 && after === head.slice(0, -1) + rest)) {
      const texts = [...doc.texts];
      texts[index] = "";
      return { texts, buffer: emptied, cursor: region.start };
    }
  }
  return null;
}

/**
 * After a key: keep the edit when it changed only description or hint text,
 * and lay the document out again; otherwise put the editor back as it was.
 */
export function acceptToolsEdit(editor: InstructionsEditorState, before: ToolsEditSnapshot): void {
  const doc = editor.tools;
  if (!doc || editor.buffer === before.buffer) return;
  const known = doc.history.get(editor.buffer);
  const edit = known ? { texts: [...known], buffer: editor.buffer } : editInOneBlock(doc, before.buffer, editor.buffer);
  if (edit) {
    const previous = doc.texts;
    if (relayout(doc, edit.texts) === edit.buffer) {
      editor.buffer = edit.buffer;
      if (edit.cursor !== undefined) editor.cursor = edit.cursor;
      editor.cursor = Math.min(editor.cursor, editor.buffer.length);
      remember(doc, editor.buffer);
      return;
    }
    relayout(doc, previous);
  }
  editor.buffer = before.buffer;
  editor.cursor = before.cursor;
  editor.undo = before.undo;
  // The mode stays as the key left it: after a refused `o` or `cc`, what is
  // typed next is refused too rather than run as normal-mode commands.
  editor.curswant = null;
  editor.notice = { text: TOOLS_FIXED_NOTICE, tone: "warning" };
}

/** The blocks whose text changed since they were loaded (or last saved), as a save sends them. */
export function changedToolBlocks(doc: ToolInstructionsDoc): ToolInstructionsEdit[] {
  return doc.blocks.flatMap((block, index) => block.editable && doc.texts[index].trim() !== block.shown
    ? [{ id: block.id, text: doc.texts[index], expected: block.loaded }]
    : []);
}

/** A save landed: the saved blocks are what is loaded now. */
export function applyToolsSaved(doc: ToolInstructionsDoc, event: Pick<ToolInstructionsSavedEvent, "saved">): void {
  for (const saved of event.saved) {
    const block = doc.blocks.find(candidate => candidate.id === saved.id);
    if (!block) continue;
    block.loaded = saved.text;
    block.shown = shownText(saved.text);
  }
}

/** The status line for a save: committed <hash> + pushed, or why not. */
export function toolsSaveStatus(event: Pick<ToolInstructionsSavedEvent, "commits">): { text: string; ok: boolean } {
  if (event.commits.length === 0) return { text: "Saved (the files already had this text)", ok: true };
  const parts = event.commits.map((commit) => {
    const repo = commit.repo.split("/").filter(Boolean).at(-1) ?? commit.repo;
    const where = event.commits.length > 1 ? `${repo}: ` : "";
    if (commit.commit && commit.pushed) return `${where}committed ${commit.commit} + pushed`;
    if (commit.commit) return `${where}committed ${commit.commit}, not pushed: ${commit.error ?? "unknown error"}`;
    return `${where}saved, not committed: ${commit.error ?? "unknown error"}`;
  });
  return { text: `Saved · ${parts.join(" · ")}`, ok: event.commits.every(commit => commit.commit && commit.pushed) };
}

/** The logical line index of a buffer offset. */
export function lineIndexAt(buffer: string, offset: number): number {
  let line = 0;
  for (let i = buffer.indexOf("\n"); i !== -1 && i < offset; i = buffer.indexOf("\n", i + 1)) line++;
  return line;
}

/** The next (or previous) section header of `kind` past the cursor; null at the end. */
export function adjacentSection(doc: ToolInstructionsDoc, cursor: number, direction: 1 | -1, kind: ToolSectionKind): ToolSection | null {
  const candidates = doc.sections.filter(section => section.kind === kind);
  if (direction === 1) return candidates.find(section => section.offset > cursor) ?? null;
  return candidates.findLast(section => section.offset < cursor) ?? null;
}

/** The innermost section holding the cursor, if any. */
export function sectionAt(doc: ToolInstructionsDoc, cursor: number): ToolSection | null {
  const before = doc.sections.filter(section => section.offset <= cursor);
  const group = before.findLast(section => section.kind === "group") ?? null;
  const tool = before.findLast(section => section.kind === "tool") ?? null;
  // A tool belongs to the group it follows.
  return tool && (!group || tool.offset > group.offset) ? tool : group;
}

/** A source path shortened to its place in the checkout, for the rules. */
export function shortSource(path: string): string {
  for (const marker of ["/daemon/src/", "/external-tools/"]) {
    const at = path.lastIndexOf(marker);
    if (at !== -1) return path.slice(at + 1);
  }
  return path.split("/").slice(-2).join("/");
}

/** A path with this machine's home as ~; another daemon's paths stay absolute. */
function tildePath(path: string, home = homedir()): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** What Enter (or gf) says about the section under the cursor. */
export function sectionSourceNotice(doc: ToolInstructionsDoc, cursor: number, home?: string): string {
  const index = doc.spans.findIndex(span => span.start <= cursor && cursor <= span.end);
  const block = index === -1 ? null : doc.blocks[index];
  if (block) return `${block.tool} · ${block.label}: ${tildePath(block.source, home)}`;
  const section = sectionAt(doc, cursor);
  if (!section || section.kind === "group" || !section.source) return doc.route;
  const hint = section.hintSource && section.hintSource !== section.source ? ` · instructions: ${tildePath(section.hintSource, home)}` : "";
  return `${section.name}: ${tildePath(section.source, home)}${hint}`;
}

// ── Keys ─────────────────────────────────────────────────────────────

/** Put a section header near the top of the view. */
function jumpTo(editor: InstructionsEditorState, section: ToolSection): void {
  editor.cursor = section.offset;
  editor.curswant = null;
  const row = promptDisplayRows(editor.buffer, editor.viewWidth).findIndex(candidate => candidate.start === section.offset);
  // One row of context above; rendering clamps the scroll to the document.
  if (row !== -1) editor.scroll = Math.max(0, row - 1);
}

function jump(editor: InstructionsEditorState, doc: ToolInstructionsDoc, direction: 1 | -1, kind: ToolSectionKind): void {
  let count = Math.max(1, editor.vim.count ?? 1);
  resetPending(editor.vim);
  let target: ToolSection | null = null;
  let from = editor.cursor;
  while (count-- > 0) {
    const next = adjacentSection(doc, from, direction, kind);
    if (!next) break;
    target = next;
    from = next.offset;
  }
  if (target) jumpTo(editor, target);
  else editor.notice = { text: direction === 1 ? `No ${kind === "tool" ? "tool" : "section"} below` : `No ${kind === "tool" ? "tool" : "section"} above`, tone: "info" };
}

/**
 * Tools-view keys, before the editor's own: ]] and [[ move by tool, } and {
 * by group, Enter and gf say where the section under the cursor comes from.
 * Returns false for keys the editor handles.
 */
export function handleToolsViewKey(key: KeyEvent, editor: InstructionsEditorState): boolean {
  const doc = editor.tools;
  if (!doc || editor.loadReqId || editor.command !== null) return false;
  const mode = editor.vim.mode;
  if (mode !== "normal" && mode !== "visual" && mode !== "visual-line") return false;
  const char = key.type === "char" ? key.char : undefined;

  const pending = doc.pendingBracket;
  doc.pendingBracket = null;
  if (pending) {
    if (char === pending) {
      editor.notice = null;
      jump(editor, doc, pending === "]" ? 1 : -1, "tool");
      return true;
    }
    resetPending(editor.vim);
  }
  if (editor.vim.pendingOperator || editor.vim.pendingFind || editor.vim.pendingReplace || editor.vim.pendingTextObjectModifier) return false;

  if (char === "]" || char === "[") {
    if (editor.vim.pendingKeys) return false;
    doc.pendingBracket = char;
    return true;
  }
  if (char === "}" || char === "{") {
    if (editor.vim.pendingKeys) return false;
    editor.notice = null;
    jump(editor, doc, char === "}" ? 1 : -1, "group");
    return true;
  }
  const gf = char === "f" && editor.vim.pendingKeys === "g";
  if (mode === "normal" && (gf || (key.type === "enter" && !editor.vim.pendingKeys))) {
    resetPending(editor.vim);
    editor.notice = { text: sectionSourceNotice(doc, editor.cursor), tone: "info" };
    return true;
  }
  return false;
}
