/**
 * Status line layout engine.
 *
 * Composes status blocks side-by-side below the input prompt.
 * Blocks are built by individual builders in statusblocks/.
 * When the terminal is too narrow, lower-priority blocks are dropped.
 *
 * This file owns the layout algorithm. Individual blocks own their
 * content and rendering.
 */

import type { RenderState } from "./state";
import { theme } from "./theme";

// ── Block registry ──────────────────────────────────────────────────

import { usageBlock } from "./statusblocks/usage";
import { contextBlock } from "./statusblocks/context";

export interface StatusBlock {
  id: string;
  priority: number;     // higher = survives longer when narrow
  width: number;        // visible columns needed (excluding delimiter)
  height: number;       // rows this block occupies
  rows: string[];       // pre-rendered ANSI row strings
}

type BlockBuilder = (state: RenderState) => StatusBlock | null;

/** Ordered list of block builders. Position determines display order. */
const BLOCK_BUILDERS: BlockBuilder[] = [
  usageBlock,
  contextBlock,
];

const DELIMITER_WIDTH = 3; // " │ "

// ── Layout algorithm ────────────────────────────────────────────────

/**
 * Build all blocks, then greedily fit by priority.
 * Returns surviving blocks in their original positional order.
 */
function layoutBlocks(state: RenderState, cols: number): StatusBlock[] {
  // Build candidates, preserving positional index
  const candidates: { block: StatusBlock; position: number }[] = [];
  for (let i = 0; i < BLOCK_BUILDERS.length; i++) {
    const block = BLOCK_BUILDERS[i](state);
    if (block) candidates.push({ block, position: i });
  }

  // Sort by priority descending for the survival decision
  const byPriority = [...candidates].sort((a, b) => b.block.priority - a.block.priority);

  // Greedily select blocks that fit
  const selectedPositions = new Set<number>();
  let used = 0;
  for (const { block, position } of byPriority) {
    const need = selectedPositions.size === 0 ? block.width : DELIMITER_WIDTH + block.width;
    if (used + need <= cols) {
      selectedPositions.add(position);
      used += need;
    }
  }

  // Return in original positional order
  return candidates
    .filter(c => selectedPositions.has(c.position))
    .map(c => c.block);
}

// ── Row composition ─────────────────────────────────────────────────

function composeRow(blocks: StatusBlock[], rowIdx: number, cols: number): string {
  let out = "";
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) out += `${theme.accent} \u2502 `;
    const block = blocks[i];
    if (rowIdx < block.height) {
      out += block.rows[rowIdx];
    } else {
      out += " ".repeat(block.width);
    }
  }

  // Pad to full width
  let usedCols = 0;
  for (let i = 0; i < blocks.length; i++) {
    usedCols += blocks[i].width;
    if (i > 0) usedCols += DELIMITER_WIDTH;
  }
  const remaining = cols - usedCols;
  if (remaining > 0) out += " ".repeat(remaining);
  out += theme.reset;
  return out;
}

// ── Public API ──────────────────────────────────────────────────────

export interface StatusLineResult {
  height: number;
  lines: string[];
}

/** Compute and render the status line in a single pass. */
export function renderStatusLine(state: RenderState, cols: number): StatusLineResult {
  const blocks = layoutBlocks(state, cols);
  if (blocks.length === 0) return { height: 0, lines: [] };

  const height = Math.max(...blocks.map(b => b.height));
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    lines.push(composeRow(blocks, i, cols));
  }
  return { height, lines };
}
