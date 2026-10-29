/**
 * Content-checked deltas of a running turn's live blocks and of a page entry
 * that grew (docs/ssh-history-cache.md). Like history-delta.ts, nothing here
 * assumes a stream position: a base is described by the content it holds, so
 * a stale or foreign base costs bytes, never correctness.
 */
import { createHash } from "node:crypto";
import type { Block } from "./messages";
import type { DisplayEntry, LiveBlocksBase, LiveBlocksDelta } from "./protocol";

/** At most this many blocks in a described base. */
export const MAX_LIVE_BASE_BLOCKS = 4096;

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Live blocks as kept and sent: tool output is left out (fetched with load_tool_outputs when shown). */
export function compactLiveBlock(block: Block): Block {
  return block.type === "tool_result" && block.output !== "" ? { ...block, output: "" } : block;
}

/** A block's identity in a base. Text and thinking hash their text alone, so a prefix can be checked. */
export function liveBlockHash(block: Block): string {
  return block.type === "text" || block.type === "thinking"
    ? shortHash(`${block.type}\n${block.text}`)
    : shortHash(JSON.stringify(block));
}

/** Describe blocks the client holds, so the next answer sends only what is newer. */
export function describeLiveBlocks(blocks: Block[]): LiveBlocksBase {
  const last = blocks.at(-1);
  return {
    hashes: blocks.map(liveBlockHash),
    ...(last && (last.type === "text" || last.type === "thinking") ? { tailChars: last.text.length } : {}),
  };
}

export function isLiveBlocksBase(value: unknown): value is LiveBlocksBase {
  if (!value || typeof value !== "object") return false;
  const base = value as LiveBlocksBase;
  return Array.isArray(base.hashes) && base.hashes.length <= MAX_LIVE_BASE_BLOCKS
    && base.hashes.every(hash => typeof hash === "string" && /^[a-f0-9]{32}$/.test(hash))
    && (base.tailChars === undefined || (Number.isSafeInteger(base.tailChars) && base.tailChars >= 0));
}

/**
 * `blocks` against `base`: the base's blocks that are unchanged, the last one
 * extended when it is text still growing, then the rest. Null when nothing of
 * the base can be kept (send `blocks` whole).
 */
export function encodeLiveBlocks(blocks: Block[], base: LiveBlocksBase | undefined): { delta: LiveBlocksDelta; blocks: Block[] } | null {
  if (!base || base.hashes.length === 0) return null;
  let keep = 0;
  while (keep < blocks.length && keep < base.hashes.length && liveBlockHash(blocks[keep]!) === base.hashes[keep]) keep++;
  let extend: string | undefined;
  // The base's last block, still streaming when the base was taken.
  const block = blocks[keep];
  if (keep === base.hashes.length - 1 && base.tailChars !== undefined && block
      && (block.type === "text" || block.type === "thinking") && block.text.length > base.tailChars
      && shortHash(`${block.type}\n${block.text.slice(0, base.tailChars)}`) === base.hashes[keep]) {
    extend = block.text.slice(base.tailChars);
  }
  if (keep === 0 && extend === undefined) return null;
  return {
    delta: { keep, ...(extend !== undefined ? { extend } : {}) },
    blocks: blocks.slice(extend !== undefined ? keep + 1 : keep),
  };
}

/** Rebuild blocks from the base they were encoded against. Throws when the base cannot hold them. */
export function decodeLiveBlocks(base: Block[], delta: LiveBlocksDelta, blocks: Block[]): Block[] {
  if (!Number.isSafeInteger(delta.keep) || delta.keep < 0 || delta.keep > base.length) throw new Error("Invalid live delta");
  const out = base.slice(0, delta.keep).map(block => structuredClone(block));
  if (delta.extend !== undefined) {
    const extended = base[delta.keep];
    if (!extended || (extended.type !== "text" && extended.type !== "thinking")) throw new Error("Invalid live extension");
    out.push({ ...structuredClone(extended), text: extended.text + delta.extend });
  }
  return [...out, ...blocks];
}

/** Per-block hashes of a page entry, so a later version that only grew can be sent as its new blocks. */
export function entryBlockHashes(entry: DisplayEntry): string[] | null {
  return entry.type === "ai" ? entry.blocks.map(block => shortHash(JSON.stringify(block))) : null;
}
