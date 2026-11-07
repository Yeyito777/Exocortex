/**
 * Resources status block — the connected daemon's machine: CPU and RAM, and
 * beside them GPU and VRAM where that machine reports them.
 *
 * The figures come from the daemon (machine_resources), so over /ssh they are
 * the remote's. A figure the machine does not report shows as "—"; a GPU
 * column with neither figure is left out. The block hides first when the
 * terminal is narrow, its GPU column before the rest.
 */

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

/** The widest a figure gets, so the columns don't shift as it changes. */
function memoryFigureWidth(memory: MemoryUse | null): number {
  return termWidth(formatMemory(memory && { usedBytes: memory.totalBytes, totalBytes: memory.totalBytes }));
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

export function resourcesBlockFor(resources: MachineResources | null): StatusBlock | null {
  if (!resources) return null;
  const { cpuPercent, memory, gpuPercent, vram } = resources;
  if (cpuPercent === null && memory === null && gpuPercent === null && vram === null) return null;
  const percentWidth = termWidth(formatPercent(100));
  const machine = column(
    [percentCell("CPU", cpuPercent), memoryCell("MEM", memory)],
    Math.max(percentWidth, memoryFigureWidth(memory)),
  );
  if (gpuPercent === null && vram === null) return block([machine]);
  // A column's labels share one width: "GPU:  " over "VRAM: ".
  const gpu = column(
    [percentCell("GPU", gpuPercent), memoryCell("VRAM", vram)],
    Math.max(percentWidth, memoryFigureWidth(vram)),
  );
  return { ...block([machine, gpu]), narrower: [block([machine])] };
}

export function resourcesBlock(state: RenderState): StatusBlock | null {
  return resourcesBlockFor(state.machineResources);
}
