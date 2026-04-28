import { formatMarkdownChunks, stripMarkdown, termWidth, sliceByWidth, visibleLength } from "./formatting";

/**
 * Detects markdown table rows (start and end with |)
 */
export function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return /^\|.+\|$/.test(trimmed);
}

/**
 * Detects separator rows like |---|---|
 */
export function isTableSeparator(line: string): boolean {
  return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

/**
 * Detects rendered table/HR lines (start with box-drawing chars).
 * Used by the renderer to skip formatMarkdown on lines that already have
 * per-cell or per-line ANSI formatting baked in.
 */
export function isBoxDrawingLine(line: string): boolean {
  if (!line) return false;
  // Strip leading ANSI escapes to find the first visible character
  const stripped = line.replace(/^\x1b\[[0-9;]*m/, "");
  if (!stripped) return false;
  const ch = stripped.charCodeAt(0);
  // ┌ = 0x250C, │ = 0x2502, ├ = 0x251C, └ = 0x2514, ─ = 0x2500
  return ch === 0x250C || ch === 0x2502 || ch === 0x251C || ch === 0x2514 || ch === 0x2500;
}

/**
 * Parses cells from a table row line
 */
function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, -1); // Remove leading and trailing |
  return inner.split("|").map(cell => cell.trim());
}

/**
 * Distributes available width across columns using largest-remainder method
 */
function distributeWidths(natural: number[], available: number): number[] {
  const n = natural.length;
  const result = new Array(n).fill(1);
  let remaining = available - n;

  if (remaining <= 0) {
    return result;
  }

  const total = natural.reduce((s, w) => s + w, 0);

  if (total === 0) {
    // No natural widths — distribute remaining evenly
    for (let i = 0; remaining > 0; i = (i + 1) % n, remaining--) {
      result[i]++;
    }
    return result;
  }

  // Calculate proportional distribution
  const exact = natural.map(w => (w * remaining) / total);
  const floors = exact.map(e => Math.floor(e));
  const rems = exact.map((e, i) => e - floors[i]);

  // Apply floors
  for (let i = 0; i < n; i++) {
    result[i] += floors[i];
  }

  // Distribute leftover using largest-remainder method
  let leftover = remaining - floors.reduce((s, f) => s + f, 0);
  const order = rems.map((_, i) => i).sort((a, b) => rems[b] - rems[a]);

  for (let i = 0; leftover > 0; i++, leftover--) {
    result[order[i]]++;
  }

  return result;
}

interface CellWrapResult {
  lines: string[];
  join: string[];
}

function takeChunkByWidth(text: string, width: number): [string, string] {
  const [taken, rest] = sliceByWidth(text, width);
  if (taken !== "") return [taken, rest];
  return [text.slice(0, 1), text.slice(1)];
}

function seedLongWord(
  word: string,
  width: number,
  firstJoin: string,
): { pushedLines: string[]; pushedJoins: string[]; line: string; lineJoin: string } {
  const pushedLines: string[] = [];
  const pushedJoins: string[] = [];
  let remaining = word;
  let joinBefore = firstJoin;

  for (;;) {
    const [taken, rest] = takeChunkByWidth(remaining, width);
    if (!rest) {
      return { pushedLines, pushedJoins, line: taken, lineJoin: joinBefore };
    }
    pushedLines.push(taken);
    pushedJoins.push(joinBefore);
    remaining = rest;
    joinBefore = "";
  }
}

/**
 * Word-wrap cell content using markdown-aware visible width measurement.
 * Uses termWidth(stripMarkdown(line)) to decide breaks so that markdown
 * markers completing within a line are correctly excluded from width.
 * Returns at least one line (empty string for empty content), plus invisible
 * joins used to parse inline markdown across wrapped cell lines.
 */
function wrapCellContent(text: string, width: number): CellWrapResult {
  if (!text) return { lines: [""], join: [""] };
  if (width < 1) return { lines: [text], join: [""] };
  if (termWidth(stripMarkdown(text)) <= width) return { lines: [text], join: [""] };

  const words = text.split(/\s+/);
  const result: string[] = [];
  const joins: string[] = [];
  let line = "";
  let lineJoin = "";

  const startLineWithWord = (word: string, firstJoin: string) => {
    if (termWidth(stripMarkdown(word)) <= width) {
      line = word;
      lineJoin = firstJoin;
      return;
    }
    const seeded = seedLongWord(word, width, firstJoin);
    result.push(...seeded.pushedLines);
    joins.push(...seeded.pushedJoins);
    line = seeded.line;
    lineJoin = seeded.lineJoin;
  };

  for (const word of words) {
    if (line === "") {
      startLineWithWord(word, result.length > 0 ? " " : "");
    } else {
      const candidate = line + " " + word;
      if (termWidth(stripMarkdown(candidate)) <= width) {
        line = candidate;
      } else {
        result.push(line);
        joins.push(lineJoin);
        startLineWithWord(word, " ");
      }
    }
  }

  if (line) {
    result.push(line);
    joins.push(lineJoin);
  }
  return result.length > 0 ? { lines: result, join: joins } : { lines: [""], join: [""] };
}

/**
 * Render a block of consecutive table lines using box-drawing characters.
 * When a table is too wide, columns are proportionally shrunk and cell
 * content word-wraps within each column, expanding rows downward.
 * Falls back to raw lines only if the table is malformed or the width
 * is too narrow to fit even 1 character per column.
 *
 * bgRestore: when provided, formatMarkdown is applied per-cell during
 * rendering so that ANSI formatting is baked in before the line is
 * assembled.  This prevents cross-cell regex matches that would
 * misalign inner │ walls.
 */
export function renderTableBlock(
  tableLines: string[],
  maxWidth: number,
  bgRestore?: string
): string[] {
  const hasSeparator = tableLines.some(l => isTableSeparator(l));
  if (!hasSeparator || tableLines.length < 2) {
    // Not a proper table — preserve raw lines
    return tableLines;
  }

  const dataRows: string[][] = [];
  const isSep: boolean[] = [];

  for (const line of tableLines) {
    if (isTableSeparator(line)) {
      isSep.push(true);
      dataRows.push([]); // placeholder
    } else {
      isSep.push(false);
      dataRows.push(parseTableCells(line));
    }
  }

  // Only count rows that actually have cell data (skip separator placeholders)
  const contentRows = dataRows.filter(r => r.length > 0);
  if (contentRows.length === 0) {
    return tableLines;
  }

  const numCols = Math.max(...contentRows.map(r => r.length));

  // Calculate natural column widths from *visible* content (markdown stripped).
  const naturalWidths: number[] = new Array(numCols).fill(0);
  for (const row of contentRows) {
    for (let c = 0; c < Math.min(row.length, numCols); c++) {
      naturalWidths[c] = Math.max(naturalWidths[c], termWidth(stripMarkdown(row[c])));
    }
  }
  for (let c = 0; c < numCols; c++) {
    naturalWidths[c] = Math.max(naturalWidths[c], 1);
  }

  // Overhead: │ on left + ( space + content + space + │ ) per column
  const overhead = 1 + numCols * 3;
  const available = maxWidth - overhead;

  if (available < numCols) {
    // Can't fit even 1 char per column — fall back to raw lines
    return tableLines;
  }

  const totalNatural = naturalWidths.reduce((s, w) => s + w, 0);
  const colWidths = totalNatural <= available
    ? naturalWidths
    : distributeWidths(naturalWidths, available);

  // --- Render table with box-drawing characters and multi-line rows ---
  const result: string[] = [];

  // Top border: ┌───┬───┐
  result.push("┌" + colWidths.map(w => "─".repeat(w + 2)).join("┬") + "┐");

  for (let i = 0; i < dataRows.length; i++) {
    if (isSep[i]) {
      // Separator: ├───┼───┤
      result.push("├" + colWidths.map(w => "─".repeat(w + 2)).join("┼") + "┤");
    } else {
      // Data row — wrap each cell, then render line-by-line
      const cells = dataRows[i];
      const wrapped = colWidths.map((w, c) => wrapCellContent(cells[c] || "", w));
      const formatted = bgRestore
        ? wrapped.map(wc => formatMarkdownChunks(wc.lines, wc.join, bgRestore))
        : wrapped.map(wc => wc.lines);
      const rowHeight = Math.max(1, ...wrapped.map(wc => wc.lines.length));

      for (let ln = 0; ln < rowHeight; ln++) {
        const parts = colWidths.map((w, c) => {
          const cellLine = wrapped[c]?.lines[ln] || "";
          const renderedCellLine = formatted[c]?.[ln] || "";
          const visLen = bgRestore ? visibleLength(renderedCellLine) : termWidth(stripMarkdown(cellLine));
          const pad = " ".repeat(Math.max(0, w - visLen));
          return " " + renderedCellLine + pad + " ";
        });
        result.push("│" + parts.join("│") + "│");
      }
    }
  }

  // Bottom border: └───┴───┘
  result.push("└" + colWidths.map(w => "─".repeat(w + 2)).join("┴") + "┘");

  return result;
}
