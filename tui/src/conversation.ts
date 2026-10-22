/**
 * Conversation rendering — message flow and line anchoring.
 *
 * Turns the message list + pendingAI into display lines while preserving stable
 * anchors for viewport/cursor behavior. Block-level styling and wrapping live
 * in blockrenderer.ts.
 */

import { CONTEXT_COMPACTION_FINISHED_KIND, combineMessageMetadata, convDisplayName, ownerRelayedText, type Block, type ImageAttachment, type Message, type MessageMetadata, type UserMessageAutomation } from "./messages";
import {
  fitImageBox,
  historyImageLimits,
  inlineImageCellSize,
  inlineImageGeneration,
  inlineImagesActive,
  layoutInlineImageStrip,
  renderInlineImage,
  renderInlineImageStrip,
  sourceFromAttachment,
  sourceFromRef,
  type InlineImageHit,
  type InlineImageSource,
} from "./inlineimages";
import { isActiveConversationLoading, isStreaming, type RenderState } from "./state";
import { formatDuration, renderMetadata } from "./metadata";
import { activeDurableSleepAssistant, inlineSleepMetadataEndedAt } from "./durable-sleep-metadata";
import { theme } from "./theme";
import {
  renderBlockCached,
  renderSystemMessage,
  renderUserMessageCached,
  userMessageFlowMetadataCached,
  type UserMessageFlowDocument,
  type UserMessageFlowCursor,
} from "./blockrenderer";
import { isVisuallyBlankLine, sanitizeUntrustedText } from "./terminaltext";
import { automationLabel, ownerRelay, planHistory, type HistoryPlan, type NotificationPlan, type PendingPlan } from "./turncollapse";

const COMPACTION_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const COMPACTION_SPINNER_INTERVAL_MS = 80;

/** Whether the live turn shows its Working row (and so a turning spinner). */
export function workingRowVisible(state: RenderState): boolean {
  return state.pendingAI !== null && isStreaming(state) && !state.showTurnWork && !state.showToolOutput
    && state.pendingAI.metadata?.startedAt !== state.suppressPendingAIMetadataStartedAt;
}

export function compactionSpinnerText(startedAt: number, now = Date.now()): string {
  const frameIndex = Math.max(0, Math.floor((now - startedAt) / COMPACTION_SPINNER_INTERVAL_MS));
  return `${COMPACTION_SPINNER_FRAMES[frameIndex % COMPACTION_SPINNER_FRAMES.length]} Compacting...`;
}

/** `⠋ Waiting for connection… 3m 12s` while a turn waits out a network outage. */
export function connectionWaitSpinnerText(startedAt: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - startedAt);
  const frameIndex = Math.floor(elapsed / COMPACTION_SPINNER_INTERVAL_MS);
  return `${COMPACTION_SPINNER_FRAMES[frameIndex % COMPACTION_SPINNER_FRAMES.length]} Waiting for connection… ${formatDuration(elapsed)}`;
}

export function historyLoadingSpinnerText(startedAt: number, now = Date.now()): string {
  const frameIndex = Math.max(0, Math.floor((now - startedAt) / COMPACTION_SPINNER_INTERVAL_MS));
  return `${COMPACTION_SPINNER_FRAMES[frameIndex % COMPACTION_SPINNER_FRAMES.length]} Loading...`;
}

export function conversationLoadingSpinnerText(startedAt: number, now = Date.now()): string {
  const frameIndex = Math.max(0, Math.floor((now - startedAt) / COMPACTION_SPINNER_INTERVAL_MS));
  return `${COMPACTION_SPINNER_FRAMES[frameIndex % COMPACTION_SPINNER_FRAMES.length]} Loading conversation...`;
}

function rightAlignedProvenanceLabel(label: string, availableWidth: number): string {
  // These are single terminal rows, not wrapped message content. Overflow can
  // autowrap into the next sidebar row, which retained-frame diffing may skip.
  const width = Math.max(1, availableWidth - 3);
  const text = truncateToWidth(sanitizeUntrustedText(label).replace(/[\r\n\t]/g, " "), width);
  const padding = " ".repeat(Math.max(0, width - termWidth(text)));
  return `${padding}${theme.muted}${theme.italic}${text}${theme.reset}`;
}

function automationProvenance(automation: UserMessageAutomation | undefined): string | null {
  return automation ? `⚙ ${automationLabel(automation)}` : null;
}


/** Build the muted markdown-style completion divider, ending at the screen midpoint. */
export function compactionFinishedDivider(availableWidth: number): string {
  const maxWidth = Math.max(1, availableWidth - 2); // two-space assistant indent
  const prefix = "─── Compaction finished ";
  if (maxWidth <= prefix.length) return prefix.slice(0, maxWidth);

  const minimumWidth = prefix.length + 3;
  const midpointWidth = Math.max(1, Math.floor(availableWidth / 2) - 2);
  const dividerWidth = Math.min(maxWidth, Math.max(minimumWidth, midpointWidth));
  return prefix + "─".repeat(dividerWidth - prefix.length);
}
import { termWidth, truncateToWidth } from "./textwidth";
import type { WrapCopyLine, WrapImage, WrapResult } from "./textwrap";
import { mathImageLayout, type HistoryImageLayout } from "./historyimages";
import { mathImageGeneration } from "./mathimages";
import type { LinkSpan } from "./links";
import { isNewConversationQueuedMessage, queuedMessagesInDisplayOrder, queueTimingLabel } from "./queue";

import { wordWrap } from "./textwrap";
export { wordWrap, type WrapResult } from "./textwrap";

/**
 * Whether a user message at `index` needs a blank line above it. Only the top of
 * the transcript, or a block that already ends in its own margin, goes without.
 * A paged window can open mid-turn, so this asks what precedes the message
 * rather than whether an earlier user message happens to be loaded.
 */
function userMessageNeedsTopMargin(messages: Message[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    // Instructions render no rows, so only what precedes them counts.
    if (messages[i].role !== "system_instructions") return true;
  }
  return false;
}

function isTerminalStreamNotice(msg: Message | undefined): boolean {
  return msg?.role === "system" && (msg.text.startsWith("✗") || msg.color === theme.error);
}

const MAX_SUMMARY_METADATA_SPAN_MS = 48 * 60 * 60 * 1000;
const MAX_ASSISTANT_SEGMENT_IDLE_GAP_MS = 2 * 60 * 60 * 1000;

function hasSummaryText(msg: Message): boolean {
  return msg.role === "assistant"
    && msg.blocks.some((block) => block.type === "text" && block.text.startsWith("[Summary"));
}

function metadataForDisplayAggregation(msg: Message): MessageMetadata | null {
  if (msg.role !== "assistant" || !msg.metadata) return null;

  // Older compaction code could collapse multiple real-user-bounded work
  // sessions into a single summary metadata span. That makes idle days render as
  // assistant work (for example a 4-day summary for a couple hours of activity).
  // Future summaries preserve only the final user-bounded segment; defensively
  // ignore already-persisted overbroad summary metadata until we have a richer
  // multi-segment metadata model.
  const spanMs = msg.metadata.endedAt == null ? 0 : msg.metadata.endedAt - msg.metadata.startedAt;
  if (msg.metadata.workTimerStartedAt === undefined && spanMs > MAX_SUMMARY_METADATA_SPAN_MS && hasSummaryText(msg)) return null;

  return msg.metadata;
}

function combineSegmentMetadata(
  current: MessageMetadata | null,
  next: MessageMetadata | null | undefined,
): MessageMetadata | null {
  if (!current || !next) return combineMessageMetadata(current, next);

  const currentEnd = current.endedAt ?? current.startedAt;
  const nextEnd = next.endedAt ?? next.startedAt;
  const gap = next.startedAt > currentEnd
    ? next.startedAt - currentEnd
    : current.startedAt > nextEnd
      ? current.startedAt - nextEnd
      : 0;
  if (gap > MAX_ASSISTANT_SEGMENT_IDLE_GAP_MS) return { ...next };

  return combineMessageMetadata(current, next);
}

function assistantRunMetadata(messages: Message[], endIndex: number): MessageMetadata | null {
  let startIndex = endIndex;
  while (startIndex > 0 && messages[startIndex - 1]?.role === "assistant") startIndex--;

  let metadata: MessageMetadata | null = null;
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (msg?.role === "assistant") metadata = combineSegmentMetadata(metadata, metadataForDisplayAggregation(msg));
  }
  return metadata;
}

function pendingAssistantRunMetadata(state: RenderState): MessageMetadata | null {
  let metadata = state.pendingAI?.metadata ? { ...state.pendingAI.metadata } : null;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg.role !== "assistant") break;
      metadata = combineSegmentMetadata(metadataForDisplayAggregation(msg), metadata);
  }
  return metadata;
}

function isRealUserMessage(msg: Message): boolean {
  return msg.role === "user" && msg.metadata?.system !== true;
}

function isAssistantMetadataBoundary(msg: Message): boolean {
  // A replay is a fresh request even though it has no new user message. The
  // terminal notice is its only durable boundary from the interrupted request;
  // crossing it would charge the idle time before /replay as active model time.
  return isRealUserMessage(msg) || isTerminalStreamNotice(msg);
}

function assistantSegmentMetadata(messages: Message[], endIndex: number): MessageMetadata | null {
  const current = messages[endIndex];
  if (current?.role !== "assistant") return null;

  let startIndex = endIndex;
  while (startIndex > 0 && !isAssistantMetadataBoundary(messages[startIndex - 1])) startIndex--;

  let metadata: MessageMetadata | null = null;
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") metadata = combineSegmentMetadata(metadata, metadataForDisplayAggregation(msg));
  }
  return metadata;
}

function pendingAssistantSegmentMetadata(state: RenderState): MessageMetadata | null {
  if (!state.pendingAI) return null;

  let startIndex = state.messages.length;
  while (startIndex > 0 && !isAssistantMetadataBoundary(state.messages[startIndex - 1])) startIndex--;

  let metadata: MessageMetadata | null = null;
  for (let i = startIndex; i < state.messages.length; i++) {
    const msg = state.messages[i];
    if (msg.role === "assistant") metadata = combineSegmentMetadata(metadata, metadataForDisplayAggregation(msg));
  }
  return combineSegmentMetadata(metadata, state.pendingAI.metadata);
}

/**
 * `⠹ Working · 7 tool calls` above the in-progress turn's latest step. The
 * spinner turns at the loading spinners' rate (main.ts ticks the frame while
 * it shows); the frame diff rewrites only the rows that changed.
 */
function workingRow(metadata: MessageMetadata | null, pending: PendingPlan, now = Date.now()): string {
  const startedAt = metadata?.workTimerStartedAt ?? metadata?.startedAt ?? now;
  const frame = COMPACTION_SPINNER_FRAMES[Math.max(0, Math.floor((now - startedAt) / COMPACTION_SPINNER_INTERVAL_MS)) % COMPACTION_SPINNER_FRAMES.length];
  const work = pending.summary ? ` · ${pending.summary}` : "";
  return `  ${theme.accent}${frame}${theme.reset} ${theme.muted}Working${work}${theme.reset}`;
}

/** A rendered row without its colours (to restyle it wholesale). */
function stripSgr(line: string): string {
  return line.replace(/\x1b\[[0-9;:]*m/g, "");
}

// ── Notifications ───────────────────────────────────────────────────

/** Notification label rows are chrome: yanks and copies skip them. */
const DISPLAY_ONLY_ROW: WrapCopyLine = { text: "", displayStart: 0, skip: true };
const NOTIFICATION_GUTTER = "▎ ";
const NOTIFICATION_INDENT = 2;
const notificationBodyCache = new WeakMap<object, { text: string; width: number; themeName: string; result: WrapResult }>();

/**
 * One muted row naming a notification's source in italics, cut to the width
 * (a single row, so it never autowraps beside the sidebar or task panel).
 */
function notificationLabelRow(row: string, labelEnd: number, availableWidth: number): string {
  const text = truncateToWidth(row, Math.max(1, availableWidth - 4));
  const end = Math.min(labelEnd, text.length);
  return `  ${theme.muted}${theme.italic}${text.slice(0, end)}${theme.italicOff}${text.slice(end)}${theme.reset}`;
}

/** Notification text behind a muted gutter; copies take the text without it. */
function renderNotificationBodyCached(msg: Extract<Message, { role: "user" }>, availableWidth: number, owner: object = msg): WrapResult {
  const cached = notificationBodyCache.get(owner);
  if (cached && cached.text === msg.text && cached.width === availableWidth && cached.themeName === theme.name) return cached.result;
  const textStart = NOTIFICATION_INDENT + NOTIFICATION_GUTTER.length;
  const wrapped = wordWrap(sanitizeUntrustedText(msg.text), Math.max(1, availableWidth - textStart - 2));
  const prefix = `${" ".repeat(NOTIFICATION_INDENT)}${theme.muted}${NOTIFICATION_GUTTER}${theme.reset}`;
  const result: WrapResult = {
    lines: wrapped.lines.map(line => `${prefix}${line}`),
    cont: wrapped.cont,
    join: wrapped.join,
    copy: wrapped.lines.map(line => ({ text: line, displayStart: textStart })),
  };
  notificationBodyCache.set(owner, { text: msg.text, width: availableWidth, themeName: theme.name, result });
  return result;
}

// ── Message boundary tracking ───────────────────────────────────────

/** Row range for a single message in the rendered history lines. */
export interface MessageBound {
  /** Message role backing this rendered range. */
  role: Message["role"];
  /** First line index (inclusive). */
  start: number;
  /** Last line index (exclusive). */
  end: number;
  /** Start of primary content (inclusive), after margins. */
  contentStart: number;
  /** End of primary content (exclusive), before metadata/padding. im uses this. */
  contentEnd: number;
}

export type RenderLineSegment =
  | "assistant_block"
  | "assistant_image"
  | "assistant_metadata"
  | "compaction_finished"
  | "compaction_margin_bottom"
  | "compaction_margin_top"
  | "compaction_spinner"
  | "connection_wait_margin_top"
  | "connection_wait_spinner"
  | "history_loading"
  | "conversation_loading"
  | "queued_content"
  | "queued_label"
  | "queued_margin_top"
  | "streaming_tail"
  | "system_message"
  | "automation_label"
  | "notification_body"
  | "notification_header"
  | "turn_working"
  | "user_content"
  | "user_image"
  | "user_margin_bottom"
  | "user_margin_top";

export interface RenderLineAnchor {
  /** Clickable ranges in this rendered row, retained with cached row metadata. */
  links?: LinkSpan[];
  /** Stable owner identity for this rendered segment (message/block/queued item). */
  owner: object;
  /** Segment within the owner (content, metadata, margins, etc). */
  segment: RenderLineSegment;
  /** Logical line index within the segment (increments on hard newlines / semantic rows). */
  index: number;
  /** Wrapped visual row within that logical line (0 for the first row). */
  subIndex: number;
  /** Width-independent source range for semantic user/queued text rows. */
  userFlowDocument?: UserMessageFlowDocument;
  userFlowStart?: UserMessageFlowCursor;
  userFlowEnd?: UserMessageFlowCursor;
  /** Images covering this row (several side by side in a strip, or display math), and which of their rows this is. */
  images?: Array<{ layout: HistoryImageLayout; row: number }>;
  /** Columns where Enter or a click on this row (a thumbnail, a strip's `› +N`) opens an image. */
  openImages?: InlineImageHit[];
}

/** An image to draw in history, with the object that owns its placement. */
interface HistoryImage {
  source: InlineImageSource;
  owner: object;
  index: number;
}

/** Images the attach tool added to these assistant blocks, in call order. */
export function attachedImages(blocks: readonly Block[]): HistoryImage[] {
  const images: HistoryImage[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result" || !block.images?.length) continue;
    block.images.forEach((ref, index) => images.push({ source: sourceFromRef(ref), owner: block, index }));
  }
  return images;
}

function pastedImages(owner: object, images: readonly ImageAttachment[] | undefined, convId: string | null): HistoryImage[] {
  const out: HistoryImage[] = [];
  images?.forEach((image, index) => {
    const source = sourceFromAttachment(image, convId);
    if (source) out.push({ source, owner, index });
  });
  return out;
}

const USER_IMAGE_RIGHT_MARGIN = 2;
const ASSISTANT_IMAGE_INDENT = 2;

export interface BuildMessageLinesResult {
  lines: string[];
  messageBounds: MessageBound[];
  wrapContinuation: boolean[];
  /** separator to reinsert before each continuation line when copying/yanking. */
  wrapJoiners: string[];
  /** Per-rendered-line source projection for vim yanks/copies. */
  copyLines: Array<WrapCopyLine | null>;
  /**
   * Stable per-line anchors used to preserve viewport/cursor position across
   * re-renders when optional blocks appear/disappear (for example Ctrl+O tool
   * result expansion).
   */
  lineAnchors: RenderLineAnchor[];
  /** True when this render intentionally contains only the newest suffix of history. */
  partial?: boolean;
  /** First state.messages index included when partial rendering is active. */
  startMessageIndex?: number;
  /** Unique per build; arrays can be reused in place, so identity alone does not identify content. */
  revision: number;
}

export interface BuildMessageLinesOptions {
  startMessageIndex?: number;
  partial?: boolean;
  /**
   * Let this build take over the arrays of the previous result at this width
   * instead of copying them; that result's arrays then change underneath it.
   * Only for the render loop, which replaces its result every frame. Callers
   * that compare an old and a new build must not set it.
   */
  reuseArrays?: boolean;
}

let buildRevision = 0;

// ── Committed history reuse ─────────────────────────────────────────

/**
 * Rows already built for the committed messages (everything before pendingAI,
 * the streaming tail and queued shadows), reused by the next build at the same
 * width. Without it every streaming frame, keypress and daemon event re-walked
 * the whole loaded history, which costs hundreds of milliseconds per frame once
 * a long conversation has been scrolled through.
 *
 * Messages and blocks are mutated in place in a few places (tool outputs,
 * reconciled blocks, metadata), so validity is checked structurally on every
 * build: the reference of every message, block and content field is compared
 * with the build that produced the cached rows. Only the first changed message
 * onward is rebuilt.
 */
interface CommittedHistoryCache {
  key: readonly unknown[];
  startMessageIndex: number;
  messageCount: number;
  /** Flat content references of messages [startMessageIndex, messageCount). */
  sourceRefs: unknown[];
  /** sourceRefs end offset after each message. */
  sourceRefEnds: number[];
  /** Rendered row count before each message, and before any loading row above it. */
  lineStarts: number[];
  /** Rows after the last committed message. */
  committedLines: number;
  erroredToolCallIds: Set<string>;
  /** turncollapse plan signature of each message [startMessageIndex, messageCount). */
  planSignatures: string[];
  /** The committed messages' share of erroredToolCallIds, reused while they are unchanged. */
  committedErroredToolCallIds: Set<string>;
  lastContinuesIntoPending: boolean;
  durableSleepIndex: number;
  /** Assistant images still waiting for the segment end when the committed rows stop. */
  carriedImages: HistoryImage[];
  /** Older-history spinner row text when built (null when not loading) and the message it precedes. */
  historyLoadingRow: string | null;
  historyLoadingInsertIndex: number;
  /** Whether the row arrays came from a reuseArrays build, i.e. only the render loop holds them. */
  ownsArrays: boolean;
  lines: string[];
  wrapContinuation: boolean[];
  wrapJoiners: string[];
  copyLines: Array<WrapCopyLine | null>;
  lineAnchors: RenderLineAnchor[];
  messageBounds: MessageBound[];
}

/** Per-state caches by width; resize and sidebar toggles build two widths back to back. */
const committedHistoryCaches = new WeakMap<RenderState, CommittedHistoryCache[]>();
const COMMITTED_HISTORY_CACHE_WIDTHS = 2;

/** Drop reusable committed rows, e.g. after changing a render input this module cannot observe. */
export function invalidateCommittedHistoryCache(state: RenderState): void {
  committedHistoryCaches.delete(state);
}

function appendBlockSourceRefs(block: Block, out: unknown[]): void {
  out.push(block);
  switch (block.type) {
    case "thinking":
    case "text":
      out.push(block.text);
      break;
    case "tool_call":
      out.push(block.toolName, block.summary, block.input, block.presentation, block.toolCallId);
      break;
    case "tool_result":
      out.push(block.isError, block.output, block.toolCallId, block.images);
      break;
  }
}

/** Every field buildMessageLines reads from a message, by reference. */
function appendMessageSourceRefs(message: Message, out: unknown[]): void {
  out.push(message, message.role, message.metadata);
  switch (message.role) {
    case "assistant":
      out.push(message.blocks, message.blocks.length);
      for (const block of message.blocks) appendBlockSourceRefs(block, out);
      break;
    case "user":
      out.push(message.text, message.images);
      break;
    case "system":
      out.push(message.text, message.color);
      break;
    case "system_instructions":
      out.push(message.text);
      break;
  }
}

/**
 * Whether `message` still has the references appendMessageSourceRefs recorded
 * at refs[offset, end). Mirrors it field for field without allocating; this
 * runs for every loaded message on every build.
 */
function messageSourceRefsMatch(message: Message, refs: readonly unknown[], offset: number, end: number): boolean {
  if (refs[offset] !== message || refs[offset + 1] !== message.role || refs[offset + 2] !== message.metadata) return false;
  let i = offset + 3;
  switch (message.role) {
    case "assistant": {
      const blocks = message.blocks;
      if (refs[i] !== blocks || refs[i + 1] !== blocks.length) return false;
      i += 2;
      for (const block of blocks) {
        if (refs[i] !== block) return false;
        switch (block.type) {
          case "thinking":
          case "text":
            if (refs[i + 1] !== block.text) return false;
            i += 2;
            break;
          case "tool_call":
            if (refs[i + 1] !== block.toolName || refs[i + 2] !== block.summary || refs[i + 3] !== block.input
              || refs[i + 4] !== block.presentation || refs[i + 5] !== block.toolCallId) return false;
            i += 6;
            break;
          case "tool_result":
            if (refs[i + 1] !== block.isError || refs[i + 2] !== block.output || refs[i + 3] !== block.toolCallId
              || refs[i + 4] !== block.images) return false;
            i += 5;
            break;
        }
      }
      break;
    }
    case "user":
      if (refs[i] !== message.text || refs[i + 1] !== message.images) return false;
      i += 2;
      break;
    case "system":
      if (refs[i] !== message.text || refs[i + 1] !== message.color) return false;
      i += 2;
      break;
    case "system_instructions":
      if (refs[i] !== message.text) return false;
      i += 1;
      break;
  }
  return i === end;
}

function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function committedErroredToolCalls(messages: Message[], start: number): Set<string> {
  const ids = new Set<string>();
  for (let index = start; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type === "tool_result" && block.isError) ids.add(block.toolCallId);
    }
  }
  return ids;
}

function withPendingErroredToolCalls(committed: Set<string>, pending: Message | null): Set<string> {
  if (pending?.role !== "assistant" || !pending.blocks.some(block => block.type === "tool_result" && block.isError)) return committed;
  const ids = new Set(committed);
  for (const block of pending.blocks) {
    if (block.type === "tool_result" && block.isError) ids.add(block.toolCallId);
  }
  return ids;
}

/**
 * Whether rows after this message are independent of every message before it:
 * assistant metadata and segment images stop accumulating here, and a
 * following user message gets its top margin either way.
 */
function isSegmentBoundary(message: Message): boolean {
  return message.role !== "assistant" && isAssistantMetadataBoundary(message);
}

function firstChangedErroredToolCallMessage(
  messages: Message[],
  start: number,
  previous: Set<string>,
  next: Set<string>,
): number {
  const changed = new Set<string>();
  for (const id of previous) if (!next.has(id)) changed.add(id);
  for (const id of next) if (!previous.has(id)) changed.add(id);
  if (changed.size === 0) return Infinity;
  for (let index = start; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (message.blocks.some(block => block.type === "tool_call" && changed.has(block.toolCallId))) return index;
  }
  return Infinity;
}

// ── Build all display lines ─────────────────────────────────────────

export function buildMessageLines(
  state: RenderState,
  availableWidth: number,
  options: BuildMessageLinesOptions = {},
): BuildMessageLinesResult {
  const contentWidth = availableWidth - 4;
  const metadataOptions = { width: availableWidth, diagnostics: state.showDiagnostics };
  let lines: string[] = [];
  let wrapContinuation: boolean[] = [];
  let wrapJoiners: string[] = [];
  let copyLines: Array<WrapCopyLine | null> = [];
  let messageBounds: MessageBound[] = [];
  let lineAnchors: RenderLineAnchor[] = [];
  const durableSleepAssistant = activeDurableSleepAssistant(state);
  const startMessageIndex = Math.max(0, Math.min(options.startMessageIndex ?? 0, state.messages.length));
  // Tool calls whose result failed; filled once the committed rows are planned.
  let erroredToolCallIds = new Set<string>();

  const renderAssistantBlock = (block: Extract<Message, { role: "assistant" }>["blocks"][number]): WrapResult =>
    renderBlockCached(
      block,
      contentWidth,
      state.toolRegistry,
      state.externalToolStyles,
      state.showToolOutput,
      block.type === "tool_call" && erroredToolCallIds.has(block.toolCallId),
      true,
    );

  const pushAnchoredLine = (
    line: string,
    cont: boolean,
    joiner: string,
    owner: object,
    segment: RenderLineSegment,
    index: number,
    subIndex: number,
    copyLine: WrapCopyLine | null = null,
  ) => {
    lines.push(line);
    wrapContinuation.push(cont);
    wrapJoiners.push(cont ? joiner : "");
    copyLines.push(copyLine);
    lineAnchors.push({ owner, segment, index, subIndex });
  };

  /** Append block result (lines + continuation flags). */
  const pushBlock = (owner: object, segment: RenderLineSegment, br: WrapResult) => {
    let logicalIndex = -1;
    let subIndex = 0;
    const mathLayouts = new Map<WrapImage, HistoryImageLayout>();
    for (let i = 0; i < br.lines.length; i++) {
      if (i === 0 || !br.cont[i]) {
        logicalIndex++;
        subIndex = 0;
      } else {
        subIndex++;
      }
      pushAnchoredLine(br.lines[i], br.cont[i], br.join[i], owner, segment, logicalIndex, subIndex, br.copy?.[i] ?? null);
      if (br.links?.[i]?.length) lineAnchors[lineAnchors.length - 1].links = br.links[i];
      const imageRow = br.images?.[i];
      if (imageRow) {
        let layout = mathLayouts.get(imageRow.image);
        if (!layout) mathLayouts.set(imageRow.image, layout = mathImageLayout(imageRow.image, owner));
        lineAnchors[lineAnchors.length - 1].images = [{ layout, row: imageRow.row }];
      }
    }
  };

  /** Append a non-wrapped line (margin, metadata, etc). */
  const pushLine = (line: string, owner: object, segment: RenderLineSegment, index = 0) => {
    pushAnchoredLine(line, false, "", owner, segment, index, 0);
  };

  /** A chrome row (a notification's label, the Working row): yanks and copies skip it. */
  const pushChromeLine = (line: string, owner: object, segment: RenderLineSegment) => {
    pushAnchoredLine(line, false, "", owner, segment, 0, 0, DISPLAY_ONLY_ROW);
  };

  /** A notification sits on the assistant's side, never in the user's bubble: its label, then its text behind a muted gutter. */
  const pushNotification = (msg: Extract<Message, { role: "user" }>, notification: NotificationPlan) => {
    pushChromeLine(notificationLabelRow(notification.label, notification.label.length, availableWidth), msg, "notification_header");
    pushBlock(msg, "notification_body", renderNotificationBodyCached(msg, availableWidth));
  };

  const imageLimits = historyImageLimits(availableWidth, state.rows);
  /**
   * Append a message's inline images after a blank row: one thumbnail, or a
   * strip of them side by side. User images align right like their bubble.
   * There is no caption row; the viewer shows each image's name and size.
   */
  const pushImages = (images: readonly HistoryImage[], segment: "assistant_image" | "user_image") => {
    if (!inlineImagesActive() || images.length === 0) return;
    const owner = images[0].owner;
    const placeAt = (width: number) => segment === "user_image"
      ? Math.max(0, availableWidth - USER_IMAGE_RIGHT_MARGIN - width)
      : ASSISTANT_IMAGE_INDENT;
    pushLine("", owner, segment, images[0].index);
    const pushRows = (
      rendered: { lines: string[]; copy: string[] },
      col: number,
      covering: (row: number) => NonNullable<RenderLineAnchor["images"]>,
      hits: InlineImageHit[],
    ) => {
      rendered.lines.forEach((line, row) => {
        // Kitty rows are blank; keep the indent so narrow-history shifting stays exact.
        const text = line === "" ? " ".repeat(col) : line;
        // A yank copies the first row as `[image: …]`.
        pushAnchoredLine(text, false, "", owner, segment, images[0].index, row, rendered.copy[row]
          ? { text: rendered.copy[row], displayStart: col }
          : { text: "", displayStart: 0, skip: true });
        const anchor = lineAnchors[lineAnchors.length - 1];
        anchor.images = covering(row);
        anchor.openImages = hits;
      });
    };

    if (images.length === 1) {
      const [image] = images;
      const box = fitImageBox(image.source, imageLimits.cols, imageLimits.rows, imageCell);
      const col = placeAt(box.cols);
      // A notice may use the width beside an assistant image; a user image's ends at its right edge.
      const statusWidth = Math.max(box.cols, availableWidth - USER_IMAGE_RIGHT_MARGIN - col);
      const rendered = renderInlineImage(image.source, box, col, image.owner, image.index, statusWidth);
      const hits = [{ start: 0, end: Infinity, target: { images: [image.source], index: 0 }, layout: rendered.layout }];
      pushRows(rendered, col, row => [{ layout: rendered.layout, row }], hits);
      return;
    }
    const strip = layoutInlineImageStrip(images.map(image => image.source), imageLimits, Math.max(4, availableWidth - 4), imageCell);
    const col = placeAt(strip.width);
    const rendered = renderInlineImageStrip(images, strip, col);
    pushRows(rendered, col, row => rendered.rowImages[row], rendered.hits);
  };

  const trimTrailingBlankAssistantContent = (minLength: number) => {
    while (lines.length > minLength) {
      const anchor = lineAnchors[lineAnchors.length - 1];
      if (!anchor || anchor.segment !== "assistant_block" || anchor.images) break;
      if (!isVisuallyBlankLine(lines[lines.length - 1])) break;
      lines.pop();
      wrapContinuation.pop();
      wrapJoiners.pop();
      copyLines.pop();
      lineAnchors.pop();
    }
  };

  const pushMessageBound = (
    role: Message["role"],
    start: number,
    contentStart: number,
    contentEnd: number,
  ) => {
    messageBounds.push({ role, start, end: lines.length, contentStart, contentEnd });
  };

  // Plan which committed messages can keep their rows from the previous build.
  // The opening spinner animates above the committed rows while a conversation
  // is still loading; those frames take the full path and leave the cache alone.
  const messages = state.messages;
  const messageCount = messages.length;
  const cacheable = !isActiveConversationLoading(state);
  const lastContinuesIntoPending = state.pendingAI?.role === "assistant";
  const imageCell = inlineImageCellSize();
  const collapse = !state.showTurnWork && !state.showToolOutput;
  const plan: HistoryPlan = planHistory({
    messages,
    start: startMessageIndex,
    pendingAI: state.pendingAI,
    collapse,
    active: durableSleepAssistant,
    conversationTitle: (id) => {
      const conv = state.sidebar?.conversations.find(candidate => candidate.id === id);
      return conv ? convDisplayName(conv) : null;
    },
  });
  const cacheKey: unknown[] = [
    state.convId, contentWidth, state.showToolOutput, state.showTurnWork, state.showDiagnostics, state.toolRegistry,
    state.externalToolStyles, theme.name, state.rows, inlineImageGeneration(), mathImageGeneration(),
    inlineImagesActive(), imageCell.width, imageCell.height, userMessageNeedsTopMargin(messages, startMessageIndex),
  ];
  const widthCaches = committedHistoryCaches.get(state) ?? [];
  const cached = cacheable
    ? widthCaches.find(entry => entry.startMessageIndex === startMessageIndex && sameRefs(entry.key, cacheKey))
    : undefined;
  const durableSleepIndex = durableSleepAssistant ? messages.lastIndexOf(durableSleepAssistant) : -1;

  // The older-history spinner is a committed row above the oldest loaded turn.
  let historyLoadingInsertIndex = startMessageIndex;
  if (state.historyLoadingOlder && startMessageIndex === 0) {
    while (messages[historyLoadingInsertIndex]?.role === "system_instructions") {
      historyLoadingInsertIndex++;
    }
  }
  const historyLoadingRow = state.historyLoadingOlder
    ? `${theme.dim}${historyLoadingSpinnerText(state.historyLoadingStartedAt ?? Date.now())}${theme.reset}`
    : null;
  const pushHistoryLoadingLine = () => pushLine(historyLoadingRow!, state, "history_loading");

  let rebuildFrom = startMessageIndex;
  let rebuildTo = messageCount;
  let sourceRefs: unknown[] = [];
  let sourceRefEnds: number[] = [];
  let lineStarts: number[] = [];
  let carriedImages: HistoryImage[] = [];
  let committedErroredToolCallIds: Set<string> | undefined;
  /** Unchanged trailing messages whose rows are appended after rebuilding the front. */
  let reusedSuffix: { cached: CommittedHistoryCache; oldStart: number } | null = null;
  if (cached) {
    const s = startMessageIndex;
    const refStart = (entry: CommittedHistoryCache, index: number) => index === entry.startMessageIndex ? 0 : entry.sourceRefEnds[index - entry.startMessageIndex - 1];
    const sameAsCached = (index: number, cachedIndex: number) => messageSourceRefsMatch(
      messages[index], cached.sourceRefs, refStart(cached, cachedIndex), cached.sourceRefEnds[cachedIndex - s],
    ) && plan.signatures[index - s] === cached.planSignatures[cachedIndex - s];
    let firstChanged = Math.min(messageCount, cached.messageCount);
    for (let index = s; index < firstChanged; index++) {
      if (!sameAsCached(index, index)) {
        firstChanged = index;
        break;
      }
    }
    const unchanged = firstChanged >= messageCount && messageCount === cached.messageCount;
    if (unchanged) committedErroredToolCallIds = cached.committedErroredToolCallIds;
    erroredToolCallIds = withPendingErroredToolCalls(
      committedErroredToolCallIds ??= committedErroredToolCalls(messages, s),
      state.pendingAI,
    );

    // Other inputs that dirty one message, by index in the current messages.
    const dirty: number[] = [];
    if (lastContinuesIntoPending !== cached.lastContinuesIntoPending) dirty.push(messageCount - 1);
    // An active durable sleep's metadata ticks with the clock.
    if (durableSleepIndex >= s) dirty.push(durableSleepIndex);
    // Its old index, both as it was and as moved by a prepend: either may be it.
    if (cached.durableSleepIndex >= s) {
      dirty.push(cached.durableSleepIndex, cached.durableSleepIndex + messageCount - cached.messageCount);
    }
    const erroredChange = firstChangedErroredToolCallMessage(messages, s, cached.erroredToolCallIds, erroredToolCallIds);
    if (erroredChange < messageCount) dirty.push(erroredChange);
    if (historyLoadingRow !== cached.historyLoadingRow) {
      dirty.push(historyLoadingRow !== null ? historyLoadingInsertIndex : cached.historyLoadingInsertIndex);
    }
    const firstDirty = Math.min(firstChanged, ...dirty);

    if (firstDirty >= messageCount && messageCount === cached.messageCount) {
      rebuildFrom = messageCount;
      carriedImages = cached.carriedImages;
    } else {
      // A message's rows depend on whether the next message continues its
      // assistant segment, and segment images accumulate across that run, so
      // rebuild from the start of the run before the first change.
      rebuildFrom = Math.max(s, Math.min(firstDirty, messageCount) - 1);
      while (rebuildFrom > s && messages[rebuildFrom - 1].role === "assistant") rebuildFrom--;

      // A change near the top (an older page prepended, the loading row
      // animating) instead keeps the unchanged tail. Its rows can move as a
      // block from just after a segment boundary: nothing there reads earlier
      // messages except to stop at that boundary.
      const shift = messageCount - cached.messageCount;
      let suffixStart = messageCount;
      while (suffixStart > s && suffixStart - 1 - shift >= s && sameAsCached(suffixStart - 1, suffixStart - 1 - shift)) suffixStart--;
      let boundary = Math.max(suffixStart, s) + 1;
      while (boundary <= messageCount && !isSegmentBoundary(messages[boundary - 1])) boundary++;
      const lastDirty = Math.max(-1, ...dirty.filter(index => index < messageCount));
      if (boundary < messageCount && lastDirty < boundary && boundary - s < messageCount - rebuildFrom) {
        rebuildFrom = s;
        rebuildTo = boundary;
        reusedSuffix = { cached, oldStart: boundary - shift };
      }
    }
    // Drop the entry before reusing its arrays so a throw mid-build cannot
    // leave a truncated entry behind.
    committedHistoryCaches.set(state, widthCaches.filter(entry => entry !== cached));
    if (!reusedSuffix) {
      const kept = rebuildFrom - s;
      const keptLines = kept === cached.messageCount - s ? cached.committedLines : cached.lineStarts[kept];
      if (options.reuseArrays && cached.ownsArrays) {
        // The previous result's arrays continue as this one's: copying several
        // arrays of every loaded row on each streaming frame cost more than the
        // rest of the build.
        lines = cached.lines;
        wrapContinuation = cached.wrapContinuation;
        wrapJoiners = cached.wrapJoiners;
        copyLines = cached.copyLines;
        lineAnchors = cached.lineAnchors;
        messageBounds = cached.messageBounds;
        for (const rows of [lines, wrapContinuation, wrapJoiners, copyLines, lineAnchors]) rows.length = keptLines;
        messageBounds.length = kept;
      } else {
        lines = cached.lines.slice(0, keptLines);
        wrapContinuation = cached.wrapContinuation.slice(0, keptLines);
        wrapJoiners = cached.wrapJoiners.slice(0, keptLines);
        copyLines = cached.copyLines.slice(0, keptLines);
        lineAnchors = cached.lineAnchors.slice(0, keptLines);
        messageBounds = cached.messageBounds.slice(0, kept);
      }
      // Bookkeeping arrays are private to the entry this build replaces.
      sourceRefs = cached.sourceRefs;
      sourceRefs.length = kept > 0 ? cached.sourceRefEnds[kept - 1] : 0;
      sourceRefEnds = cached.sourceRefEnds;
      sourceRefEnds.length = kept;
      lineStarts = cached.lineStarts;
      lineStarts.length = kept;
    }
  }

  if (!cached) {
    committedErroredToolCallIds = committedErroredToolCalls(messages, startMessageIndex);
    erroredToolCallIds = withPendingErroredToolCalls(committedErroredToolCallIds, state.pendingAI);
  }

  if (startMessageIndex === 0 && isActiveConversationLoading(state)) {
    pushLine(
      `  ${theme.dim}${conversationLoadingSpinnerText(state.conversationLoading!.startedAt)}${theme.reset}`,
      state,
      "conversation_loading",
    );
  }

  let segmentImages: HistoryImage[] = carriedImages;
  /** Whether the assistant segment being built has shown any row (a rebuild starts at a segment's start). */
  let segmentShown = false;
  for (let messageIndex = rebuildFrom; messageIndex < rebuildTo; messageIndex++) {
    // The loading row counts as the first row of the message below it, so a
    // rebuild from that message drops the old frame instead of keeping it.
    lineStarts.push(lines.length);
    if (state.historyLoadingOlder && messageIndex === historyLoadingInsertIndex) {
      pushHistoryLoadingLine();
    }
    const msg = state.messages[messageIndex];
    const start = lines.length;
    appendMessageSourceRefs(msg, sourceRefs);
    sourceRefEnds.push(sourceRefs.length);
    const messagePlan = plan.messages[messageIndex - startMessageIndex];
    if (messagePlan?.kind === "hidden") {
      // Folded away: no rows, or only the blank row before the reply it led to.
      if (messagePlan.spacer && userMessageNeedsTopMargin(state.messages, messageIndex)) pushLine("", msg, "user_margin_top");
      pushMessageBound(msg.role, start, lines.length, lines.length);
      continue;
    }
    if (messagePlan?.kind === "merged") {
      // The notification that started the live turn: no row of its own (its label leads
      // the Working row), only the blank line that separates the turn from the one above.
      // A prompt right after it (one it joined the turn of) brings that margin itself.
      if (state.messages[messageIndex + 1]?.role !== "user" && userMessageNeedsTopMargin(state.messages, messageIndex)) pushLine("", msg, "user_margin_top");
      pushMessageBound(msg.role, start, lines.length, lines.length);
    } else if (msg.role === "user" && messagePlan?.kind === "notification") {
      if (userMessageNeedsTopMargin(state.messages, messageIndex)) pushLine("", msg, "user_margin_top");
      const contentStart = lines.length;
      pushNotification(msg, messagePlan);
      const contentEnd = lines.length;
      pushImages(pastedImages(msg, msg.images, state.convId), "user_image");
      pushLine("", msg, "user_margin_bottom");
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "user") {
      if (userMessageNeedsTopMargin(state.messages, messageIndex)) pushLine("", msg, "user_margin_top");
      const contentStart = lines.length;
      // The owner's own Discord/WhatsApp message reads as theirs: their words in their bubble.
      const relay = ownerRelay(msg);
      const text = relay?.text ?? msg.text;
      const from = messagePlan?.kind === "from" ? messagePlan.label : null;
      const background = msg.metadata?.automation && !relay && !from ? theme.automatedUserBg : theme.userBg;
      const rendered = renderUserMessageCached(msg, text, availableWidth, msg.images, background);
      pushBlock(msg, "user_content", rendered);
      const contentEnd = lines.length;
      const flow = userMessageFlowMetadataCached(msg, text, availableWidth, msg.images, background);
      if (flow && flow.starts.length === contentEnd - contentStart) {
        for (let row = 0; row < flow.starts.length; row++) {
          lineAnchors[contentStart + row].userFlowDocument = flow.document;
          lineAnchors[contentStart + row].userFlowStart = flow.starts[row];
          lineAnchors[contentStart + row].userFlowEnd = flow.starts[row + 1] ?? flow.end;
        }
      }
      const provenance = relay ? `via ${relay.source}` : from ?? automationProvenance(msg.metadata?.automation);
      if (provenance) pushLine(rightAlignedProvenanceLabel(provenance, availableWidth), msg, "automation_label");
      pushImages(pastedImages(msg, msg.images, state.convId), "user_image");
      pushLine("", msg, "user_margin_bottom");
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "assistant") {
      // AI messages: content blocks, then metadata
      const contentStart = lines.length;
      const assistantPlan = messagePlan?.kind === "assistant" ? messagePlan : null;
      if (state.messages[messageIndex - 1]?.role !== "assistant") segmentShown = false;
      msg.blocks.forEach((block, blockIndex) => {
        if (assistantPlan?.hidden?.[blockIndex]) return;
        pushBlock(block, "assistant_block", renderAssistantBlock(block));
      });
      segmentImages.push(...attachedImages(msg.blocks));
      if (lines.length > contentStart) segmentShown = true;
      const nextMessage = state.messages[messageIndex + 1];
      const nextContinuesAssistantSegment = nextMessage?.role === "assistant"
        || (messageIndex === state.messages.length - 1 && state.pendingAI?.role === "assistant");
      const metadata = nextContinuesAssistantSegment
        ? null
        : assistantSegmentMetadata(state.messages, messageIndex) ?? assistantRunMetadata(state.messages, messageIndex);
      // Folded work that shows nothing (a turn a notice split, its first part all folded) leaves no lone metadata line.
      const foldedAway = assistantPlan?.hidden != null && !segmentShown && segmentImages.length === 0;
      const metadataLines = nextContinuesAssistantSegment || ((assistantPlan?.metaHidden || foldedAway) && msg !== durableSleepAssistant) ? [] : renderMetadata(metadata, { ...metadataOptions, active: msg === durableSleepAssistant });
      if (metadataLines.length > 0) trimTrailingBlankAssistantContent(contentStart);
      // Attached images close the visible message (the run of fragments), right before its metadata.
      if (!nextContinuesAssistantSegment) {
        pushImages(segmentImages, "assistant_image");
        segmentImages = [];
      }
      const contentEnd = lines.length;
      for (let i = 0; i < metadataLines.length; i++) {
        pushLine(metadataLines[i], msg, "assistant_metadata", i);
      }
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "system" && msg.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND) {
      pushLine("", msg, "compaction_margin_top");
      const contentStart = lines.length;
      pushLine(`  ${theme.muted}${compactionFinishedDivider(availableWidth)}${theme.reset}`, msg, "compaction_finished");
      const contentEnd = lines.length;
      pushLine("", msg, "compaction_margin_bottom");
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "system_instructions") {
      // Instructions are read and edited in /instructions, never in the history.
      pushMessageBound(msg.role, start, start, lines.length);
    } else {
      pushBlock(msg, "system_message", renderSystemMessage(msg.text, availableWidth, msg.color));
      const provenance = automationProvenance(msg.metadata?.automation);
      if (provenance) pushLine(rightAlignedProvenanceLabel(provenance, availableWidth), msg, "automation_label");
      pushMessageBound(msg.role, start, start, lines.length);
    }
  }

  if (reusedSuffix) {
    const { cached: previous, oldStart } = reusedSuffix;
    const s = startMessageIndex;
    const oldLine = previous.lineStarts[oldStart - s];
    const oldRef = previous.sourceRefEnds[oldStart - s - 1];
    const lineShift = lines.length - oldLine;
    const refShift = sourceRefs.length - oldRef;
    if (options.reuseArrays && previous.ownsArrays && lineShift === 0 && refShift === 0
      && messageCount === previous.messageCount) {
      // Same-height front (the loading row animating): patch it into the
      // previous arrays rather than copying every row behind it.
      const committedBounds = previous.messageCount - s;
      const patch = <T>(target: T[], front: T[], length: number) => {
        for (let i = 0; i < front.length; i++) target[i] = front[i];
        target.length = length;
        return target;
      };
      lines = patch(previous.lines, lines, previous.committedLines);
      wrapContinuation = patch(previous.wrapContinuation, wrapContinuation, previous.committedLines);
      wrapJoiners = patch(previous.wrapJoiners, wrapJoiners, previous.committedLines);
      copyLines = patch(previous.copyLines, copyLines, previous.committedLines);
      lineAnchors = patch(previous.lineAnchors, lineAnchors, previous.committedLines);
      messageBounds = patch(previous.messageBounds, messageBounds, committedBounds);
      lineStarts = patch(previous.lineStarts, lineStarts, committedBounds);
      sourceRefEnds = patch(previous.sourceRefEnds, sourceRefEnds, committedBounds);
      sourceRefs = patch(previous.sourceRefs, sourceRefs, previous.sourceRefs.length);
    } else {
      for (let row = oldLine; row < previous.committedLines; row++) {
        lines.push(previous.lines[row]);
        wrapContinuation.push(previous.wrapContinuation[row]);
        wrapJoiners.push(previous.wrapJoiners[row]);
        copyLines.push(previous.copyLines[row]);
        lineAnchors.push(previous.lineAnchors[row]);
      }
      for (let i = oldStart - s; i < previous.messageCount - s; i++) {
        const bound = previous.messageBounds[i];
        messageBounds.push(lineShift === 0 ? bound : {
          ...bound,
          start: bound.start + lineShift,
          end: bound.end + lineShift,
          contentStart: bound.contentStart + lineShift,
          contentEnd: bound.contentEnd + lineShift,
        });
        lineStarts.push(previous.lineStarts[i] + lineShift);
        sourceRefEnds.push(previous.sourceRefEnds[i] + refShift);
      }
      for (let i = oldRef; i < previous.sourceRefs.length; i++) sourceRefs.push(previous.sourceRefs[i]);
    }
    segmentImages = previous.carriedImages;
  }

  if (cacheable) {
    const entry: CommittedHistoryCache = {
      key: cacheKey,
      startMessageIndex,
      messageCount,
      sourceRefs,
      sourceRefEnds,
      lineStarts,
      committedLines: lines.length,
      erroredToolCallIds,
      planSignatures: plan.signatures,
      committedErroredToolCallIds: committedErroredToolCallIds!,
      lastContinuesIntoPending,
      durableSleepIndex,
      carriedImages: segmentImages,
      historyLoadingRow,
      historyLoadingInsertIndex,
      ownsArrays: options.reuseArrays === true,
      lines,
      wrapContinuation,
      wrapJoiners,
      copyLines,
      lineAnchors,
      messageBounds,
    };
    const others = (committedHistoryCaches.get(state) ?? []).filter(other => other !== cached && !sameRefs(other.key, cacheKey));
    committedHistoryCaches.set(state, [entry, ...others].slice(0, COMMITTED_HISTORY_CACHE_WIDTHS));
  }

  // With no turn below it, the loading row trails the committed rows, outside
  // the cache like the streaming rows, so a cached build never keeps a stale frame.
  if (state.historyLoadingOlder && historyLoadingInsertIndex === state.messages.length) {
    pushHistoryLoadingLine();
  }

  // Currently streaming AI message — no margins
  if (state.pendingAI) {
    const start = lines.length;
    const pendingPlan = plan.pending;
    if (pendingPlan && isStreaming(state) && state.pendingAI.metadata?.startedAt !== state.suppressPendingAIMetadataStartedAt) {
      pushChromeLine(workingRow(state.pendingAI.metadata, pendingPlan), state.pendingAI, "turn_working");
    }
    // The newest step, when already committed, sits under the working row.
    if (pendingPlan?.revealed) pushBlock(pendingPlan.revealed, "assistant_block", renderAssistantBlock(pendingPlan.revealed));
    state.pendingAI.blocks.forEach((block, blockIndex) => {
      if (pendingPlan?.hidden?.[blockIndex]) return;
      pushBlock(block, "assistant_block", renderAssistantBlock(block));
    });
    const pendingImages = [...segmentImages, ...attachedImages(state.pendingAI.blocks)];
    segmentImages = [];
    // Terminal stream notices (abort/error/watchdog) arrive just before
    // streaming_stopped. Keep pendingAI around for reconciliation, but do not
    // render metadata-only pending state next to the notice: if no assistant
    // content was persisted, that line disappears one frame later and flickers.
    const terminalNoticePendingStop = isTerminalStreamNotice(state.messages[state.messages.length - 1])
      && state.pendingAI.metadata?.startedAt === state.suppressPendingAIMetadataStartedAt;
    const pendingMetadataSuppressed = state.pendingAI.metadata?.startedAt === state.suppressPendingAIMetadataStartedAt;
    const shouldRenderPendingMetadata = !pendingMetadataSuppressed && (state.pendingAI.blocks.length > 0 || (
      state.contextCompactionStartedAt == null
      && state.pendingAICommittedIndex === null
      && !terminalNoticePendingStop
    ));
    const metadata = pendingAssistantSegmentMetadata(state) ?? pendingAssistantRunMetadata(state);
    const metadataLines = shouldRenderPendingMetadata
      ? renderMetadata(metadata, { ...metadataOptions, now: inlineSleepMetadataEndedAt(state) ?? undefined })
      : [];
    const compactionStartedAt = state.contextCompactionStartedAt;
    const compactionActive = compactionStartedAt != null;
    const connectionWaitStartedAt = state.connectionWaitStartedAt;
    const connectionWaitActive = connectionWaitStartedAt != null;
    if (metadataLines.length > 0 || compactionActive || connectionWaitActive) trimTrailingBlankAssistantContent(start);
    pushImages(pendingImages, "assistant_image");
    const contentEnd = lines.length;
    for (let i = 0; i < metadataLines.length; i++) pushLine(metadataLines[i], state.pendingAI, "assistant_metadata", i);
    if (compactionActive) {
      pushLine("", state.pendingAI, "compaction_margin_top");
      pushLine(
        `  ${theme.dim}${compactionSpinnerText(compactionStartedAt)}${theme.reset}`,
        state.pendingAI,
        "compaction_spinner",
      );
    }
    if (connectionWaitActive) {
      pushLine("", state.pendingAI, "connection_wait_margin_top");
      pushLine(
        `  ${theme.warning}${state.connectionWaitLabel ?? connectionWaitSpinnerText(connectionWaitStartedAt)}${theme.reset}`,
        state.pendingAI,
        "connection_wait_spinner",
      );
    }
    pushMessageBound(state.pendingAI.role, start, start, contentEnd);
  }

  // Live user-notice tail during streaming. These are buffered in state and
  // rendered after pendingAI so slash-command feedback stays visible at the
  // bottom instead of getting buried above a growing assistant message.
  for (const msg of state.streamingTailMessages ?? []) {
    const start = lines.length;
    pushBlock(msg, "streaming_tail", renderSystemMessage(msg.text, availableWidth, msg.color));
    pushMessageBound(msg.role, start, start, lines.length);
  }

  // Queued messages — dimmed user bubbles with timing label (after pendingAI)
  // Folded history hides queued notifications too: only the owner's own (typed or
  // relayed) messages wait at the bottom; Ctrl+O shows the rest.
  const ownQueued = (qm: (typeof state.queuedMessages)[number]) => !collapse || !qm.automation
    || ownerRelayedText(qm.text, { automation: qm.automation }) !== null;
  const queued = queuedMessagesInDisplayOrder(
    (state.convId
      ? state.queuedMessages.filter(qm => qm.convId === state.convId)
      : state.queuedMessages.filter(qm => isNewConversationQueuedMessage(qm) && qm.convId === state.pendingQueuedDraftConvId))
      .filter(ownQueued),
  );
  for (const qm of queued) {
    const relayed = ownerRelayedText(qm.text, qm.automation ? { automation: qm.automation } : null);
    if (qm.automation && relayed === null && qm.automation.kind !== "exo_send") {
      // A queued notification (shown with Ctrl+O) reads like the delivered ones: on the
      // assistant's side under its label, dimmed, with when it will be delivered.
      pushLine("", qm, "queued_margin_top");
      const label = `${automationLabel(qm.automation)} · ${queueTimingLabel(qm, Date.now(), state.provider)}`;
      pushLine(notificationLabelRow(label, label.length, availableWidth), qm, "queued_label");
      const body = renderNotificationBodyCached({ role: "user", text: qm.text, metadata: null }, availableWidth, qm);
      for (let i = 0; i < body.lines.length; i++) pushLine(`${theme.muted}${stripSgr(body.lines[i])}${theme.reset}`, qm, "queued_content", i);
      continue;
    }
    const provenance = automationProvenance(qm.automation);
    const timingLabel = [provenance, queueTimingLabel(qm, Date.now(), state.provider)].filter((label): label is string => Boolean(label)).join(" · ");
    pushLine("", qm, "queued_margin_top");
    // Render a dimmed user bubble
    const queuedText = relayed ?? qm.text;
    const background = qm.automation && !relayed ? theme.automatedUserBg : theme.userBg;
    const qr = renderUserMessageCached(qm, queuedText, availableWidth, qm.images, background);
    const queuedContentStart = lines.length;
    for (let i = 0; i < qr.lines.length; i++) {
      pushLine(`${theme.muted}${qr.lines[i]}${theme.reset}`, qm, "queued_content", i);
    }
    const flow = userMessageFlowMetadataCached(qm, queuedText, availableWidth, qm.images, background);
    if (flow && flow.starts.length === qr.lines.length) {
      for (let row = 0; row < flow.starts.length; row++) {
        lineAnchors[queuedContentStart + row].userFlowDocument = flow.document;
        lineAnchors[queuedContentStart + row].userFlowStart = flow.starts[row];
        lineAnchors[queuedContentStart + row].userFlowEnd = flow.starts[row + 1] ?? flow.end;
      }
    }
    // Timing label — right-aligned, muted italic
    pushLine(rightAlignedProvenanceLabel(timingLabel, availableWidth), qm, "queued_label");
  }

  return {
    lines,
    messageBounds,
    wrapContinuation,
    wrapJoiners,
    copyLines,
    lineAnchors,
    ...(options.partial ? { partial: true, startMessageIndex } : {}),
    revision: ++buildRevision,
  };
}
