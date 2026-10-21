/**
 * Turn collapsing and notification identity for the history view.
 *
 * The default view keeps each turn to what a reader needs: the user's message,
 * the agent's final reply and its metadata. The work in between (thinking, tool
 * calls, interim text) folds behind one clickable summary row, and notification
 * prompts (subagent completions, wakes, messages from other conversations...)
 * shrink to a one-row marker. Ctrl+O shows every turn's work and notification;
 * a click opens just one. The in-progress turn shows only its latest step under
 * a working indicator.
 *
 * planHistory is a cheap pass over block types only. Its per-message signatures
 * let the committed-row cache in conversation.ts rebuild exactly the messages
 * whose plan changed (a turn finishing, a click), not the whole history.
 */

import { isAutomatedUserPrompt, type AIMessage, type Block, type Message, type UserMessage, type UserMessageAutomation } from "./messages";
import { sanitizeUntrustedText } from "./terminaltext";

const AUTOMATION_LABELS: Record<UserMessageAutomation["kind"], string> = {
  external_notification: "Notification",
  background_task_completion: "Background completion",
  chrono_wake: "Chrono",
  chrono_hard_wake: "Chrono hard wake",
  exo_send: "Exo delegation",
  subagent_completion: "Subagent completion",
  goal_continuation: "Goal continuation",
  daemon_restart: "Daemon restart",
};

export function automationLabel(automation: UserMessageAutomation): string {
  return AUTOMATION_LABELS[automation.kind];
}

/** Label for a user-role message that was not typed by the user, or null for a real one. */
export function notificationLabel(msg: Pick<UserMessage, "text" | "metadata">): string | null {
  if (!isAutomatedUserPrompt(msg.text, msg.metadata)) return null;
  return msg.metadata?.automation ? automationLabel(msg.metadata.automation) : "Notification";
}

/** Routing ids that would fill a one-row preview without telling the reader anything. */
const PREVIEW_NOISE = /\s*(?:↳\s*)?(?:\[(?:ch|dm|msg|thread|chat|guild|reply-to):[^\]]*\]|<@!?\d+>)/g;
/** Leading envelopes the marker's label already says. */
const PREVIEW_ENVELOPE = /^\[(?:notification|chrono (?:hard )?wake:[^\]]*|external notification[^\]]*)\]\s*/;
/** Instructions addressed to the agent after the notification itself. */
const PREVIEW_AGENT_TAIL = /\n\s*\n(?:Action|Filter output):[\s\S]*$/;

/** The first meaningful words of a notification, on one line. */
export function notificationPreview(text: string): string {
  return sanitizeUntrustedText(text)
    .replace(PREVIEW_AGENT_TAIL, "")
    .replace(PREVIEW_ENVELOPE, "")
    .replace(PREVIEW_NOISE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Plan ────────────────────────────────────────────────────────────

const NOTIFICATION_SIGNATURES = ["n00", "n10", "n01", "n11"];

/** A user message's notification label and its plans, kept while its text and metadata are. */
interface NotificationMemo {
  text: string;
  metadata: UserMessage["metadata"];
  label: string | null;
  /** By open + 2 * collapse. */
  plans: Array<NotificationPlan | undefined>;
}

const notificationMemos = new WeakMap<object, NotificationMemo>();

function notificationMemo(msg: UserMessage): NotificationMemo {
  let memo = notificationMemos.get(msg);
  if (!memo || memo.text !== msg.text || memo.metadata !== msg.metadata) {
    memo = { text: msg.text, metadata: msg.metadata, label: notificationLabel(msg), plans: [] };
    notificationMemos.set(msg, memo);
  }
  return memo;
}

export interface AssistantPlan {
  kind: "assistant";
  /** Per block: true when the block folds into the turn's summary row. */
  hidden: readonly boolean[] | null;
  /** Summary row rendered above this message's blocks (the turn's first work), or null. */
  summary: string | null;
  /** Item whose expansion the summary row toggles. */
  toggle: object;
}

export interface NotificationPlan {
  kind: "notification";
  label: string;
  /** Full text shown (Ctrl+O, or clicked open) instead of the one-row marker. */
  open: boolean;
  /** Whether its header toggles it (only in the collapsed view). */
  toggleable: boolean;
}

export type MessagePlan = AssistantPlan | NotificationPlan | null;

export interface PendingPlan {
  /** Per pending block: true when hidden behind the working row. */
  hidden: readonly boolean[] | null;
  /** Hidden work in the whole turn (committed fragments and pending blocks). */
  summary: string | null;
  expanded: boolean;
  toggle: object;
}

export interface HistoryPlan {
  collapse: boolean;
  /** Indexed by messageIndex - start. */
  messages: MessagePlan[];
  /** Comparable per-message signatures for the committed-row cache. */
  signatures: string[];
  pending: PendingPlan | null;
}

interface WorkStats {
  toolCalls: number;
  texts: number;
}

function hasText(block: Block): boolean {
  return block.type === "text" && block.text.trim().length > 0;
}

/** `12 tool calls, 2 messages`; null when nothing but thinking was folded. */
export function workSummaryText(stats: WorkStats): string | null {
  const parts: string[] = [];
  if (stats.toolCalls > 0) parts.push(`${stats.toolCalls} tool call${stats.toolCalls === 1 ? "" : "s"}`);
  if (stats.texts > 0) parts.push(`${stats.texts} message${stats.texts === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function isToolBlock(block: Block): boolean {
  return block.type === "tool_call" || block.type === "tool_result";
}

export interface PlanHistoryInput {
  messages: readonly Message[];
  start: number;
  pendingAI: AIMessage | null;
  collapse: boolean;
  expanded: WeakSet<object>;
}

const NO_SIGNATURE = "";

export function planHistory(input: PlanHistoryInput): HistoryPlan {
  const { messages, start, pendingAI, collapse, expanded } = input;
  const count = messages.length;
  const plans: MessagePlan[] = new Array(Math.max(0, count - start)).fill(null);
  const signatures: string[] = new Array(Math.max(0, count - start)).fill(NO_SIGNATURE);
  let pending: PendingPlan | null = null;

  for (let index = start; index < count; index++) {
    const msg = messages[index];
    if (msg.role !== "user") continue;
    const memo = notificationMemo(msg);
    if (!memo.label) continue;
    const open = !collapse || expanded.has(msg);
    const variant = (open ? 1 : 0) + (collapse ? 2 : 0);
    plans[index - start] = memo.plans[variant] ??= { kind: "notification", label: memo.label, open, toggleable: collapse };
    signatures[index - start] = NOTIFICATION_SIGNATURES[variant];
  }
  if (!collapse) return { collapse, messages: plans, signatures, pending };

  const pendingContinues = pendingAI?.role === "assistant";
  let turnStart = start;
  for (let index = start; index <= count; index++) {
    if (index < count && (index === start || messages[index].role !== "user")) continue;
    const inProgress = index === count && pendingContinues;
    // The live turn keeps its newest step in view: the pending one, or until a
    // new round starts streaming (or a client joins mid-turn), the last committed.
    const pendingLatest = inProgress ? latestStep(pendingAI!.blocks) : -1;
    let reveal: StepRef | null = null;
    for (let at = index - 1; inProgress && pendingLatest < 0 && at >= turnStart && !reveal; at--) {
      const msg = messages[at];
      const block = msg.role === "assistant" ? latestStep(msg.blocks) : -1;
      if (block >= 0) reveal = { message: at, block };
    }
    planTurn(messages, start, turnStart, index, inProgress, reveal, expanded, plans, signatures);
    if (inProgress) pending = planPending(messages, turnStart, index, pendingAI!, pendingLatest, reveal, expanded);
    turnStart = index;
  }
  return { collapse, messages: plans, signatures, pending };
}

interface StepRef {
  message: number;
  block: number;
}

/** The step a live turn is on: streaming text, else its newest tool call; -1 when neither. */
function latestStep(blocks: readonly Block[]): number {
  const last = blocks.length - 1;
  if (last >= 0 && hasText(blocks[last])) return last;
  for (let index = last; index >= 0; index--) {
    if (blocks[index].type === "tool_call") return index;
  }
  return -1;
}

/**
 * Turn expansions are keyed by a token per opening message, kept apart from
 * that message itself: a notification that opens a turn folds on its own.
 */
const turnTokens = new WeakMap<object, object>();

function turnKey(messages: readonly Message[], turnStart: number, fallback: object): object {
  const head = messages[turnStart] ?? fallback;
  let token = turnTokens.get(head);
  if (!token) turnTokens.set(head, token = {});
  return token;
}

function planTurn(
  messages: readonly Message[],
  start: number,
  from: number,
  to: number,
  inProgress: boolean,
  reveal: StepRef | null,
  expanded: WeakSet<object>,
  plans: MessagePlan[],
  signatures: string[],
): void {
  if (from >= to) return;
  const key = turnKey(messages, from, messages[from]);
  const open = expanded.has(key);
  const memo = turnMemos.get(key);
  if (memo && turnMemoValid(memo, messages, from, to, inProgress, reveal, open)) {
    for (let index = from; index < to; index++) {
      if (messages[index].role !== "assistant") continue;
      plans[index - start] = memo.plans[index - from];
      signatures[index - start] = memo.signatures[index - from];
    }
    return;
  }

  // The final reply is the text after the last tool block; everything before
  // it is work. A turn still running has no final reply yet.
  let lastToolMessage = -1;
  let lastToolBlock = -1;
  for (let index = to - 1; index >= from && lastToolMessage < 0; index--) {
    const msg = messages[index];
    if (msg.role !== "assistant") continue;
    for (let block = msg.blocks.length - 1; block >= 0; block--) {
      if (isToolBlock(msg.blocks[block])) {
        lastToolMessage = index;
        lastToolBlock = block;
        break;
      }
    }
  }

  const stats: WorkStats = { toolCalls: 0, texts: 0 };
  let host = -1;
  const hiddenByMessage: Array<boolean[] | null> = [];
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") {
      hiddenByMessage.push(null);
      continue;
    }
    const hidden = msg.blocks.map((block, blockIndex) => {
      const work = inProgress
        ? reveal?.message !== index || reveal.block !== blockIndex
        : index < lastToolMessage
        || (index === lastToolMessage && blockIndex <= lastToolBlock)
        || block.type === "thinking";
      if (work) {
        if (block.type === "tool_call") stats.toolCalls++;
        else if (hasText(block)) stats.texts++;
      }
      return work;
    });
    if (host < 0 && hidden.some(Boolean)) host = index;
    hiddenByMessage.push(hidden);
  }

  const summaryText = workSummaryText(stats);
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") continue;
    const hidden = open ? null : hiddenByMessage[index - from];
    // An in-progress turn's summary is its working row under the pending blocks.
    const summary = !inProgress && index === host && summaryText ? `${open ? "▾" : "▸"} ${summaryText}` : null;
    plans[index - start] = { kind: "assistant", hidden, summary, toggle: key };
    signatures[index - start] = `a${summary ?? ""}|${hidden ? hidden.map(value => value ? 1 : 0).join("") : "*"}`;
  }
  turnMemos.set(key, {
    messages: messages.slice(from, to),
    blockCodes: messages.slice(from, to).map(msg => msg.role === "assistant" ? msg.blocks.map(blockCode) : null),
    inProgress,
    reveal: reveal ? { message: reveal.message - from, block: reveal.block } : null,
    open,
    plans: plans.slice(from - start, to - start),
    signatures: signatures.slice(from - start, to - start),
  });
}

/**
 * A finished turn's plan, reused while nothing it was planned from changed.
 * Every streaming frame plans the whole loaded history; without this, long
 * conversations re-derived (and re-allocated) thousands of plans per frame.
 */
interface TurnMemo {
  messages: Message[];
  /** blockCode of every block of each assistant message. */
  blockCodes: Array<number[] | null>;
  inProgress: boolean;
  /** Relative to the turn's first message. */
  reveal: StepRef | null;
  open: boolean;
  plans: MessagePlan[];
  signatures: string[];
}

const turnMemos = new WeakMap<object, TurnMemo>();

/** What a plan reads from a block: its type and, for text, whether it is blank. */
function blockCode(block: Block): number {
  switch (block.type) {
    case "thinking": return 0;
    case "text": return hasText(block) ? 2 : 1;
    case "tool_call": return 3;
    case "tool_result": return 4;
  }
}

function turnMemoValid(
  memo: TurnMemo,
  messages: readonly Message[],
  from: number,
  to: number,
  inProgress: boolean,
  reveal: StepRef | null,
  open: boolean,
): boolean {
  if (memo.messages.length !== to - from || memo.inProgress !== inProgress || memo.open !== open) return false;
  if ((memo.reveal === null) !== (reveal === null)) return false;
  if (memo.reveal && reveal && (memo.reveal.message !== reveal.message - from || memo.reveal.block !== reveal.block)) return false;
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (memo.messages[index - from] !== msg) return false;
    if (msg.role !== "assistant") continue;
    const codes = memo.blockCodes[index - from]!;
    if (codes.length !== msg.blocks.length) return false;
    for (let block = 0; block < codes.length; block++) {
      if (codes[block] !== blockCode(msg.blocks[block])) return false;
    }
  }
  return true;
}

function planPending(
  messages: readonly Message[],
  from: number,
  to: number,
  pendingAI: AIMessage,
  latest: number,
  reveal: StepRef | null,
  expanded: WeakSet<object>,
): PendingPlan {
  const key = turnKey(messages, from, pendingAI);
  const open = expanded.has(key);
  const stats: WorkStats = { toolCalls: 0, texts: 0 };
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") continue;
    msg.blocks.forEach((block, blockIndex) => {
      if (reveal?.message === index && reveal.block === blockIndex) return;
      if (block.type === "tool_call") stats.toolCalls++;
      else if (hasText(block)) stats.texts++;
    });
  }

  const blocks = pendingAI.blocks;
  const hidden = blocks.map((block, index) => {
    const isHidden = index !== latest;
    if (isHidden) {
      if (block.type === "tool_call") stats.toolCalls++;
      else if (hasText(block)) stats.texts++;
    }
    return isHidden;
  });
  return { hidden: open ? null : hidden, summary: workSummaryText(stats), expanded: open, toggle: key };
}
