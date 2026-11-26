/**
 * The Scratchpad card: the focused conversation's scratchpad.md
 * (docs/scratchpad.md), as its summary names it (by hash, like Tasks ride on
 * the summary) from the contents held (scratchpadstore.ts), drawn
 * read-only at the bottom of the right-hand column, below the Tasks and
 * Subscriptions cards (or at its top without them).
 *
 * A small markdown subset: `#` headings, `- [ ]` and `- [x]` to-dos, `-`
 * bullets and plain notes, with `**text**` in the warning colour. Blank lines
 * are dropped. The header counts open to-dos (none shown without checkboxes).
 *
 * It behaves like the Tasks card: collapsed, one truncated row per line,
 * capped in height with a last row counting the lines left out; a click
 * expands it to every line, wrapped, as wide as the Tasks card would grow,
 * scrolling when it outgrows the pane. At most one card of the column is
 * expanded, and Shift+click on its header folds it to that row (sidecards.ts).
 */

import {
  cardHeader,
  EXPANDED_PANEL_WIDTH_FACTOR,
  expandedPanelFooter,
  focusedConversationIntegrations,
  MAX_PANEL_WIDTH,
  MAX_TASK_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  MIN_TASK_PANEL_HISTORY_WIDTH,
  panelPalette,
  renderSubscriptionsPanel,
  renderTaskPanel,
  scrollExpansion,
  TASK_PANEL_HISTORY_GAP,
  type HeaderBadge,
  type PanelPalette,
  type TaskPanelRender,
} from "./activitypanel";
import { collapseOtherExpansions, isCardFolded } from "./sidecards";
import { focusedConversation, type RenderState } from "./state";
import { sliceByWidth, termWidth } from "./textwidth";
import { hexToAnsi, theme } from "./theme";

export const SCRATCHPAD_TITLE = "Scratchpad";
/** The collapsed card's cap, as for Tasks. */
export const MAX_SCRATCHPAD_PANEL_HEIGHT = MAX_TASK_PANEL_HEIGHT;
const HEADING_HEX = "#b4bac4";

export type ScratchpadLineKind = "heading" | "open" | "done" | "bullet" | "note";

/** Part of a line; `urgent` text was `**bold**` in the file. */
export interface ScratchpadRun {
  text: string;
  urgent: boolean;
}

export interface ScratchpadLine {
  kind: ScratchpadLineKind;
  /** Leading columns for a nested list item. */
  indent: number;
  runs: ScratchpadRun[];
}

export interface ScratchpadRender {
  width: number;
  lines: string[];
  /** Expanded body rows scrolled out of view above the card. */
  scroll: number;
  /** Largest useful `scroll`; 0 when the whole card fits or it is collapsed. */
  maxScroll: number;
  /** A click changes the card: it is expanded, or collapsed with a line or part of one left out. */
  toggleable: boolean;
}

/** `**text**` → urgent runs; an unpaired `**` stays as written. */
export function scratchpadRuns(text: string): ScratchpadRun[] {
  const runs: ScratchpadRun[] = [];
  let last = 0;
  for (const match of text.matchAll(/\*\*(.+?)\*\*/g)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), urgent: false });
    runs.push({ text: match[1], urgent: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), urgent: false });
  return runs;
}

function cleanLine(line: string): string {
  return line.replace(/\t/g, "  ").replace(/[\x00-\x1F\x7F-\x9F]/g, "").trimEnd();
}

/** Nested list items indent two columns a level, at most three levels. */
function indentOf(leading: string): number {
  return Math.min(3, Math.floor(leading.length / 2)) * 2;
}

/** The lines the card shows, blank lines dropped. */
export function parseScratchpad(content: string): ScratchpadLine[] {
  const lines: ScratchpadLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (!line.trim()) continue;
    const heading = /^\s*#{1,6}\s+(.*?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      lines.push({ kind: "heading", indent: 0, runs: scratchpadRuns(heading[1]) });
      continue;
    }
    const todo = /^(\s*)[-*+]\s+\[([ xX])\](?:\s+(.*))?$/.exec(line);
    if (todo) {
      lines.push({ kind: todo[2] === " " ? "open" : "done", indent: indentOf(todo[1]), runs: scratchpadRuns(todo[3] ?? "") });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      lines.push({ kind: "bullet", indent: indentOf(bullet[1]), runs: scratchpadRuns(bullet[2]) });
      continue;
    }
    lines.push({ kind: "note", indent: 0, runs: scratchpadRuns(line.trim()) });
  }
  return lines;
}

/** Open `- [ ]` items: the header's count. */
export function scratchpadOpenCount(lines: readonly ScratchpadLine[]): number {
  return lines.filter(line => line.kind === "open").length;
}

/** The header's count: open to-dos, or nothing when the file has no checkboxes. */
export function scratchpadHeaderCount(lines: readonly ScratchpadLine[]): string {
  return lines.some(line => line.kind === "open" || line.kind === "done") ? String(scratchpadOpenCount(lines)) : "";
}

/** The header's breakdown beside its open count: done to-dos, with the card's own ✓ and its colour. */
export function scratchpadHeaderBadges(lines: readonly ScratchpadLine[]): HeaderBadge[] {
  const done = lines.filter(line => line.kind === "done").length;
  return [{ glyph: "✓", count: done, color: lineStyle("done").glyphColor }];
}

let parsedFor: string | null = null;
let parsed: ScratchpadLine[] = [];

/**
 * The focused conversation's scratchpad lines: the contents its summary's
 * hash names, when held. Empty without a scratchpad, or before its contents
 * are here (never another version's).
 */
export function focusedScratchpadLines(state: RenderState): ScratchpadLine[] {
  const hash = focusedConversation(state)?.scratchpad;
  const content = hash ? state.scratchpads.get(hash) : undefined;
  if (!content) return [];
  if (content !== parsedFor) {
    parsed = parseScratchpad(content);
    parsedFor = content;
  }
  return parsed;
}

export function isScratchpadExpanded(state: RenderState): boolean {
  return state.convId !== null && state.scratchpadExpansion?.convId === state.convId;
}

/** Expand the focused conversation's Scratchpad card (collapsing any other card), or collapse it. */
export function toggleScratchpadExpansion(state: RenderState): void {
  state.scratchpadExpansion = isScratchpadExpanded(state) || !state.convId
    ? null
    : { convId: state.convId, scroll: 0 };
  if (state.scratchpadExpansion) collapseOtherExpansions(state, "scratchpad");
}

/** Scroll the expanded card by `delta` rows within what the last frame could show; true when it moved. */
export function scrollScratchpad(state: RenderState, delta: number): boolean {
  const expansion = state.scratchpadExpansion;
  if (!expansion || !isScratchpadExpanded(state)) return false;
  return scrollExpansion(expansion, state.layout.scratchpadMaxScroll, delta);
}

interface LineStyle {
  glyph: string;
  glyphColor: string;
  text: string;
  urgent: string;
}

function lineStyle(kind: ScratchpadLineKind): LineStyle {
  switch (kind) {
    case "heading": return { glyph: "", glyphColor: "", text: `${theme.bold}${hexToAnsi(HEADING_HEX)}`, urgent: `${theme.bold}${theme.warning}` };
    case "open": return { glyph: "○ ", glyphColor: theme.muted, text: theme.text, urgent: theme.warning };
    case "done": return { glyph: "✓ ", glyphColor: `${theme.dim}${theme.success}`, text: `${theme.dim}${theme.text}`, urgent: `${theme.dim}${theme.warning}` };
    case "bullet": return { glyph: "• ", glyphColor: theme.muted, text: theme.text, urgent: theme.warning };
    case "note": return { glyph: "", glyphColor: "", text: theme.muted, urgent: theme.warning };
  }
}

const runsWidth = (runs: readonly ScratchpadRun[]) => runs.reduce((sum, run) => sum + termWidth(run.text), 0);

/** One row: what fits of `runs` in `width`, an ellipsis after what it cuts. */
export function truncateRuns(runs: readonly ScratchpadRun[], width: number): ScratchpadRun[] {
  if (runsWidth(runs) <= width) return [...runs];
  if (width <= 0) return [];
  const out: ScratchpadRun[] = [];
  let room = width - 1;
  for (const run of runs) {
    if (room <= 0) break;
    const [head] = sliceByWidth(run.text, room);
    if (head) out.push({ text: head, urgent: run.urgent });
    room -= termWidth(head);
    if (head.length < run.text.length) break;
  }
  const last = out.at(-1);
  if (last) last.text = last.text.trimEnd();
  out.push({ text: "…", urgent: last?.urgent ?? false });
  return out;
}

/** Word-wrapped rows of `runs`, each at most `width` wide; words longer than a row are broken. */
export function wrapRuns(runs: readonly ScratchpadRun[], width: number): ScratchpadRun[][] {
  const rows: ScratchpadRun[][] = [[]];
  let used = 0;
  const push = (text: string, urgent: boolean) => {
    const row = rows[rows.length - 1];
    const previous = row.at(-1);
    if (previous && previous.urgent === urgent) previous.text += text;
    else row.push({ text, urgent });
    used += termWidth(text);
  };
  const newRow = () => {
    const row = rows[rows.length - 1];
    const last = row.at(-1);
    if (last) last.text = last.text.trimEnd();
    rows.push([]);
    used = 0;
  };
  for (const run of runs) {
    for (const token of run.text.split(/(\s+)/)) {
      if (!token) continue;
      const tokenWidth = termWidth(token);
      if (/^\s+$/.test(token)) {
        // Spaces never start a row; at a row's end they become the break.
        if (used === 0) continue;
        if (used + tokenWidth < width) push(token, run.urgent);
        else newRow();
        continue;
      }
      if (used + tokenWidth <= width) { push(token, run.urgent); continue; }
      if (used > 0 && tokenWidth <= width) { newRow(); push(token, run.urgent); continue; }
      let rest = token;
      while (rest) {
        if (used >= width) newRow();
        const [head, tail] = sliceByWidth(rest, Math.max(1, width - used));
        push(head || rest.slice(0, 1), run.urgent);
        rest = head ? tail : rest.slice(1);
      }
    }
  }
  const last = rows.at(-1)!.at(-1);
  if (last) last.text = last.text.trimEnd();
  return rows.filter((row, index) => index === 0 || row.length > 0);
}

/** Card width at which a line fits on one row: borders, padding, indent and glyph. */
function lineFitWidth(line: ScratchpadLine): number {
  return line.indent + termWidth(lineStyle(line.kind).glyph) + runsWidth(line.runs) + 4;
}

/** A line's rows between the borders: one truncated row, or every wrapped row. */
function lineRows(palette: PanelPalette, line: ScratchpadLine, innerWidth: number, wrap: boolean): string[] {
  const style = lineStyle(line.kind);
  const contentWidth = innerWidth - 2;
  const lead = " ".repeat(line.indent) + style.glyph;
  const leadWidth = termWidth(lead);
  const textWidth = Math.max(1, contentWidth - leadWidth);
  const rows = wrap ? wrapRuns(line.runs, textWidth) : [truncateRuns(line.runs, textWidth)];
  return rows.map((runs, index) => {
    const prefix = index === 0 && style.glyph
      ? `${" ".repeat(line.indent)}${style.glyphColor}${style.glyph}${theme.reset}`
      : " ".repeat(leadWidth);
    const text = runs.map(run => `${run.urgent ? style.urgent : style.text}${run.text}${theme.reset}`).join("");
    const padding = " ".repeat(Math.max(0, textWidth - runsWidth(runs)));
    return palette.withPanelBg(`${palette.outline}│${theme.reset} ${prefix}${text}${padding} ${palette.outline}│`);
  });
}

/**
 * Build the Scratchpad card for the focused conversation, `maxHeight` rows at
 * most (the rows left below the cards above it). Null without a scratchpad,
 * or where the Tasks card would not show either. Folded, its header row alone.
 */
const scratchpadPanelCache = new WeakMap<RenderState, { key: unknown[]; panel: ScratchpadRender | null }>();

/** The Scratchpad card, built again only when its lines, expansion, size or colours changed: scroll frames reuse it. */
export function renderScratchpadPanel(state: RenderState, chatWidth: number, maxHeight: number): ScratchpadRender | null {
  const key: unknown[] = [
    focusedScratchpadLines(state), chatWidth, maxHeight, isScratchpadExpanded(state), state.scratchpadExpansion?.scroll,
    isCardFolded(state, "scratchpad"), state.externalToolStyles, state.toolRegistry, theme.name,
  ];
  const cached = scratchpadPanelCache.get(state);
  if (cached && cached.key.every((value, index) => value === key[index])) return cached.panel;
  const panel = buildScratchpadPanel(state, chatWidth, maxHeight);
  scratchpadPanelCache.set(state, { key, panel });
  return panel;
}

function buildScratchpadPanel(state: RenderState, chatWidth: number, maxHeight: number): ScratchpadRender | null {
  const lines = focusedScratchpadLines(state);
  const folded = isCardFolded(state, "scratchpad");
  const expanded = isScratchpadExpanded(state) && !folded;
  const panelHeight = folded ? 1 : expanded ? maxHeight : Math.min(maxHeight, MAX_SCRATCHPAD_PANEL_HEIGHT);
  if (lines.length === 0 || chatWidth < MIN_PANEL_WIDTH || panelHeight < (folded ? 1 : 3)) return null;

  const collapsedWidth = Math.min(MAX_PANEL_WIDTH, chatWidth);
  if (folded) {
    const header = cardHeader(panelPalette(state), collapsedWidth - 2, SCRATCHPAD_TITLE, scratchpadHeaderCount(lines), true, scratchpadHeaderBadges(lines));
    return { width: collapsedWidth, lines: [header], scroll: 0, maxScroll: 0, toggleable: false };
  }
  const widestLine = Math.max(...lines.map(lineFitWidth));
  const panelWidth = expanded
    ? Math.max(collapsedWidth, Math.min(widestLine, chatWidth, Math.floor(collapsedWidth * EXPANDED_PANEL_WIDTH_FACTOR)))
    : collapsedWidth;
  const innerWidth = panelWidth - 2;
  const maxContentRows = panelHeight - 2;
  const palette = panelPalette(state);
  const header = cardHeader(palette, innerWidth, SCRATCHPAD_TITLE, scratchpadHeaderCount(lines), false, scratchpadHeaderBadges(lines));

  if (expanded) {
    const body = lines.flatMap(line => lineRows(palette, line, innerWidth, true));
    const maxScroll = Math.max(0, body.length - maxContentRows);
    const scroll = Math.max(0, Math.min(maxScroll, state.scratchpadExpansion?.scroll ?? 0));
    const shown = body.slice(scroll, scroll + maxContentRows);
    return {
      width: panelWidth,
      lines: [header, ...shown, expandedPanelFooter(palette, innerWidth, scroll, body.length - scroll - shown.length, false)],
      scroll,
      maxScroll,
      toggleable: true,
    };
  }

  const visibleCount = lines.length <= maxContentRows ? lines.length : Math.max(0, maxContentRows - 1);
  const hidden = lines.length - visibleCount;
  const out = [header, ...lines.slice(0, visibleCount).flatMap(line => lineRows(palette, line, innerWidth, false))];
  if (hidden > 0) {
    const more = `▸ ${hidden} more`;
    out.push(palette.withPanelBg(
      `${palette.outline}│${theme.reset} ${theme.muted}${more}${" ".repeat(Math.max(0, innerWidth - 2 - termWidth(more)))}${theme.reset} ${palette.outline}│`,
    ));
  }
  out.push(palette.withPanelBg(`${palette.outline}╰${"─".repeat(innerWidth)}╯`));
  return { width: panelWidth, lines: out, scroll: 0, maxScroll: 0, toggleable: hidden > 0 || widestLine > panelWidth };
}

export interface SidePanelsLayout {
  /** The Tasks card, at the column's top. */
  panel: TaskPanelRender | null;
  /** The Subscriptions card, directly below the Tasks card. */
  subscriptions: TaskPanelRender | null;
  /** The Scratchpad card, directly below the Subscriptions card. */
  scratchpad: ScratchpadRender | null;
  /** The column the cards share, right-aligned: as wide as the widest, as tall as all stacked; null with none. */
  column: { width: number; height: number } | null;
  /** Width available to history rows that are vertically beside the column. */
  historyWidth: number;
}

/** Rows the smallest form of a card takes: its header alone when folded, else up to two lines and its borders; 0 without content. */
function smallestCardHeight(lines: number, folded: boolean): number {
  if (lines === 0) return 0;
  return folded ? 1 : Math.min(lines, 2) + 2;
}

/**
 * Lay out the right-hand column, top to bottom: Tasks, Subscriptions and
 * Scratchpad, each in the rows the cards above it leave. A card leaves room
 * for the smallest form of every card below it, while it keeps its own three
 * rows. On narrow terminals none shows, as layoutTaskPanel decides for Tasks.
 */
export function layoutSidePanels(state: RenderState, chatWidth: number, maxHeight: number, now = Date.now()): SidePanelsLayout {
  const availablePanelWidth = chatWidth - MIN_TASK_PANEL_HISTORY_WIDTH - TASK_PANEL_HISTORY_GAP;
  const subscriptionsReserve = smallestCardHeight(focusedConversationIntegrations(state).length, isCardFolded(state, "subscriptions"));
  const scratchpadReserve = smallestCardHeight(focusedScratchpadLines(state).length, isCardFolded(state, "scratchpad"));
  const heightFor = (left: number, reserve: number, folded: boolean) =>
    reserve > 0 && left - reserve >= (folded ? 1 : 3) ? left - reserve : left;

  let left = maxHeight;
  const panel = renderTaskPanel(state, availablePanelWidth, heightFor(left, subscriptionsReserve + scratchpadReserve, isCardFolded(state, "tasks")), now);
  left -= panel?.lines.length ?? 0;
  const subscriptions = renderSubscriptionsPanel(state, availablePanelWidth, heightFor(left, scratchpadReserve, isCardFolded(state, "subscriptions")));
  left -= subscriptions?.lines.length ?? 0;
  const scratchpad = renderScratchpadPanel(state, availablePanelWidth, left);
  const cards = [panel, subscriptions, scratchpad].filter(card => card !== null);
  const column = cards.length > 0
    ? { width: Math.max(...cards.map(card => card.width)), height: cards.reduce((sum, card) => sum + card.lines.length, 0) }
    : null;
  return { panel, subscriptions, scratchpad, column, historyWidth: column ? chatWidth - column.width - TASK_PANEL_HISTORY_GAP : chatWidth };
}
