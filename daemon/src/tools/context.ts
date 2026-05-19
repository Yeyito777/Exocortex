/**
 * Context tool — lets the AI inspect and manage its own conversation context.
 *
 * Actions:
 *   list            — show all turns with token estimates
 *   stage           — validate and store a compaction plan without mutating context
 *   compact         — apply the staged plan once (summaries run in parallel)
 *
 * Unlike stateless tools, this one needs access to the live conversation.
 * The static tool definition (schema, display, summarize) is registered
 * normally in the TOOLS array; execution is routed through executeContext()
 * by the executor with injected conversation context.
 */

import type { Tool, ToolResult } from "./types";
import type { Conversation, StoredMessage, ApiMessage, ApiContentBlock } from "../messages";
import { buildHistoryTurnMap, createModelVisibleSystemNotice } from "../messages";
import { log } from "../log";
import { safeSlice } from "./util";
import { createHash } from "crypto";
import {
  clearMessageContextTokenAttribution,
  contextMessageCharBreakdown,
  contextMessageChars,
  contextMessageSignature,
  validContextTokenAttribution,
  type ContextTokenCategory,
} from "../context-token-attribution";
import { fmt, renderContextListRowSections, turnType, type ContextListRow } from "./context-render";

// ── Context tool environment ──────────────────────────────────────

/** Context passed to the context tool's execute function. */
export interface ContextToolEnv {
  /** The conversation being operated on. */
  conv: Conversation;
  /** Called after compact mutates persisted or in-progress context. */
  onContextModified: () => void;
  /** Tool summarizer for labeling tool_use blocks in the listing. */
  summarizer: (name: string, input: Record<string, unknown>) => string;
  /** Number of most-recent persisted history turns that are off-limits. */
  protectedTailCount: number;
  /** Max context window for the active model, if known. */
  contextLimit?: number | null;
  /** Provider-aware inner LLM runner used by summarize. */
  summarizeWithInnerLlm: (systemPrompt: string, userText: string, maxTokens: number, signal?: AbortSignal) => Promise<string>;
  /** Mutable in-flight assistant-turn messages, exposed by the agent loop. */
  currentTurnMessages?: ApiMessage[];
  /** Number of current-turn tail entries that are incomplete/unsafe to mutate. */
  protectedCurrentTurnTailCount?: number;
  /** One pending staged compaction plan. Kept in the live orchestration env only. */
  stagedCompaction?: StagedCompactionPlan | null;
}

type CompactionOpName = "summarize" | "forget" | "strip_thinking" | "strip_results";

interface RawCompactionOperation {
  op?: unknown;
  start?: unknown;
  end?: unknown;
  prompt?: unknown;
}

interface PlannedCompactionOperation {
  op: CompactionOpName;
  scope: MutableScope;
  start: number;
  end: number;
  globalStart: number;
  globalEnd: number;
  prompt?: string;
  estimatedTokens: number;
  estimatedSavingsTokens: number;
  snapped: boolean;
  sourceIndex: number;
}

interface StagedCompactionPlan {
  snapshotId: string;
  operations: PlannedCompactionOperation[];
}

interface ParsedContextSnapshotId {
  turnCount: number;
  hash: string;
}

const TARGET_UNDERSHOOT_FRACTION = 0.8;

// ── Helpers ───────────────────────────────────────────────────────

function formatTokenCountForDisplay(raw: unknown): string {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return String(raw);
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatRange(start: number, end: number): string | null {
  if (start > end) return null;
  return start === end ? `${start}` : `${start}–${end}`;
}

function joinRanges(ranges: Array<[number, number]>): string {
  const formatted = ranges
    .map(([start, end]) => formatRange(start, end))
    .filter((range): range is string => Boolean(range));
  return formatted.length > 0 ? formatted.join(", ") : "none";
}

/** Estimate tokens from character count, optionally scaling against a known context total. */
function estimateTokens(chars: number, totalChars: number, knownTotalTokens: number | null | undefined): number {
  if (knownTotalTokens && totalChars > 0) {
    return Math.round((chars / totalChars) * knownTotalTokens);
  }
  return Math.round(chars / 4);
}

function messageContextTokenEstimate(
  msg: StoredMessage,
  totalChars: number,
  knownTotalTokens: number | null | undefined,
  env: ContextToolEnv,
): number {
  const attr = validContextTokenAttribution(msg, env.conv.provider, env.conv.model);
  if (attr) return attr.totalTokens;
  return estimateTokens(contextMessageChars(msg, env.conv.provider), totalChars, knownTotalTokens);
}

function messageContextCategoryTokenEstimate(
  msg: StoredMessage,
  categories: ContextTokenCategory[],
  totalChars: number,
  knownTotalTokens: number | null | undefined,
  env: ContextToolEnv,
): number {
  const attr = validContextTokenAttribution(msg, env.conv.provider, env.conv.model);
  if (attr) return categories.reduce((sum, key) => sum + (attr.breakdown[key] ?? 0), 0);
  const breakdown = contextMessageCharBreakdown(msg, env.conv.provider);
  const chars = categories.reduce((sum, key) => sum + (breakdown[key] ?? 0), 0);
  return estimateTokens(chars, totalChars, knownTotalTokens);
}

function scopedMessagesAndMap(scope: MutableScope, env: ContextToolEnv): { messages: StoredMessage[]; turnMap: number[]; knownTokens: number | null } {
  if (scope === "history") return { messages: env.conv.messages, turnMap: buildHistoryTurnMap(env.conv.messages), knownTokens: env.conv.lastContextTokens ?? null };
  const messages = currentTurnStoredMessages(env);
  return { messages, turnMap: currentTurnMap(env), knownTokens: null };
}

function scopedTotalContextChars(messages: StoredMessage[], turnMap: number[], env: ContextToolEnv): number {
  return turnMap.reduce((sum, i) => sum + contextMessageChars(messages[i], env.conv.provider), 0);
}

/** Mark the conversation as structurally changed so token totals get recomputed. */
function markContextMutated(env: ContextToolEnv): void {
  env.conv.lastContextTokens = null;
  env.onContextModified();
}

function currentTurnStoredMessages(env: ContextToolEnv): StoredMessage[] {
  return (env.currentTurnMessages ?? []) as StoredMessage[];
}

function currentTurnFullMap(env: ContextToolEnv): number[] {
  return buildHistoryTurnMap(currentTurnStoredMessages(env));
}

function currentTurnMap(env: ContextToolEnv): number[] {
  return currentTurnFullMap(env);
}

function currentTurnVisibleProtectedTailCount(env: ContextToolEnv): number {
  return env.protectedCurrentTurnTailCount ?? 0;
}

function messageSnapshotSignature(msg: StoredMessage): string {
  const role = msg.role;
  const chars = contextMessageChars(msg);
  const contextSig = contextMessageSignature(msg);
  if (typeof msg.content === "string") {
    return `${role}:${chars}:${contextSig}:${safeSlice(msg.content, 64)}:${safeSlice(msg.content.slice(-64), 64)}`;
  }
  const blocks = msg.content.map((block) => {
    if (block.type === "tool_use") return `tool_use:${block.name}:${block.id}:${JSON.stringify(block.input).length}`;
    if (block.type === "tool_result") {
      const len = typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
      const sample = typeof block.content === "string" ? safeSlice(block.content, 32) : "structured";
      return `tool_result:${block.tool_use_id}:${len}:${sample}`;
    }
    if (block.type === "thinking") return `thinking:${block.thinking.length}:${block.signature.length}`;
    if (block.type === "text") return `text:${block.text.length}:${safeSlice(block.text, 32)}`;
    if (block.type === "image") return `image:${block.source.media_type}:${block.source.data.length}`;
    return "unknown";
  }).join("|");
  return `${role}:${chars}:${contextSig}:${blocks}`;
}

function combinedTurnCount(env: ContextToolEnv): number {
  return buildHistoryTurnMap(env.conv.messages).length + currentTurnMap(env).length;
}

function updateSnapshotHashForCombinedPrefix(env: ContextToolEnv, hash: ReturnType<typeof createHash>, turnCount: number): void {
  const historyMap = buildHistoryTurnMap(env.conv.messages);
  const currentMessages = currentTurnStoredMessages(env);
  const currentMap = currentTurnMap(env);
  const total = historyMap.length + currentMap.length;
  const count = Math.min(turnCount, total);

  hash.update(`v=2;turns=${count};`);
  for (let globalIdx = 0; globalIdx < count; globalIdx++) {
    const msg = globalIdx < historyMap.length
      ? env.conv.messages[historyMap[globalIdx]]
      : currentMessages[currentMap[globalIdx - historyMap.length]];
    // Deliberately hash only the combined message sequence, not whether a turn
    // currently lives in persisted history or the in-progress buffer.  Current
    // turns becoming persisted between list/stage is still append-only from the
    // model-visible global-index perspective.
    hash.update(`${globalIdx}:${messageSnapshotSignature(msg)};`);
  }
}

function contextSnapshotHash(env: ContextToolEnv, turnCount: number): string {
  const hash = createHash("sha256");
  updateSnapshotHashForCombinedPrefix(env, hash, turnCount);
  return hash.digest("hex").slice(0, 16);
}

function contextSnapshotId(env: ContextToolEnv): string {
  const turnCount = combinedTurnCount(env);
  return `ctx-n${turnCount}-${contextSnapshotHash(env, turnCount)}`;
}

function parseContextSnapshotId(snapshot: string): ParsedContextSnapshotId | null {
  const match = snapshot.match(/^ctx-n(\d+)-([0-9a-f]{16})$/);
  if (!match) return null;
  const turnCount = Number(match[1]);
  if (!Number.isSafeInteger(turnCount) || turnCount < 0) return null;
  return { turnCount, hash: match[2] };
}

function validateSnapshotPrefix(snapshot: string, env: ContextToolEnv): { ok: true; parsed: ParsedContextSnapshotId; appendedTurns: number } | { ok: false; currentSnapshot: string; reason: string } {
  const parsed = parseContextSnapshotId(snapshot);
  const currentSnapshot = contextSnapshotId(env);
  if (!parsed) {
    return { ok: false, currentSnapshot, reason: "snapshot id is from an older/unknown format" };
  }

  const currentTurns = combinedTurnCount(env);
  if (parsed.turnCount > currentTurns) {
    return { ok: false, currentSnapshot, reason: `snapshot referenced ${parsed.turnCount} turns, but only ${currentTurns} are present now` };
  }

  const currentPrefixHash = contextSnapshotHash(env, parsed.turnCount);
  if (currentPrefixHash !== parsed.hash) {
    return { ok: false, currentSnapshot, reason: "the listed prefix changed, usually because context was compacted or edited" };
  }

  return { ok: true, parsed, appendedTurns: currentTurns - parsed.turnCount };
}

function currentTurnMaxModifiable(env: ContextToolEnv): number {
  const visibleCount = currentTurnMap(env).length;
  return visibleCount - 1 - currentTurnVisibleProtectedTailCount(env);
}

function actionableRangeLines(env: ContextToolEnv): string[] {
  const historyMap = buildHistoryTurnMap(env.conv.messages);
  const currentMap = currentTurnMap(env);
  const historyCount = historyMap.length;
  const currentCount = currentMap.length;
  const historyMax = historyCount - 1 - env.protectedTailCount;
  const currentMaxLocal = currentCount - 1 - currentTurnVisibleProtectedTailCount(env);

  const mutationRanges: Array<[number, number]> = [];
  if (historyMax >= 0) mutationRanges.push([0, historyMax]);
  if (currentMaxLocal >= 0) mutationRanges.push([historyCount, historyCount + currentMaxLocal]);

  const protectedRanges: Array<[number, number]> = [];
  if (historyMax + 1 <= historyCount - 1) protectedRanges.push([Math.max(0, historyMax + 1), historyCount - 1]);
  if (historyCount + currentMaxLocal + 1 <= historyCount + currentCount - 1) {
    protectedRanges.push([historyCount + Math.max(0, currentMaxLocal + 1), historyCount + currentCount - 1]);
  }

  const lines = [
    "Actionable ranges (current indices):",
    `  stage summarize/forget/strip_thinking/strip_results: ${joinRanges(mutationRanges)}`,
    `  protected/unmodifiable: ${joinRanges(protectedRanges)}`,
    "  Flow: list → stage all desired operations against this snapshot → compact once. Appended turns do not invalidate the snapshot; compact/edit does.",
  ];
  return lines;
}

function contextTokenHeader(env: ContextToolEnv): string {
  const turnMap = buildHistoryTurnMap(env.conv.messages);
  const charCounts = turnMap.map(i => contextMessageChars(env.conv.messages[i], env.conv.provider));
  const totalChars = charCounts.reduce((a, b) => a + b, 0);
  const lastCtx = env.conv.lastContextTokens ?? null;
  const totalTokens = lastCtx ?? turnMap.map(i => messageContextTokenEstimate(env.conv.messages[i], totalChars, lastCtx, env)).reduce((a, b) => a + b, 0);
  const tokenNote = lastCtx ? "" : "  (estimated — no API token count available yet)";
  if (env.contextLimit && env.contextLimit > 0) {
    const pct = ((totalTokens / env.contextLimit) * 100).toFixed(1);
    return `Context: ${fmt(totalTokens)} tokens / ${fmt(env.contextLimit)} limit  (${pct}%)${tokenNote}`;
  }
  return `Context: ${fmt(totalTokens)} tokens / unknown limit${tokenNote}`;
}

function markCurrentTurnMutated(env: ContextToolEnv): void {
  // Current-turn messages are not persisted yet, but structural compactions
  // such as summarize splice the in-memory currentTurnMessages array. Tell the
  // agent loop to rebuild its full provider-history array from persisted
  // history + the compacted current-turn buffer before the next model call.
  env.conv.lastContextTokens = null;
  env.onContextModified();
}

// ── Validation helpers ────────────────────────────────────────────

/** Check if an assistant message contains tool_use blocks. */
function hasToolUse(msg: StoredMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: ApiContentBlock) => b.type === "tool_use");
}

/**
 * Snap a range so it doesn't split tool_use/tool_result atomic pairs.
 *
 * An assistant turn with tool_use blocks and the immediately following
 * tool_result turn are bonded — including one without the other would
 * break the API contract.  Instead of rejecting with an error, we
 * expand the boundary outward to include the whole pair.
 *
 * Returns the (possibly adjusted) range and whether it was changed.
 */
function snapRange(
  start: number,
  end: number,
  turnMap: number[],
  messages: StoredMessage[],
  maxModifiable: number,
): { start: number; end: number; snapped: boolean } {
  let s = start;
  let e = end;

  // If `start` lands on a tool_result whose assistant is just before
  // the range, pull start back to include the assistant.
  while (s > 0 && turnType(messages[turnMap[s]]) === "tool_result") {
    s--;
  }

  // If `end` lands on an assistant with tool_use whose tool_result is
  // just after the range, push end forward to include the tool_result.
  while (e < maxModifiable) {
    const msg = messages[turnMap[e]];
    if (msg.role === "assistant" && hasToolUse(msg)) {
      const next = e + 1 < turnMap.length ? messages[turnMap[e + 1]] : null;
      if (next && turnType(next) === "tool_result") {
        e++;
        continue;
      }
    }
    break;
  }

  return { start: s, end: e, snapped: s !== start || e !== end };
}

function validateRange(
  input: Record<string, unknown>,
  turnMap: number[],
  messages: StoredMessage[],
  protectedTailCount: number,
): { start: number; end: number; snapped: boolean; error?: string } {
  const rawStart = input.start as number | undefined;
  const rawEnd = input.end as number | undefined;

  if (rawStart == null || rawEnd == null) {
    return { start: 0, end: 0, snapped: false, error: "Both 'start' and 'end' turn indices are required." };
  }
  if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) {
    return { start: 0, end: 0, snapped: false, error: "'start' and 'end' must be integers." };
  }
  if (rawStart < 0 || rawStart >= turnMap.length) {
    return { start: 0, end: 0, snapped: false, error: `'start' index ${rawStart} is out of range (valid: 0–${turnMap.length - 1}).` };
  }
  if (rawEnd < 0) {
    return { start: 0, end: 0, snapped: false, error: `'end' index ${rawEnd} is out of range (valid: 0–${turnMap.length - 1}).` };
  }

  const maxModifiable = turnMap.length - 1 - protectedTailCount;
  if (maxModifiable < 0) {
    return { start: 0, end: 0, snapped: false, error: "No modifiable turns available." };
  }

  const clampedEnd = Math.min(rawEnd, maxModifiable);
  if (rawStart > clampedEnd) {
    return { start: 0, end: 0, snapped: false, error: `'start' (${rawStart}) must be <= clamped 'end' (${clampedEnd}).` };
  }

  // Snap to tool_use/tool_result boundaries
  const { start, end, snapped } = snapRange(rawStart, clampedEnd, turnMap, messages, maxModifiable);

  return { start, end, snapped };
}

// ── Action: list ──────────────────────────────────────────────────

function actionList(env: ContextToolEnv): ToolResult {
  const { conv, protectedTailCount } = env;
  const turnMap = buildHistoryTurnMap(conv.messages);
  const currentMessages = currentTurnStoredMessages(env);
  const curMap = currentTurnMap(env);

  if (turnMap.length === 0 && curMap.length === 0) {
    return { output: "No turns in the conversation (system messages and conversation instructions excluded).", isError: false };
  }

  const historyChars: number[] = turnMap.map(i => contextMessageChars(conv.messages[i], env.conv.provider));
  const historyTotalChars = historyChars.reduce((a, b) => a + b, 0);
  const lastCtx = conv.lastContextTokens ?? null;
  const historyTokens: number[] = turnMap.map(i => messageContextTokenEstimate(conv.messages[i], historyTotalChars, lastCtx, env));
  const totalTokens = lastCtx ?? historyTokens.reduce((a, b) => a + b, 0);
  const currentChars = curMap.map(i => contextMessageChars(currentMessages[i], env.conv.provider));
  const currentTotalChars = currentChars.reduce((a, b) => a + b, 0);
  const currentTokens = curMap.map(i => messageContextTokenEstimate(currentMessages[i], currentTotalChars, null, env));

  const historyMax = turnMap.length - 1 - protectedTailCount;
  const currentMax = currentTurnMaxModifiable(env);
  const rows: ContextListRow[] = [];
  for (let t = 0; t <= historyMax; t++) {
    rows.push({
      idx: t,
      msg: conv.messages[turnMap[t]],
      prevMsg: t > 0 ? conv.messages[turnMap[t - 1]] : null,
      tokens: historyTokens[t] ?? 0,
    });
  }
  for (let t = 0; t <= currentMax; t++) {
    rows.push({
      idx: turnMap.length + t,
      msg: currentMessages[curMap[t]],
      prevMsg: t > 0
        ? currentMessages[curMap[t - 1]]
        : turnMap.length > 0 ? conv.messages[turnMap[turnMap.length - 1]] : null,
      tokens: currentTokens[t] ?? 0,
    });
  }

  const lines: string[] = [];
  lines.push("CONTEXT");
  lines.push(`  ${contextTokenHeader(env)}`);
  lines.push(`  Snapshot: ${contextSnapshotId(env)}`);
  lines.push("");
  lines.push("ACTIONABLE");
  lines.push(...actionableRangeLines(env));
  lines.push("");
  lines.push("PLANNING NOTES");
  lines.push(`  Visible turns: persisted ${turnMap.length} (${Math.max(0, historyMax + 1)} modifiable), in-progress ${curMap.length} (${Math.max(0, currentMax + 1)} modifiable).`);
  lines.push("  Card format: #index type/tool tokens; in/out previews are bounded and semantic, not raw dumps.");
  lines.push("  Use the least destructive operations needed for the target. If the user gave a token target, pass targetTokens to stage.");

  const byType: Record<string, number> = { user: 0, assistant: 0, tool_result: 0, system_hint: 0 };
  for (let t = 0; t < turnMap.length; t++) {
    byType[turnType(conv.messages[turnMap[t]])] += historyTokens[t] ?? 0;
  }
  const breakdown = Object.entries(byType)
    .map(([k, v]) => `${k} ${totalTokens > 0 ? ((v / totalTokens) * 100).toFixed(1) : "0.0"}%`)
    .join(" | ");
  lines.push(`  Breakdown: ${breakdown}`);

  lines.push(...renderContextListRowSections(rows, totalTokens, turnMap.length));

  lines.push("", `Stage against snapshot ${contextSnapshotId(env)}; compact once when the full plan is staged. The snapshot remains usable across appended turns.`);

  return { output: lines.join("\n"), isError: false };
}

// ── Scoped mutation helpers ─────────────────────────────────────

type MutableScope = "history" | "current";

interface ScopedRange {
  scope: MutableScope;
  messages: StoredMessage[];
  turnMap: number[];
  start: number;
  end: number;
  globalStart: number;
  globalEnd: number;
  snapped: boolean;
}

interface ScopedRangesResult {
  ranges: ScopedRange[];
  notes: string[];
}

function validateScopedRanges(
  input: Record<string, unknown>,
  env: ContextToolEnv,
  action: string,
  options: { allowCurrent?: boolean } = { allowCurrent: true },
): ScopedRangesResult | { error: string } {
  const rawStart = input.start as number | undefined;
  const rawEnd = input.end as number | undefined;
  if (rawStart == null || rawEnd == null) return { error: "Both 'start' and 'end' turn indices are required." };
  if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return { error: "'start' and 'end' must be integers." };
  if (rawEnd < 0) return { error: `'end' index ${rawEnd} is out of range.` };

  const historyMap = buildHistoryTurnMap(env.conv.messages);
  const currentMessages = currentTurnStoredMessages(env);
  const currentMap = currentTurnMap(env);
  const historyCount = historyMap.length;
  const totalCount = historyCount + currentMap.length;
  if (totalCount === 0) return { error: "No turns available." };
  if (rawStart < 0 || rawStart >= totalCount) return { error: `'start' index ${rawStart} is out of range (valid: 0–${totalCount - 1}).` };

  const clampedRawEnd = Math.min(rawEnd, totalCount - 1);
  if (rawStart > clampedRawEnd) return { error: `'start' (${rawStart}) must be <= clamped 'end' (${clampedRawEnd}).` };

  const ranges: ScopedRange[] = [];
  const notes: string[] = [];
  if (rawEnd !== clampedRawEnd) notes.push(`Requested end ${rawEnd} was clamped to last listed turn ${clampedRawEnd}.`);

  if (rawStart < historyCount) {
    const historyEnd = Math.min(clampedRawEnd, historyCount - 1);
    const historyMax = historyCount - 1 - env.protectedTailCount;
    if (historyMax < rawStart) {
      notes.push(`Skipped protected persisted turns ${formatRange(rawStart, historyEnd) ?? rawStart}.`);
    } else {
      const legalEnd = Math.min(historyEnd, historyMax);
      if (legalEnd < historyEnd) notes.push(`Skipped protected persisted turns ${formatRange(legalEnd + 1, historyEnd) ?? historyEnd}.`);
      const validated = validateRange({ ...input, start: rawStart, end: legalEnd }, historyMap, env.conv.messages, env.protectedTailCount);
      if (validated.error) notes.push(`Skipped persisted turns ${formatRange(rawStart, legalEnd) ?? rawStart}: ${validated.error}`);
      else ranges.push({
        scope: "history",
        messages: env.conv.messages,
        turnMap: historyMap,
        start: validated.start,
        end: validated.end,
        globalStart: validated.start,
        globalEnd: validated.end,
        snapped: validated.snapped,
      });
    }
  }

  if (clampedRawEnd >= historyCount && currentMap.length > 0) {
    const currentStart = Math.max(rawStart - historyCount, 0);
    const currentEnd = clampedRawEnd - historyCount;
    if (options.allowCurrent === false) {
      notes.push(`Skipped in-progress assistant message turns ${formatRange(historyCount + currentStart, historyCount + currentEnd) ?? historyCount + currentStart}; ${action} does not support them.`);
    } else {
      const currentProtectedTailCount = currentTurnVisibleProtectedTailCount(env);
      const currentMax = currentMap.length - 1 - currentProtectedTailCount;
      if (currentMax < currentStart) {
        notes.push(`Skipped protected in-progress turns ${formatRange(historyCount + currentStart, historyCount + currentEnd) ?? historyCount + currentStart}.`);
      } else {
        const legalEnd = Math.min(currentEnd, currentMax);
        if (legalEnd < currentEnd) notes.push(`Skipped protected in-progress turns ${formatRange(historyCount + legalEnd + 1, historyCount + currentEnd) ?? historyCount + currentEnd}.`);
        const validated = validateRange({ ...input, start: currentStart, end: legalEnd }, currentMap, currentMessages, currentProtectedTailCount);
        if (validated.error) notes.push(`Skipped in-progress turns ${formatRange(historyCount + currentStart, historyCount + legalEnd) ?? historyCount + currentStart}: ${validated.error}`);
        else ranges.push({
          scope: "current",
          messages: currentMessages,
          turnMap: currentMap,
          start: validated.start,
          end: validated.end,
          globalStart: historyCount + validated.start,
          globalEnd: historyCount + validated.end,
          snapped: validated.snapped,
        });
      }
    }
  }

  return { ranges, notes };
}

function markRangeMutated(env: ContextToolEnv, scope: MutableScope): void {
  if (scope === "current") markCurrentTurnMutated(env);
  else markContextMutated(env);
}

function extractRangeTextForSummary(
  messages: StoredMessage[],
  turnMap: number[],
  start: number,
  end: number,
  summarizer: (name: string, input: Record<string, unknown>) => string,
  options: { stripThinking?: (turn: number) => boolean; stripResults?: (turn: number) => boolean } = {},
): string {
  const textParts: string[] = [];
  for (let t = start; t <= end; t++) {
    const msg = messages[turnMap[t]];
    const tt = turnType(msg);

    if (tt === "user" || tt === "system_hint") {
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content as ApiContentBlock[])
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join("\n");
      textParts.push(`${tt === "system_hint" ? "System hint" : "User"}: ${text}`);
    } else if (tt === "assistant") {
      if (typeof msg.content === "string") {
        textParts.push(`Assistant: ${msg.content}`);
      } else {
        const parts: string[] = [];
        for (const b of msg.content as ApiContentBlock[]) {
          if (b.type === "thinking") {
            if (!options.stripThinking?.(t)) parts.push(b.thinking);
          }
          else if (b.type === "text") parts.push(b.text);
          else if (b.type === "tool_use") parts.push(`Tool call: ${b.name}(${summarizer(b.name, b.input)})`);
        }
        textParts.push(`Assistant: ${parts.join("\n")}`);
      }
    } else if (tt === "tool_result" && Array.isArray(msg.content)) {
      const prevTurnIdx = t - 1;
      const prevMsg = prevTurnIdx >= 0 ? messages[turnMap[prevTurnIdx]] : null;
      const toolUseMap = new Map<string, string>();
      if (prevMsg && Array.isArray(prevMsg.content)) {
        for (const b of prevMsg.content as ApiContentBlock[]) {
          if (b.type === "tool_use") toolUseMap.set(b.id, b.name);
        }
      }
      const results: string[] = [];
      for (const b of msg.content as ApiContentBlock[]) {
        if (b.type === "tool_result") {
          const name = toolUseMap.get(b.tool_use_id) ?? "unknown";
          const output = options.stripResults?.(t)
            ? STRIPPED_PLACEHOLDER
            : typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          results.push(`${name}: ${output}`);
        }
      }
      textParts.push(`Tool results: ${results.join("\n")}`);
    }
  }
  return textParts.join("\n\n");
}

const MIN_SUMMARIZE_TOKENS = 500;
const STRIPPED_PLACEHOLDER = "[Output removed by context tool]";

function normalizeCompactionOp(raw: unknown): CompactionOpName | null {
  if (typeof raw !== "string") return null;
  switch (raw) {
    case "summarize":
    case "strip_thinking":
    case "strip_results":
      return raw;
    case "forget":
      return "forget";
    default:
      return null;
  }
}

function scopedRangeTokenEstimate(scoped: ScopedRange, env: ContextToolEnv): number {
  const totalChars = scopedTotalContextChars(scoped.messages, scoped.turnMap, env);
  const known = scoped.scope === "history" ? env.conv.lastContextTokens ?? null : null;
  let tokens = 0;
  for (let t = scoped.start; t <= scoped.end; t++) {
    tokens += messageContextTokenEstimate(scoped.messages[scoped.turnMap[t]], totalChars, known, env);
  }
  return tokens;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1] + 1) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}

function estimateTokenRanges(scope: MutableScope, ranges: Array<[number, number]>, env: ContextToolEnv): number {
  const { messages, turnMap, knownTokens } = scopedMessagesAndMap(scope, env);
  const totalChars = scopedTotalContextChars(messages, turnMap, env);
  let tokens = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    for (let t = start; t <= end; t++) tokens += messageContextTokenEstimate(messages[turnMap[t]], totalChars, knownTokens, env);
  }
  return tokens;
}

function uniquePlannedTokenEstimate(ops: PlannedCompactionOperation[], env: ContextToolEnv): number {
  return estimateTokenRanges("history", ops.filter((op) => op.scope === "history").map((op) => [op.start, op.end]), env)
    + estimateTokenRanges("current", ops.filter((op) => op.scope === "current").map((op) => [op.start, op.end]), env);
}

function estimatedVisibleContextTokens(env: ContextToolEnv): number {
  const historyMap = buildHistoryTurnMap(env.conv.messages);
  const historyChars = historyMap.map((idx) => contextMessageChars(env.conv.messages[idx], env.conv.provider));
  const historyTotalChars = historyChars.reduce((sum, ch) => sum + ch, 0);
  const historyTokens = env.conv.lastContextTokens
    ?? historyMap.map((idx) => messageContextTokenEstimate(env.conv.messages[idx], historyTotalChars, null, env)).reduce((sum, tok) => sum + tok, 0);

  const currentMessages = currentTurnStoredMessages(env);
  const currentMap = currentTurnMap(env);
  const currentChars = currentMap.map((idx) => contextMessageChars(currentMessages[idx], env.conv.provider));
  const currentTotalChars = currentChars.reduce((sum, ch) => sum + ch, 0);
  const currentTokens = currentMap.map((idx) => messageContextTokenEstimate(currentMessages[idx], currentTotalChars, null, env)).reduce((sum, tok) => sum + tok, 0);

  return historyTokens + currentTokens;
}

function estimatedSummarizeReplacementTokens(inputTokens: number): number {
  return Math.min(4096, Math.max(256, Math.round(inputTokens / 2))) + 32;
}

function toolResultSavedCharsInMessage(msg: StoredMessage): number {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return 0;
  let saved = 0;
  for (const block of msg.content as ApiContentBlock[]) {
    if (block.type !== "tool_result") continue;
    if (block.content === STRIPPED_PLACEHOLDER) continue;
    const oldLen = typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
    saved += Math.max(0, oldLen - STRIPPED_PLACEHOLDER.length);
  }
  return saved;
}

function thinkingSavedCharsInMessage(msg: StoredMessage, provider?: Conversation["provider"]): number {
  if (msg.role !== "assistant") return 0;
  const breakdown = contextMessageCharBreakdown(msg, provider);
  let removableVisibleThinking = breakdown.thinking;
  if (Array.isArray(msg.content)) {
    const blocks = msg.content as ApiContentBlock[];
    const hasThinking = blocks.some((b) => b.type === "thinking");
    const hasNonThinking = blocks.some((b) => b.type !== "thinking");
    // stripThinkingForPlan preserves a thinking-only assistant turn rather than
    // leaving an empty assistant message, so do not claim those visible tokens as
    // savings. Provider reasoning state, if any, is still removable.
    if (hasThinking && !hasNonThinking) removableVisibleThinking = 0;
  }
  return removableVisibleThinking + breakdown.providerReasoning;
}

function estimateSavingsFromMessageCategory(
  msg: StoredMessage,
  savedChars: number,
  categories: ContextTokenCategory[],
  totalChars: number,
  knownTokens: number | null,
  env: ContextToolEnv,
): number {
  if (savedChars <= 0) return 0;
  const breakdown = contextMessageCharBreakdown(msg, env.conv.provider);
  const categoryChars = categories.reduce((sum, key) => sum + (breakdown[key] ?? 0), 0);
  const categoryTokens = messageContextCategoryTokenEstimate(msg, categories, totalChars, knownTokens, env);
  if (categoryChars > 0 && categoryTokens > 0) {
    return Math.max(0, Math.round(categoryTokens * Math.min(1, savedChars / categoryChars)));
  }
  return estimateTokens(savedChars, totalChars, knownTokens);
}

function estimateStripSavingsForRanges(
  scope: MutableScope,
  opName: Extract<CompactionOpName, "strip_thinking" | "strip_results">,
  ranges: Array<[number, number]>,
  env: ContextToolEnv,
): number {
  const { messages, turnMap, knownTokens } = scopedMessagesAndMap(scope, env);
  const totalChars = scopedTotalContextChars(messages, turnMap, env);
  let tokens = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    for (let t = start; t <= end; t++) {
      const msg = messages[turnMap[t]];
      if (opName === "strip_results") {
        tokens += estimateSavingsFromMessageCategory(msg, toolResultSavedCharsInMessage(msg), ["toolResultText", "toolResultImage"], totalChars, knownTokens, env);
      } else {
        tokens += estimateSavingsFromMessageCategory(msg, thinkingSavedCharsInMessage(msg, env.conv.provider), ["thinking", "providerReasoning"], totalChars, knownTokens, env);
      }
    }
  }
  return tokens;
}

function subtractRange(range: [number, number], blockers: Array<[number, number]>): Array<[number, number]> {
  let remaining: Array<[number, number]> = [range];
  for (const [blockStart, blockEnd] of mergeRanges(blockers)) {
    const next: Array<[number, number]> = [];
    for (const [start, end] of remaining) {
      if (blockEnd < start || blockStart > end) {
        next.push([start, end]);
        continue;
      }
      if (start < blockStart) next.push([start, blockStart - 1]);
      if (blockEnd < end) next.push([blockEnd + 1, end]);
    }
    remaining = next;
    if (remaining.length === 0) break;
  }
  return remaining;
}

function projectedPlanTokens(ops: PlannedCompactionOperation[], env: ContextToolEnv): { currentTokens: number; projectedTokens: number; estimatedSavings: number } {
  const currentTokens = estimatedVisibleContextTokens(env);
  let savings = 0;
  const structuralByScope: Record<MutableScope, Array<[number, number]>> = { history: [], current: [] };

  for (const op of ops) {
    if (op.op !== "summarize" && op.op !== "forget") continue;
    structuralByScope[op.scope].push([op.start, op.end]);
    const replacementTokens = op.op === "summarize" ? estimatedSummarizeReplacementTokens(op.estimatedTokens) : 0;
    savings += Math.max(0, op.estimatedTokens - replacementTokens);
  }

  for (const op of ops) {
    if (!isStripOp(op.op)) continue;
    const outsideStructural = subtractRange([op.start, op.end], structuralByScope[op.scope]);
    if (outsideStructural.length === 0) continue;
    savings += estimateStripSavingsForRanges(op.scope, op.op, outsideStructural, env);
  }

  savings = Math.min(currentTokens, Math.max(0, savings));
  return { currentTokens, projectedTokens: Math.max(0, currentTokens - savings), estimatedSavings: savings };
}

function parseTokenTarget(raw: unknown): number | null | { error: string } {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return { error: "targetTokens must be a positive number." };
    return Math.round(raw);
  }
  if (typeof raw === "string") {
    const match = raw.trim().match(/^(\d+(?:\.\d+)?)(k)?$/i);
    if (!match) return { error: "targetTokens must be a positive token count, e.g. 100000 or 100k." };
    const value = Number(match[1]) * (match[2] ? 1000 : 1);
    if (!Number.isFinite(value) || value <= 0) return { error: "targetTokens must be a positive token count." };
    return Math.round(value);
  }
  return { error: "targetTokens must be a positive token count." };
}

function hasAllowedOverlaps(ops: PlannedCompactionOperation[]): boolean {
  for (let i = 0; i < ops.length; i++) {
    for (let j = i + 1; j < ops.length; j++) {
      if (operationsOverlap(ops[i], ops[j]) && overlapAllowed(ops[i], ops[j])) return true;
    }
  }
  return false;
}

function plannedOpSummary(op: PlannedCompactionOperation): string {
  const snapNote = op.snapped ? " adjusted" : "";
  return `${op.op} ${op.globalStart}–${op.globalEnd}${snapNote}: ~${fmt(op.estimatedTokens)} tok, est. save ~${fmt(op.estimatedSavingsTokens)} tok`;
}

function operationsOverlap(a: PlannedCompactionOperation, b: PlannedCompactionOperation): boolean {
  return a.scope === b.scope && a.start <= b.end && b.start <= a.end;
}

function isStripOp(op: CompactionOpName): op is Extract<CompactionOpName, "strip_thinking" | "strip_results"> {
  return op === "strip_thinking" || op === "strip_results";
}

function overlapAllowed(a: PlannedCompactionOperation, b: PlannedCompactionOperation): boolean {
  // Strip ops are non-structural: they do not change indices, and if a
  // summarize/forget later replaces the same turns, the structural op simply
  // consumes that overlap. Reject only overlaps between structural operations.
  return isStripOp(a.op) || isStripOp(b.op);
}

function validateNoAmbiguousOverlaps(ops: PlannedCompactionOperation[]): string | null {
  for (let i = 0; i < ops.length; i++) {
    for (let j = i + 1; j < ops.length; j++) {
      const a = ops[i];
      const b = ops[j];
      if (!operationsOverlap(a, b) || overlapAllowed(a, b)) continue;
      return `Staged structural operations overlap ambiguously: #${a.sourceIndex + 1} ${a.op} ${a.globalStart}–${a.globalEnd} and #${b.sourceIndex + 1} ${b.op} ${b.globalStart}–${b.globalEnd}. Use one structural operation for that range. Strip operations may overlap structural operations.`;
    }
  }
  return null;
}

function actionStage(input: Record<string, unknown>, env: ContextToolEnv): ToolResult {
  // A stage call is a new planning attempt. Clear any older pending plan first
  // so an invalid restage cannot accidentally leave stale instructions behind.
  env.stagedCompaction = null;

  const operations = input.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { output: `No operations supplied. Use action='stage' with operations like [{"op":"summarize","start":10,"end":100}], then run action='compact'. No context was modified.`, isError: true };
  }

  const parsedTarget = parseTokenTarget(input.targetTokens);
  if (parsedTarget && typeof parsedTarget === "object") {
    return { output: `${parsedTarget.error} No context was modified and no plan was staged.`, isError: true };
  }
  const targetTokens = typeof parsedTarget === "number" ? parsedTarget : null;
  const allowOvershoot = input.allowOvershoot === true;

  const requestedSnapshot = typeof input.snapshot === "string" ? input.snapshot : undefined;
  if (!requestedSnapshot) {
    return { output: "Stage requires the snapshot id from a prior context list call. No context was modified.", isError: true };
  }
  const snapshotCheck = validateSnapshotPrefix(requestedSnapshot, env);
  if (!snapshotCheck.ok) {
    return { output: `Snapshot ${requestedSnapshot} is no longer usable: ${snapshotCheck.reason}. Current snapshot is ${snapshotCheck.currentSnapshot}. No context was modified; run context list before staging.`, isError: true };
  }
  const snapshotId = requestedSnapshot;

  const planned: PlannedCompactionOperation[] = [];
  const notes: string[] = [];
  if (snapshotCheck.appendedTurns > 0) {
    notes.push(`Snapshot has ${snapshotCheck.appendedTurns} appended turn${snapshotCheck.appendedTurns !== 1 ? "s" : ""} since list; earlier indices remain valid because context only appended.`);
  }

  for (let i = 0; i < operations.length; i++) {
    const raw = operations[i] as RawCompactionOperation;
    if (!raw || typeof raw !== "object") {
      notes.push(`Skipped operation #${i + 1}: expected an object.`);
      continue;
    }
    const op = normalizeCompactionOp(raw.op);
    if (!op) {
      notes.push(`Skipped operation #${i + 1}: unknown op '${String(raw.op)}'. Valid ops: summarize, forget, strip_thinking, strip_results.`);
      continue;
    }
    if (!Number.isInteger(raw.start) || !Number.isInteger(raw.end)) {
      notes.push(`Skipped operation #${i + 1} (${op}): start/end must be integer turn indices.`);
      continue;
    }

    const scoped = validateScopedRanges(
      { start: raw.start as number, end: raw.end as number },
      env,
      op,
      { allowCurrent: true },
    );
    if ("error" in scoped) {
      notes.push(`Skipped operation #${i + 1} (${op} ${raw.start}–${raw.end}): ${scoped.error}`);
      continue;
    }
    notes.push(...scoped.notes.map((note) => `Operation #${i + 1}: ${note}`));

    for (const range of scoped.ranges) {
      const estimatedTokens = scopedRangeTokenEstimate(range, env);
      if (op === "summarize" && estimatedTokens < MIN_SUMMARIZE_TOKENS) {
        notes.push(`Skipped operation #${i + 1} summarize ${range.globalStart}–${range.globalEnd}: only ~${fmt(estimatedTokens)} tokens (minimum ${fmt(MIN_SUMMARIZE_TOKENS)}).`);
        continue;
      }
      const estimatedSavingsTokens = op === "summarize"
        ? Math.max(0, estimatedTokens - estimatedSummarizeReplacementTokens(estimatedTokens))
        : op === "forget"
          ? estimatedTokens
          : estimateStripSavingsForRanges(range.scope, op, [[range.start, range.end]], env);
      planned.push({
        op,
        scope: range.scope,
        start: range.start,
        end: range.end,
        globalStart: range.globalStart,
        globalEnd: range.globalEnd,
        prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
        estimatedTokens,
        estimatedSavingsTokens,
        snapped: range.snapped,
        sourceIndex: i,
      });
    }
  }

  const overlapError = validateNoAmbiguousOverlaps(planned);
  if (overlapError) {
    return { output: `${overlapError}\nNo context was modified and no plan was staged.`, isError: true };
  }

  if (planned.length === 0) {
    const noteText = notes.length > 0 ? `\n${notes.join("\n")}` : "";
    return { output: `No compaction operations were staged.${noteText}\nNo context was modified. Run context list if you need fresh indices.`, isError: false };
  }

  const touchedTokens = uniquePlannedTokenEstimate(planned, env);
  const projection = projectedPlanTokens(planned, env);
  if (targetTokens != null) {
    const lowerBound = Math.round(targetTokens * TARGET_UNDERSHOOT_FRACTION);
    if (projection.projectedTokens < lowerBound && !allowOvershoot) {
      const opLines = planned.map((op, idx) => `  ${idx + 1}. ${plannedOpSummary(op)}`);
      const notesText = notes.length > 0 ? `\n\nNotes:\n${notes.map((note) => `  - ${note}`).join("\n")}` : "";
      return {
        output: [
          `Plan would over-compact relative to targetTokens ${fmt(targetTokens)}.`,
          `Current context: ~${fmt(projection.currentTokens)} tok; projected after compact: ~${fmt(projection.projectedTokens)} tok; lower bound: ~${fmt(lowerBound)} tok (${Math.round(TARGET_UNDERSHOOT_FRACTION * 100)}% of target).`,
          "No context was modified and no plan was staged.",
          "Use narrower summarize/forget ranges, strip selected tool results/thinking first, or set allowOvershoot=true if this much compression is intentional.",
          "",
          "Rejected operations:",
          ...opLines,
        ].join("\n") + notesText,
        isError: true,
      };
    }
  }

  env.stagedCompaction = {
    snapshotId,
    operations: planned,
  };
  log("info", `context tool: staged ${planned.length} operation(s) for ${env.conv.id} snapshot=${snapshotId} projected=${projection.projectedTokens} target=${targetTokens ?? "none"}`);

  const lines = [
    `Staged ${planned.length} context compaction operation${planned.length !== 1 ? "s" : ""} against snapshot ${snapshotId}.`,
    `Estimated touched tokens: ~${fmt(touchedTokens)}; projected context after compact: ~${fmt(projection.projectedTokens)} tok (save ~${fmt(projection.estimatedSavings)}).`,
    "No context was modified yet, so planning did not invalidate prior context/cache.",
    "Run context compact to apply this staged plan once.",
  ];
  if (targetTokens != null) {
    const delta = projection.projectedTokens - targetTokens;
    lines.push(`Target: ~${fmt(targetTokens)} tok; projected ${delta >= 0 ? "above" : "below"} target by ~${fmt(Math.abs(delta))} tok${allowOvershoot ? " (allowOvershoot=true)" : ""}.`);
  } else if (projection.projectedTokens < Math.round(projection.currentTokens * 0.5)) {
    lines.push("Aggressive plan: projected context is less than half of current. If the user gave a target, restage with targetTokens to avoid over-compaction.");
  }
  if (hasAllowedOverlaps(planned)) lines.push("Overlapping strip operations are accepted; compact applies them before/inside summaries.");
  lines.push("", "Staged operations:", ...planned.map((op, idx) => `  ${idx + 1}. ${plannedOpSummary(op)}`));
  if (notes.length > 0) lines.push("", "Notes:", ...notes.map((note) => `  - ${note}`));
  return { output: lines.join("\n"), isError: false };
}

interface PreparedStructuralMutation {
  op: "summarize" | "forget";
  scope: MutableScope;
  messages: StoredMessage[];
  insertIdx: number;
  deleteCount: number;
  globalStart: number;
  globalEnd: number;
  replacement: StoredMessage[];
  resultLine: string;
}

function stripThinkingForPlan(op: PlannedCompactionOperation, env: ContextToolEnv): { count: number; removedChars: number } {
  const messages = op.scope === "history" ? env.conv.messages : currentTurnStoredMessages(env);
  const turnMap = op.scope === "history" ? buildHistoryTurnMap(env.conv.messages) : currentTurnMap(env);
  let count = 0;
  let removedChars = 0;
  for (let t = op.start; t <= op.end; t++) {
    const msg = messages[turnMap[t]];
    if (msg.role !== "assistant") continue;
    const before = thinkingSavedCharsInMessage(msg);
    let changed = false;
    if (Array.isArray(msg.content)) {
      const blocks = msg.content as ApiContentBlock[];
      const thinkingBlocks = blocks.filter((b) => b.type === "thinking");
      const filtered = blocks.filter((b) => b.type !== "thinking");
      if (thinkingBlocks.length > 0 && filtered.length > 0) {
        msg.content = filtered;
        changed = true;
      }
    }
    const openai = msg.providerData?.openai;
    if (openai?.reasoningItems && openai.reasoningItems.length > 0) {
      openai.reasoningItems = [];
      changed = true;
    }
    if (!changed) continue;
    clearMessageContextTokenAttribution(msg);
    removedChars += before;
    count++;
  }
  return { count, removedChars };
}

function stripResultsForPlan(op: PlannedCompactionOperation, env: ContextToolEnv): { count: number; removedChars: number } {
  const messages = op.scope === "history" ? env.conv.messages : currentTurnStoredMessages(env);
  const turnMap = op.scope === "history" ? buildHistoryTurnMap(env.conv.messages) : currentTurnMap(env);
  let count = 0;
  let removedChars = 0;
  for (let t = op.start; t <= op.end; t++) {
    const msg = messages[turnMap[t]];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as ApiContentBlock[]) {
      if (block.type !== "tool_result") continue;
      const oldLen = typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
      if (block.content === STRIPPED_PLACEHOLDER) continue;
      const saved = oldLen - STRIPPED_PLACEHOLDER.length;
      if (saved <= 0) continue;
      (block as { content: string }).content = STRIPPED_PLACEHOLDER;
      clearMessageContextTokenAttribution(msg);
      removedChars += saved;
      count++;
    }
  }
  return { count, removedChars };
}

async function prepareSummarizeMutation(
  op: PlannedCompactionOperation,
  allOps: PlannedCompactionOperation[],
  env: ContextToolEnv,
  signal?: AbortSignal,
): Promise<PreparedStructuralMutation> {
  const messages = op.scope === "history" ? env.conv.messages : currentTurnStoredMessages(env);
  const turnMap = op.scope === "history" ? buildHistoryTurnMap(env.conv.messages) : currentTurnMap(env);
  const maxTokens = Math.min(4096, Math.max(256, Math.round(op.estimatedTokens / 2)));
  let systemPrompt = `You are a conversation summarizer. You receive a portion of a conversation
between a user and an AI assistant (including tool calls and results).
Produce a concise summary that preserves:
- Key decisions and conclusions
- Important code snippets, file paths, and commands
- What tools were used and their significant outputs
- Any errors encountered and how they were resolved
Omit redundant tool outputs (e.g., full file contents that were only read for reference).
Your output MUST be shorter than the input — aim for at most ${fmt(maxTokens)} tokens.
Output plain text, not markdown.`;
  if (op.prompt) systemPrompt += `\n\nAdditional instructions: ${op.prompt}`;
  if (op.scope === "current") systemPrompt += "\n\nThis range is from the in-progress assistant message. Preserve facts needed to continue the current task.";

  const stripOps = allOps.filter((other) => other.scope === op.scope && isStripOp(other.op) && operationsOverlap(op, other));
  const shouldStripThinking = (turn: number) => stripOps.some((other) => other.op === "strip_thinking" && other.start <= turn && turn <= other.end);
  const shouldStripResults = (turn: number) => stripOps.some((other) => other.op === "strip_results" && other.start <= turn && turn <= other.end);

  const summaryText = await env.summarizeWithInnerLlm(
    systemPrompt,
    extractRangeTextForSummary(messages, turnMap, op.start, op.end, env.summarizer, {
      stripThinking: shouldStripThinking,
      stripResults: shouldStripResults,
    }),
    maxTokens,
    signal,
  );
  const insertIdx = turnMap[op.start];
  const deleteCount = turnMap[op.end] + 1 - insertIdx;
  const replacement = op.scope === "current"
    ? [createModelVisibleSystemNotice(
        `[Summary of in-progress assistant message turns ${op.globalStart}–${op.globalEnd}]\n${summaryText}`,
        env.conv.model,
        "current_turn_summary",
      )]
    : [
        { role: "user" as const, content: `[Summary of turns ${op.globalStart}–${op.globalEnd}]`, metadata: null },
        { role: "assistant" as const, content: summaryText, metadata: null },
      ];
  const summaryTokens = Math.round(summaryText.length / 4);
  return {
    op: "summarize",
    scope: op.scope,
    messages,
    insertIdx,
    deleteCount,
    globalStart: op.globalStart,
    globalEnd: op.globalEnd,
    replacement,
    resultLine: `summarized ${op.globalStart}–${op.globalEnd} into ${op.scope === "current" ? "1 model-visible summary notice" : "2 turns"} (~${fmt(op.estimatedTokens)} → ~${fmt(summaryTokens)} tok)`,
  };
}

function prepareForgetMutation(op: PlannedCompactionOperation, env: ContextToolEnv): PreparedStructuralMutation {
  const messages = op.scope === "current" ? currentTurnStoredMessages(env) : env.conv.messages;
  const turnMap = op.scope === "current" ? currentTurnMap(env) : buildHistoryTurnMap(messages);
  const insertIdx = turnMap[op.start];
  const deleteCount = turnMap[op.end] + 1 - insertIdx;
  return {
    op: "forget",
    scope: op.scope,
    messages,
    insertIdx,
    deleteCount,
    globalStart: op.globalStart,
    globalEnd: op.globalEnd,
    replacement: [],
    resultLine: `forgot ${op.scope === "current" ? "in-progress" : "persisted"} turns ${op.globalStart}–${op.globalEnd} (~${fmt(op.estimatedTokens)} tok removed)`,
  };
}

async function actionCompact(input: Record<string, unknown>, env: ContextToolEnv, signal?: AbortSignal): Promise<ToolResult> {
  const plan = env.stagedCompaction;
  if (!plan || plan.operations.length === 0) {
    return { output: "No staged context compaction plan. Run context list, then context stage with operations, then context compact. No context was modified.", isError: true };
  }

  const snapshotCheck = validateSnapshotPrefix(plan.snapshotId, env);
  if (!snapshotCheck.ok) {
    env.stagedCompaction = null;
    return { output: `Staged compaction snapshot ${plan.snapshotId} is no longer usable: ${snapshotCheck.reason}. Current snapshot is ${snapshotCheck.currentSnapshot}. No context was modified. The staged plan was cleared; run context list and stage again.`, isError: true };
  }

  // Once validation passes, consume the plan even if a later summarizer call
  // fails. Keeping a failed plan retryable sounds convenient, but it reopens the
  // loop/cache hazards this staged protocol is meant to avoid: the model might
  // keep calling compact against old instructions instead of returning to list →
  // stage with the still-visible context.
  env.stagedCompaction = null;

  const lines: string[] = [`Applied staged compaction plan ${plan.snapshotId} (${plan.operations.length} operation${plan.operations.length !== 1 ? "s" : ""}).`];
  log("info", `context tool: compacting ${plan.operations.length} staged operation(s) for ${env.conv.id} snapshot=${plan.snapshotId}`);
  if (snapshotCheck.appendedTurns > 0) {
    lines.push(`Snapshot had ${snapshotCheck.appendedTurns} appended turn${snapshotCheck.appendedTurns !== 1 ? "s" : ""}; staged indices were still valid.`);
  }
  const mutatedScopes = new Set<MutableScope>();

  let structural: PreparedStructuralMutation[];
  try {
    const summarizeOps = plan.operations.filter((op) => op.op === "summarize");
    const preparedSummaries = await Promise.all(summarizeOps.map((op) => prepareSummarizeMutation(op, plan.operations, env, signal)));
    structural = [
      ...preparedSummaries,
      ...plan.operations.filter((op) => op.op === "forget").map((op) => prepareForgetMutation(op, env)),
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `context: staged summarize LLM call failed: ${msg}`);
    return { output: `Compaction failed during summarization: ${msg}. No context was modified. The staged plan was cleared; run context list and stage again before retrying.`, isError: true };
  }

  for (const op of plan.operations) {
    if (op.op === "strip_thinking") {
      const { count, removedChars } = stripThinkingForPlan(op, env);
      if (count > 0) mutatedScopes.add(op.scope);
      lines.push(`stripped thinking ${op.globalStart}–${op.globalEnd}: ${count} assistant turn${count !== 1 ? "s" : ""}, ~${fmt(op.estimatedSavingsTokens)} tok projected removed (${fmt(removedChars)} replay chars)`);
    } else if (op.op === "strip_results") {
      const { count, removedChars } = stripResultsForPlan(op, env);
      if (count > 0) mutatedScopes.add(op.scope);
      lines.push(`stripped results ${op.globalStart}–${op.globalEnd}: ${count} tool result${count !== 1 ? "s" : ""}, ~${fmt(op.estimatedSavingsTokens)} tok projected removed (${fmt(removedChars)} replay chars)`);
    }
  }

  structural.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "current" ? -1 : 1;
    return b.insertIdx - a.insertIdx;
  });
  for (const mutation of structural) {
    mutation.messages.splice(mutation.insertIdx, mutation.deleteCount, ...mutation.replacement);
    mutatedScopes.add(mutation.scope);
    lines.push(mutation.resultLine);
  }

  for (const scope of mutatedScopes) markRangeMutated(env, scope);
  if (mutatedScopes.size === 0) lines.push("No content changed; staged operations were already no-ops.");
  lines.push("Staged plan cleared. Indices changed if structural operations ran; run context list before planning more compaction.");
  return { output: lines.join("\n"), isError: false };
}

// ── Public API ────────────────────────────────────────────────────

/** Execute the context tool with conversation access. */
export async function executeContext(
  input: Record<string, unknown>,
  env: ContextToolEnv,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const action = input.action as string | undefined;

  switch (action) {
    case "list":
      return actionList(env);
    case "stage":
      return actionStage(input, env);
    case "compact":
      return actionCompact(input, env, signal);
    default:
      return { output: `Unknown action: '${action}'. Valid actions: list, stage, compact. To modify context, first stage operations (summarize, forget, strip_thinking, strip_results), then compact.`, isError: true };
  }
}

/** Static tool definition — registered in TOOLS array. execute() is a stub. */
export const context: Tool = {
  name: "context",
  description: "Inspect and compact the conversation context using a staged flow. Use action='list' to get stable indices and a snapshot id; action='stage' to validate/store compaction operations without changing context; action='compact' to apply the staged plan once. Stage operations are: summarize, forget, strip_thinking, strip_results.",
  parallelSafety: "exclusive",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "stage", "compact"],
        description: "Action to perform. Use list -> stage -> compact; context is only mutated by compact.",
      },
      snapshot: {
        type: "string",
        description: "Snapshot id from context list. Required for action='stage'; optional for action='compact'. Snapshots remain usable while new turns only append; they become unusable if earlier listed turns are compacted/edited.",
      },
      operations: {
        type: "array",
        description: "Required for action='stage'. Operations are planned against the stable indices from context list and are not applied until action='compact'.",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["summarize", "forget", "strip_thinking", "strip_results"],
              description: "Compaction operation. summarize replaces a range with a summary; forget deletes modifiable turns; strip_thinking removes assistant thinking blocks; strip_results replaces tool result payloads with placeholders.",
            },
            start: {
              type: "number",
              description: "Start turn index from the most recent context list (inclusive).",
            },
            end: {
              type: "number",
              description: "End turn index from the most recent context list (inclusive).",
            },
            prompt: {
              type: "string",
              description: "Optional custom instruction for summarize operations only.",
            },
          },
          required: ["op", "start", "end"],
        },
      },
      targetTokens: {
        type: "number",
        description: "Optional for action='stage'. The desired approximate final context size. Stage rejects plans projected to undershoot this target badly unless allowOvershoot=true.",
      },
      allowOvershoot: {
        type: "boolean",
        description: "Optional for action='stage'. Set true only when intentional; otherwise targetTokens protects against compacting far below the requested target.",
      },
    },
    required: ["action"],
  },
  systemHint: "When approaching the context limit, use the context tool's staged compaction flow. First call context list to get modifiable ranges, semantic previews, and the snapshot id. Then call context stage once with that snapshot and all desired operations. If the user gave a target size (for example 'trim to ~100k'), pass targetTokens so stage can reject plans that would over-compact; set allowOvershoot=true only if the user explicitly wants aggressive handoff-style compression. Prefer least-destructive operations first: strip_thinking for lossless savings, strip_results for clearly disposable tool output, summarize only ranges whose durable facts need preserving, and forget only safe disposable turns that can be absolutely removed. strip_thinking and strip_results may overlap summarize/forget; summarize and forget must not overlap each other. Staging does not modify context. A snapshot remains valid while new turns only append; it becomes unusable after compact/edit changes earlier listed turns. Finally call context compact once to apply the staged plan; summaries may run in parallel. Do not call summarize/forget/strip_thinking/strip_results as top-level actions.",
  display: {
    label: "Context",
    color: "#2ec4b6",
  },
  summarize(input) {
    const action = (input.action as string) ?? "?";
    if (action === "list") return { label: "Context", detail: "list" };
    if (action === "stage") {
      const operations = Array.isArray(input.operations) ? input.operations as Array<Record<string, unknown>> : [];
      const grouped = new Map<string, string[]>();
      for (const op of operations) {
        const name = typeof op.op === "string" ? op.op : "op";
        const start = typeof op.start === "number" ? op.start : "?";
        const end = typeof op.end === "number" ? op.end : "?";
        const range = `${start}${start === end ? "" : `–${end}`}`;
        const list = grouped.get(name) ?? [];
        list.push(range);
        grouped.set(name, list);
      }
      const parts = [...grouped.entries()].map(([name, ranges]) => `${name} ${ranges.slice(0, 3).join(",")}${ranges.length > 3 ? `,+${ranges.length - 3}` : ""}`);
      const target = input.targetTokens != null ? ` target ${formatTokenCountForDisplay(input.targetTokens)}` : "";
      return { label: "Context", detail: `stage ${parts.join("; ") || "0 ops"}${target}` };
    }
    if (action === "compact") return { label: "Context", detail: "compact" };
    return { label: "Context", detail: action };
  },
  // Stub — never called; executor routes to executeContext()
  async execute() {
    return { output: "Error: context tool requires conversation context", isError: true };
  },
};
