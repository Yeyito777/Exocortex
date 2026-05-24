/**
 * Conversation rendering — message flow and line anchoring.
 *
 * Turns the message list + pendingAI into display lines while preserving stable
 * anchors for viewport/cursor behavior. Block-level styling and wrapping live
 * in blockrenderer.ts.
 */

import { combineMessageMetadata, type Message, type MessageMetadata } from "./messages";
import type { RenderState } from "./state";
import { renderMetadata } from "./metadata";
import { theme } from "./theme";
import { renderBlockCached, renderSystemMessage, renderUserMessage } from "./blockrenderer";
import { isVisuallyBlankLine, sanitizeUntrustedText } from "./terminaltext";
import { termWidth } from "./textwidth";
import { wordWrap, type WrapCopyLine, type WrapResult } from "./textwrap";

export { wordWrap, type WrapResult } from "./textwrap";

function isTerminalStreamNotice(msg: Message | undefined): boolean {
  return msg?.role === "system" && (msg.text.startsWith("✗") || msg.color === theme.error);
}

function assistantRunMetadata(messages: Message[], endIndex: number): MessageMetadata | null {
  let startIndex = endIndex;
  while (startIndex > 0 && messages[startIndex - 1]?.role === "assistant") startIndex--;

  let metadata: MessageMetadata | null = null;
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (msg?.role === "assistant") metadata = combineMessageMetadata(metadata, msg.metadata);
  }
  return metadata;
}

function pendingAssistantRunMetadata(state: RenderState): MessageMetadata | null {
  let metadata = state.pendingAI?.metadata ? { ...state.pendingAI.metadata } : null;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg.role !== "assistant") break;
    metadata = combineMessageMetadata(msg.metadata, metadata);
  }
  return metadata;
}

function isRealUserMessage(msg: Message): boolean {
  return msg.role === "user" && msg.metadata?.system !== true;
}

function assistantSegmentMetadata(messages: Message[], endIndex: number): MessageMetadata | null {
  const current = messages[endIndex];
  if (current?.role !== "assistant") return null;

  let startIndex = endIndex;
  while (startIndex > 0 && !isRealUserMessage(messages[startIndex - 1])) startIndex--;

  let metadata: MessageMetadata | null = null;
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") metadata = combineMessageMetadata(metadata, msg.metadata);
  }
  return metadata;
}

function pendingAssistantSegmentMetadata(state: RenderState): MessageMetadata | null {
  if (!state.pendingAI) return null;

  let startIndex = state.messages.length;
  while (startIndex > 0 && !isRealUserMessage(state.messages[startIndex - 1])) startIndex--;

  let metadata: MessageMetadata | null = null;
  for (let i = startIndex; i < state.messages.length; i++) {
    const msg = state.messages[i];
    if (msg.role === "assistant") metadata = combineMessageMetadata(metadata, msg.metadata);
  }
  return combineMessageMetadata(metadata, state.pendingAI.metadata);
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
  | "assistant_metadata"
  | "queued_content"
  | "queued_label"
  | "queued_margin_top"
  | "streaming_tail"
  | "system_instructions_bottom"
  | "system_instructions_content"
  | "system_instructions_top"
  | "system_message"
  | "user_content"
  | "user_margin_bottom"
  | "user_margin_top";

export interface RenderLineAnchor {
  /** Stable owner identity for this rendered segment (message/block/queued item). */
  owner: object;
  /** Segment within the owner (content, metadata, margins, etc). */
  segment: RenderLineSegment;
  /** Logical line index within the segment (increments on hard newlines / semantic rows). */
  index: number;
  /** Wrapped visual row within that logical line (0 for the first row). */
  subIndex: number;
}

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
}

export interface BuildMessageLinesOptions {
  startMessageIndex?: number;
  partial?: boolean;
}

// ── Build all display lines ─────────────────────────────────────────

export function buildMessageLines(
  state: RenderState,
  availableWidth: number,
  options: BuildMessageLinesOptions = {},
): BuildMessageLinesResult {
  const contentWidth = availableWidth - 4;
  const lines: string[] = [];
  const wrapContinuation: boolean[] = [];
  const wrapJoiners: string[] = [];
  const copyLines: Array<WrapCopyLine | null> = [];
  const messageBounds: MessageBound[] = [];
  const lineAnchors: RenderLineAnchor[] = [];

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
    for (let i = 0; i < br.lines.length; i++) {
      if (i === 0 || !br.cont[i]) {
        logicalIndex++;
        subIndex = 0;
      } else {
        subIndex++;
      }
      pushAnchoredLine(br.lines[i], br.cont[i], br.join[i], owner, segment, logicalIndex, subIndex, br.copy?.[i] ?? null);
    }
  };

  /** Append a non-wrapped line (margin, metadata, etc). */
  const pushLine = (line: string, owner: object, segment: RenderLineSegment, index = 0) => {
    pushAnchoredLine(line, false, "", owner, segment, index, 0);
  };

  const trimTrailingBlankAssistantContent = (minLength: number) => {
    while (lines.length > minLength) {
      const anchor = lineAnchors[lineAnchors.length - 1];
      if (!anchor || anchor.segment !== "assistant_block") break;
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

  const startMessageIndex = Math.max(0, Math.min(options.startMessageIndex ?? 0, state.messages.length));
  let firstUser = true;
  for (let i = 0; i < startMessageIndex; i++) {
    if (state.messages[i]?.role === "user") {
      firstUser = false;
      break;
    }
  }

  for (let messageIndex = startMessageIndex; messageIndex < state.messages.length; messageIndex++) {
    const msg = state.messages[messageIndex];
    const start = lines.length;
    if (msg.role === "user") {
      if (!firstUser) pushLine("", msg, "user_margin_top");  // top margin (skip for first)
      const contentStart = lines.length;
      pushBlock(msg, "user_content", renderUserMessage(msg.text, availableWidth, msg.images));
      const contentEnd = lines.length;
      pushLine("", msg, "user_margin_bottom");               // bottom margin
      firstUser = false;
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "assistant") {
      // AI messages: content blocks, then metadata
      const contentStart = lines.length;
      for (const block of msg.blocks) {
        pushBlock(block, "assistant_block", renderBlockCached(block, contentWidth, state.toolRegistry, state.externalToolStyles, state.showToolOutput));
      }
      const nextIsAssistant = state.messages[messageIndex + 1]?.role === "assistant"
        || (messageIndex === state.messages.length - 1 && state.pendingAI?.role === "assistant");
      const metadata = assistantSegmentMetadata(state.messages, messageIndex) ?? assistantRunMetadata(state.messages, messageIndex);
      const metadataLines = nextIsAssistant ? [] : renderMetadata(metadata);
      if (metadataLines.length > 0) trimTrailingBlankAssistantContent(contentStart);
      const contentEnd = lines.length;
      for (let i = 0; i < metadataLines.length; i++) pushLine(metadataLines[i], msg, "assistant_metadata", i);
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "system_instructions") {
      if (!msg.text.trim()) {
        pushMessageBound(msg.role, start, start, lines.length);
        continue;
      }
      const boxWidth = availableWidth;
      const textWidth = boxWidth - 4; // │ + space + text + space + │
      const title = " System Instructions ";
      const topFill = Math.max(0, boxWidth - 2 - title.length); // -2 for ┌ and ┐
      const topLine = `┌${title}${"─".repeat(topFill)}┐`;
      const bottomLine = `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`;

      pushLine(`${theme.accent}${topLine}${theme.reset}`, msg, "system_instructions_top");
      const contentStart = lines.length;

      const { lines: wrapped } = wordWrap(sanitizeUntrustedText(msg.text), textWidth > 0 ? textWidth : 1);
      for (let i = 0; i < wrapped.length; i++) {
        const sl = wrapped[i];
        const pad = " ".repeat(Math.max(0, textWidth - termWidth(sl)));
        pushLine(`${theme.accent}│${theme.reset} ${theme.dim}${sl}${pad}${theme.reset} ${theme.accent}│${theme.reset}`, msg, "system_instructions_content", i);
      }
      const contentEnd = lines.length;

      pushLine(`${theme.accent}${bottomLine}${theme.reset}`, msg, "system_instructions_bottom");
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else {
      pushBlock(msg, "system_message", renderSystemMessage(msg.text, availableWidth, msg.color));
      pushMessageBound(msg.role, start, start, lines.length);
    }
  }

  // Currently streaming AI message — no margins
  if (state.pendingAI) {
    const start = lines.length;
    for (const block of state.pendingAI.blocks) {
      pushBlock(block, "assistant_block", renderBlockCached(block, contentWidth, state.toolRegistry, state.externalToolStyles, state.showToolOutput));
    }
    // Terminal stream notices (abort/error/watchdog) arrive just before
    // streaming_stopped. Keep pendingAI around for reconciliation, but do not
    // render metadata-only pending state next to the notice: if no assistant
    // content was persisted, that line disappears one frame later and flickers.
    const terminalNoticePendingStop = isTerminalStreamNotice(state.messages[state.messages.length - 1])
      && state.pendingAI.metadata?.startedAt === state.suppressPendingAIMetadataStartedAt;
    const shouldRenderPendingMetadata = state.pendingAI.blocks.length > 0 || (
      state.pendingAICommittedIndex === null && !terminalNoticePendingStop
    );
    const metadata = pendingAssistantSegmentMetadata(state) ?? pendingAssistantRunMetadata(state);
    const metadataLines = shouldRenderPendingMetadata ? renderMetadata(metadata) : [];
    if (metadataLines.length > 0) trimTrailingBlankAssistantContent(start);
    const contentEnd = lines.length;
    for (let i = 0; i < metadataLines.length; i++) pushLine(metadataLines[i], state.pendingAI, "assistant_metadata", i);
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
  if (state.convId) {
    const queued = state.queuedMessages.filter(qm => qm.convId === state.convId);
    for (const qm of queued) {
      const timingLabel = qm.timing === "next-turn" ? "queued: next turn" : "queued: message end";
      pushLine("", qm, "queued_margin_top");
      // Render a dimmed user bubble
      const qr = renderUserMessage(qm.text, availableWidth, qm.images);
      for (let i = 0; i < qr.lines.length; i++) {
        pushLine(`${theme.muted}${qr.lines[i]}${theme.reset}`, qm, "queued_content", i);
      }
      // Timing label — right-aligned, muted italic
      const labelPad = " ".repeat(Math.max(0, availableWidth - timingLabel.length - 3));
      pushLine(`${labelPad}${theme.muted}${theme.italic}${timingLabel}${theme.reset}`, qm, "queued_label");
    }
  }

  return {
    lines,
    messageBounds,
    wrapContinuation,
    wrapJoiners,
    copyLines,
    lineAnchors,
    ...(options.partial ? { partial: true, startMessageIndex } : {}),
  };
}
