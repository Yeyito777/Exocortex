/**
 * /instructions tools: a read-only document of what the model is told about
 * each tool, as the daemon reports it (load_tool_instructions). The buffer is
 * plain text, one header line per section; the rules drawn over those lines
 * are display-only decorations kept beside it, never part of the text.
 */

import { homedir } from "os";
import type { KeyEvent } from "../input";
import type { ToolInstructionsEntry, ToolInstructionsLoadedEvent } from "../protocol";
import { sanitizePromptTextForInsertion } from "../prompttext";
import { promptDisplayRows } from "../promptline";
import { resetPending } from "../vim/types";
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
  /** Where a tool's text comes from (a daemon source file or its manifest). */
  source?: string;
  hintSource?: string;
}

/** How a logical line is drawn: as a rule, or its text in a quieter style. */
export type ToolLineStyle =
  | { kind: "rule"; section: ToolSection }
  | { kind: "field" }
  | { kind: "note" };

export interface ToolInstructionsDoc {
  provider: string;
  model: string | null;
  route: string;
  sections: ToolSection[];
  /** Indexed by logical line; undefined lines are ordinary text. */
  lineStyles: Array<ToolLineStyle | undefined>;
  /** Waiting for a `]`/`[` to complete `]]`/`[[`. */
  pendingBracket?: "]" | "[" | null;
}

export const TOOLS_READ_ONLY_NOTICE = "Read-only: tool text lives in code and manifests · Enter shows the source";

/** The buffer text and its decorations for a daemon answer. */
export function buildToolInstructionsDoc(event: Pick<ToolInstructionsLoadedEvent, "provider" | "model" | "route" | "internal" | "external">): { text: string; doc: ToolInstructionsDoc } {
  const lines: string[] = [];
  const lineStyles: Array<ToolLineStyle | undefined> = [];
  const sections: ToolSection[] = [];
  let offset = 0;

  const push = (text: string, style?: ToolLineStyle) => {
    lines.push(text);
    lineStyles.push(style);
    offset += text.length + 1;
  };
  const pushBlock = (text: string) => {
    for (const line of sanitizePromptTextForInsertion(text).trim().split("\n")) push(line);
  };
  const header = (section: Omit<ToolSection, "offset" | "line">) => {
    const full: ToolSection = { ...section, offset, line: lines.length };
    sections.push(full);
    push(section.name, { kind: "rule", section: full });
  };

  pushBlock(event.route);
  for (const line of lines.keys()) lineStyles[line] = { kind: "note" };

  const group = (name: string, entries: ToolInstructionsEntry[], external: boolean) => {
    push("");
    header({ kind: "group", name, count: entries.length });
    if (entries.length === 0) {
      push("");
      push("None on this route.", { kind: "note" });
    }
    for (const entry of entries) {
      push("");
      header({ kind: "tool", name: entry.name, source: entry.source, ...(entry.hintSource ? { hintSource: entry.hintSource } : {}) });
      const fields: Array<[string, string | undefined]> = external
        ? [["System prompt · manifest systemHint", entry.hint]]
        : [
          ["Description · tool schema", entry.description],
          [entry.hintSource ? "MCP server instructions" : "System prompt · # Internal tools", entry.hint],
        ];
      let first = true;
      for (const [label, text] of fields) {
        if (!text?.trim()) continue;
        if (!first) push("");
        first = false;
        push(label, { kind: "field" });
        pushBlock(text);
      }
      if (first) push("Nothing injected for this tool.", { kind: "note" });
    }
  };
  group("Internal tools", event.internal, false);
  group("External tools", event.external, true);

  return {
    text: lines.join("\n"),
    doc: { provider: event.provider, model: event.model, route: event.route, sections, lineStyles, pendingBracket: null },
  };
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
