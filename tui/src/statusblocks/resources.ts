/**
 * Resources status block — the connected daemon's machine: CPU and RAM, and
 * beside them GPU and VRAM where that machine reports them.
 *
 * The figures come from the daemon (machine_resources), so over /ssh they are
 * the remote's. The layout follows the route's shape (machine-resources.ts):
 * before the first sample the block shows at that width, bars empty and
 * figures "—", and the sample fills it in place. A figure the machine does
 * not report stays "—"; a machine without GPU figures has no GPU column. The
 * block hides first when the terminal is narrow, its GPU column before the
 * rest.
 */

import type { ResourcesShape } from "../machine-resources";
import type { MachineResources, MemoryUse } from "../protocol";
import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import { termWidth } from "../textwidth";
import { theme } from "../theme";
import { renderBar } from "./usage";

/** Cells in each resource bar. */
export const RESOURCE_BAR_WIDTH = 10;

const MISSING = "—";
const GIB = 1024 ** 3;

/** "64%"; "—" when unknown. */
export function formatPercent(pct: number | null): string {
  return pct === null ? MISSING : `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
}

/** "10.8/31G": used GiB with one decimal over the whole total; "—" when unknown. */
export function formatMemory(memory: MemoryUse | null): string {
  if (!memory) return MISSING;
  return `${(memory.usedBytes / GIB).toFixed(1)}/${Math.round(memory.totalBytes / GIB)}G`;
}

/** A memory figure's width while its total is unknown: "10.8/31G". */
const UNKNOWN_TOTAL_FIGURE_WIDTH = 8;

/** The widest a memory figure gets, so the columns don't shift as it changes. */
function memoryFigureWidth(totalBytes: number | null): number {
  return totalBytes === null ? UNKNOWN_TOTAL_FIGURE_WIDTH : termWidth(formatMemory({ usedBytes: totalBytes, totalBytes }));
}

interface Cell {
  label: string;
  /** Bar fill in percent; null leaves it empty. */
  pct: number | null;
  figure: string;
}

function percentCell(label: string, pct: number | null): Cell {
  return { label, pct, figure: formatPercent(pct) };
}

function memoryCell(label: string, memory: MemoryUse | null): Cell {
  return {
    label,
    pct: memory && memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null,
    figure: formatMemory(memory),
  };
}

/** "Label: [bar] figure", the label padded to `labelWidth` and the figure to `figureWidth`. */
function renderCell(cell: Cell, labelWidth: number, figureWidth: number): string {
  const label = `${cell.label}:`.padEnd(labelWidth + 1);
  const bar = renderBar(cell.pct, 100, 0, RESOURCE_BAR_WIDTH);
  const pad = " ".repeat(Math.max(0, figureWidth - termWidth(cell.figure)));
  return `${theme.muted}${label} ${theme.text}[${bar}${theme.text}] ${theme.accent}${cell.figure}${pad}`;
}

interface Column {
  cells: [Cell, Cell];
  labelWidth: number;
  figureWidth: number;
}

function columnWidth(column: Column): number {
  return column.labelWidth + 2 + 1 + RESOURCE_BAR_WIDTH + 1 + 1 + column.figureWidth;
}

function column(cells: [Cell, Cell], figureWidth: number): Column {
  return {
    cells,
    labelWidth: Math.max(...cells.map(cell => cell.label.length)),
    figureWidth: Math.max(figureWidth, ...cells.map(cell => termWidth(cell.figure))),
  };
}

function block(columns: Column[]): StatusBlock {
  const lead = "  ";
  const gap = " ";
  const width = lead.length + columns.reduce((sum, col, i) => sum + (i > 0 ? gap.length : 0) + columnWidth(col), 0);
  const rows = [0, 1].map(row =>
    `${lead}${columns.map(col => renderCell(col.cells[row], col.labelWidth, col.figureWidth)).join(gap)}${theme.reset}`);
  return { id: "resources", priority: -1, width, height: 2, rows };
}

/** The block in `shape`'s layout, filled from `resources` (null: none yet); null without a shape. */
export function resourcesBlockFor(resources: MachineResources | null, shape: ResourcesShape | null): StatusBlock | null {
  if (!shape) return null;
  const percentWidth = termWidth(formatPercent(100));
  const machine = column(
    [percentCell("CPU", resources?.cpuPercent ?? null), memoryCell("MEM", resources?.memory ?? null)],
    Math.max(percentWidth, memoryFigureWidth(shape.memoryTotalBytes)),
  );
  if (!shape.gpu) return block([machine]);
  // A column's labels share one width: "GPU:  " over "VRAM: ".
  const gpu = column(
    [percentCell("GPU", resources?.gpuPercent ?? null), memoryCell("VRAM", resources?.vram ?? null)],
    Math.max(percentWidth, memoryFigureWidth(shape.vramTotalBytes)),
  );
  return { ...block([machine, gpu]), narrower: [block([machine])] };
}

export function resourcesBlock(state: RenderState): StatusBlock | null {
  return resourcesBlockFor(state.machineResources, state.machineResourcesShape);
}
