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

import { isAutomatedUserPrompt, ownerRelayedText, type AIMessage, type Block, type Message, type UserMessage, type UserMessageAutomation } from "./messages";
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

export interface OwnerRelay {
  /** The owner's own words, shown in their bubble. */
  text: string;
  /** Where it came from, e.g. `Discord/paramount · DM`. */
  source: string;
}

const ownerRelays = new WeakMap<object, { text: string; metadata: UserMessage["metadata"]; relay: OwnerRelay | null }>();

/**
 * A notification relaying the owner's own message (their Discord DM, a
 * WhatsApp /ai command): it reads as their message, not as a notification.
 */
export function ownerRelay(msg: Pick<UserMessage, "text" | "metadata">): OwnerRelay | null {
  const cached = ownerRelays.get(msg);
  if (cached && cached.text === msg.text && cached.metadata === msg.metadata) return cached.relay;
  const text = ownerRelayedText(msg.text, msg.metadata);
  const relay = text === null ? null : { text, source: notificationPreview(msg.text.split("\n", 1)[0] ?? "") };
  ownerRelays.set(msg, { text: msg.text, metadata: msg.metadata, relay });
  return relay;
}

/** Label for a user-role message that was not typed by the user, or null for a real one. */
export function notificationLabel(msg: Pick<UserMessage, "text" | "metadata">): string | null {
  if (!isAutomatedUserPrompt(msg.text, msg.metadata) || ownerRelay(msg)) return null;
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
  /** The closed background run this turn's work folds into (search opens it). */
  runToggle?: object;
  /** Style A: what folded before this reply, appended to its metadata line (`↳ chrono · 7 tools ▸`). */
  metaTag?: string;
  /** Style C: marker in the left gutter of this message's first row (`▸` / `▾`). */
  gutter?: string;
  /** Style B: metadata hidden (only an episode's last reply keeps it). */
  metaHidden?: boolean;
  /** The fold group the tag, gutter or reply belongs to. */
  groupToggle?: object;
}

/**
 * Alternative fold styles (experimental, tui.foldStyle):
 * - rows: today's rows (a notification row, a work row per turn, runs of background turns);
 * - inline (A): no extra rows; folded work and notifications become a tag on the reply's metadata line;
 * - episode (B): everything between two of the owner's messages folds into one line, replies stay;
 * - gutter (C): a marker in the left gutter of each reply that has folded work before it.
 */
export type FoldStyle = "rows" | "inline" | "episode" | "gutter";
export const FOLD_STYLES: readonly FoldStyle[] = ["rows", "inline", "episode", "gutter"];

/** A message inside a fold group of styles A–C. */
export interface GroupPlan {
  kind: "group";
  /** hidden: no rows; spacer: one blank row (keeps replies apart); line: one dim toggle row. */
  role: "hidden" | "spacer" | "line";
  text: string | null;
  toggle: object;
  /** For a line on a message that still renders (an opened group): its own plan, after the line. */
  inner?: MessagePlan;
}

export interface NotificationPlan {
  kind: "notification";
  label: string;
  /** Full text shown (Ctrl+O, or clicked open) instead of the one-row marker. */
  open: boolean;
  /** Whether its header toggles it (only in the collapsed view). */
  toggleable: boolean;
  /** An opened background run starts here: its `▾ …` row, above this notification. */
  runHeader?: string;
  runToggle?: object;
}

/**
 * A message inside a closed run of background turns: consecutive
 * notification-triggered turns that show no reply fold into one row on the
 * run's first message; the rest of the run renders nothing.
 */
export interface RunPlan {
  kind: "run";
  /** The run's row (on its first message), or null. */
  header: string | null;
  /** The notification's label, set when the run is a single turn (styled like a notification row). */
  label: string | null;
  toggle: object;
  /** The run's last turn has a reply: it shows below the row, after a blank line. */
  gap: boolean;
}

export type MessagePlan = AssistantPlan | NotificationPlan | RunPlan | GroupPlan | null;

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
  style?: FoldStyle;
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
  /** Finished turns as [from, to) pairs, flattened. */
  const turns: number[] = [];
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
    else if (turnStart < index) turns.push(turnStart, index);
    turnStart = index;
  }
  const style = input.style ?? "rows";
  if (style === "rows") planRuns(messages, start, turns, expanded, plans, signatures);
  else planGroups(messages, start, turns, style, expanded, plans, signatures);
  return { collapse, messages: plans, signatures, pending };
}

// ── Background runs ─────────────────────────────────────────────────

interface RunMember {
  from: number;
  to: number;
  shape: TurnShape;
}

interface TurnShape {
  /** The turn's notification label, or null when it is not notification-triggered. */
  label: string | null;
  preview: string;
  /** Shows text after its last tool round (its reply). */
  reply: boolean;
  /** Holds something a run must not hide (a system notice, attached images). */
  blocking: boolean;
  toolCalls: number;
}

/** A turn's shape, kept while its messages, their block arrays and lengths are unchanged. */
const shapeMemos = new WeakMap<object, { refs: unknown[]; label: string | null; shape: TurnShape }>();

function turnShape(messages: readonly Message[], from: number, to: number, plans: readonly MessagePlan[], start: number): TurnShape {
  const head = plans[from - start];
  const label = head?.kind === "notification" ? head.label : null;
  const memo = shapeMemos.get(messages[from]);
  if (memo && memo.label === label && memo.refs.length === (to - from) * 3) {
    let same = true;
    for (let index = from, at = 0; index < to && same; index++, at += 3) {
      const msg = messages[index];
      const blocks = msg.role === "assistant" ? msg.blocks : null;
      same = memo.refs[at] === msg && memo.refs[at + 1] === blocks && memo.refs[at + 2] === (blocks?.length ?? -1);
    }
    if (same) return memo.shape;
  }
  const shape = computeTurnShape(messages, from, to, label);
  const refs: unknown[] = [];
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    const blocks = msg.role === "assistant" ? msg.blocks : null;
    refs.push(msg, blocks, blocks?.length ?? -1);
  }
  shapeMemos.set(messages[from], { refs, label, shape });
  return shape;
}

function computeTurnShape(messages: readonly Message[], from: number, to: number, label: string | null): TurnShape {
  let reply = false;
  let blocking = false;
  let toolCalls = 0;
  for (let index = from + 1; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") {
      blocking = true;
      continue;
    }
    for (const block of msg.blocks) {
      if (block.type === "tool_call") {
        toolCalls++;
        reply = false;
      } else if (block.type === "tool_result") {
        if (block.images?.length) blocking = true;
        reply = false;
      } else if (hasText(block)) {
        reply = true;
      }
    }
  }
  const msg = messages[from];
  return { label, preview: label && msg.role === "user" ? notificationPreview(msg.text) : "", reply, blocking, toolCalls };
}

const runTokens = new WeakMap<object, object>();

function runKey(head: object): object {
  let token = runTokens.get(head);
  if (!token) runTokens.set(head, token = {});
  return token;
}

/**
 * Fold each run of silent background turns (notification-triggered, no
 * reply) into one row. A notification-triggered turn with a reply right after
 * the run joins it: its notification and work fold into the run's row and its
 * reply stays below. Per-turn metadata of the silent turns is hidden too.
 */
function planRuns(
  messages: readonly Message[],
  start: number,
  turns: readonly number[],
  expanded: WeakSet<object>,
  plans: MessagePlan[],
  signatures: string[],
): void {
  let run: RunMember[] = [];
  const flush = (closer: RunMember | null) => {
    if (run.length > 0) applyRun(messages, start, run, closer, expanded, plans, signatures);
    run = [];
  };
  for (let at = 0; at < turns.length; at += 2) {
    const from = turns[at];
    const to = turns[at + 1];
    // Prompts the user typed (most turns) cannot be in a run: skip the shape walk. A
    // notification nothing answered (yet) is news, not background work: it stays a row.
    if (plans[from - start]?.kind !== "notification" || to - from === 1) {
      if (run.length > 0) flush(null);
      continue;
    }
    const shape = turnShape(messages, from, to, plans, start);
    if (shape.blocking) flush(null);
    else if (shape.reply) flush({ from, to, shape });
    else run.push({ from, to, shape });
  }
  flush(null);
}

function applyRun(
  messages: readonly Message[],
  start: number,
  silent: readonly RunMember[],
  closer: RunMember | null,
  expanded: WeakSet<object>,
  plans: MessagePlan[],
  signatures: string[],
): void {
  const first = silent[0];
  const toggle = runKey(messages[first.from]);
  const open = expanded.has(toggle);
  const members = closer ? [...silent, closer] : silent;
  const toolCalls = members.reduce((sum, member) => sum + member.shape.toolCalls, 0);
  const work = toolCalls ? ` · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` : "";
  const single = members.length === 1;
  const text = single
    ? `${first.shape.label}${work}${first.shape.preview ? ` · ${first.shape.preview}` : ""}`
    : `${members.length} background turns${work}`;
  const header = `${open ? "▾" : "▸"} ${text}`;

  if (open) {
    const plan = plans[first.from - start] as NotificationPlan;
    plans[first.from - start] = { ...plan, runHeader: header, runToggle: toggle };
    signatures[first.from - start] += `|R${header}`;
    return;
  }
  const gap = closer !== null;
  const label = single ? first.shape.label : null;
  let memo = runMemos.get(toggle);
  if (!memo || memo.header !== header || memo.gap !== gap || memo.label !== label) {
    memo = {
      header, gap, label,
      head: { kind: "run", header, label, toggle, gap },
      rest: { kind: "run", header: null, label: null, toggle, gap },
      headSignature: `r${header}|${gap ? 1 : 0}`,
      folded: new WeakMap(),
    };
    runMemos.set(toggle, memo);
  }
  for (const member of silent) {
    for (let index = member.from; index < member.to; index++) {
      const isHeader = index === first.from;
      plans[index - start] = isHeader ? memo.head : memo.rest;
      signatures[index - start] = isHeader ? memo.headSignature : "r";
    }
  }
  if (!closer) return;
  plans[closer.from - start] = memo.rest;
  signatures[closer.from - start] = "r";
  for (let index = closer.from + 1; index < closer.to; index++) {
    const plan = plans[index - start];
    // A turn the reader opened on its own stays open.
    if (plan?.kind !== "assistant" || plan.hidden === null) continue;
    let folded = memo.folded.get(plan);
    if (!folded) memo.folded.set(plan, folded = { plan: { ...plan, summary: null, runToggle: toggle }, signature: `${signatures[index - start]}|R` });
    plans[index - start] = folded.plan;
    signatures[index - start] = folded.signature;
  }
}

/** A closed run's plans, reused while its row reads the same. */
const runMemos = new WeakMap<object, {
  header: string;
  gap: boolean;
  label: string | null;
  head: RunPlan;
  rest: RunPlan;
  headSignature: string;
  /** The reply turn's assistant plans with their summary row folded into the run's. */
  folded: WeakMap<AssistantPlan, { plan: AssistantPlan; signature: string }>;
}>();

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

// ── Search ──────────────────────────────────────────────────────────

export interface FoldedSearchInput extends PlanHistoryInput {}

/**
 * The text each folded row hides, by the row's toggle (a turn's token, or the
 * notification itself), so `/` can find matches inside folded work.
 */
export function foldedSearchTexts(input: FoldedSearchInput): Map<object, string> {
  const out = new Map<object, string>();
  if (!input.collapse) return out;
  const plan = planHistory(input);
  const add = (key: object, text: string) => out.set(key, out.has(key) ? `${out.get(key)}\n${text}` : text);
  const addBlocks = (key: object, blocks: readonly Block[], hidden: readonly boolean[]) => {
    blocks.forEach((block, index) => {
      if (!hidden[index]) return;
      if (block.type === "text" || block.type === "thinking") add(key, block.text);
      else if (block.type === "tool_call") add(key, `${block.toolName} ${block.summary}`);
    });
  };
  plan.messages.forEach((messagePlan, offset) => {
    const msg = input.messages[input.start + offset];
    if (!messagePlan || !msg) return;
    if (messagePlan.kind === "run") {
      if (msg.role === "user") add(messagePlan.toggle, msg.text);
      else if (msg.role === "assistant") addBlocks(messagePlan.toggle, msg.blocks, msg.blocks.map(() => true));
    } else if (messagePlan.kind === "notification") {
      if (!messagePlan.open && msg.role === "user") add(msg, msg.text);
    } else if (messagePlan.kind === "assistant" && messagePlan.hidden && msg.role === "assistant") {
      addBlocks(messagePlan.runToggle ?? messagePlan.toggle, msg.blocks, messagePlan.hidden);
    }
  });
  if (plan.pending?.hidden && input.pendingAI) addBlocks(plan.pending.toggle, input.pendingAI.blocks, plan.pending.hidden);
  return out;
}

// ── Fold groups (styles A–C) ────────────────────────────────────────

interface GroupTurn {
  from: number;
  to: number;
  /** owner: a prompt the user typed or relayed; notification; none: the window opens mid-turn. */
  head: "owner" | "notification" | "none";
  shape: TurnShape;
}

const groupTokens = new WeakMap<object, object>();

function groupKey(head: object): object {
  let token = groupTokens.get(head);
  if (!token) groupTokens.set(head, token = {});
  return token;
}

const SHORT_LABELS: Record<string, string> = {
  "Background completion": "task",
  "Chrono": "chrono",
  "Chrono hard wake": "chrono",
  "Exo delegation": "exo",
  "Subagent completion": "subagent",
  "Goal continuation": "goal",
  "Daemon restart": "restart",
};

/** `discord`, `gmail`, `chrono`, `subagent`…: the one-word source of a notification. */
function shortSource(shape: TurnShape): string {
  if (shape.label && SHORT_LABELS[shape.label]) return SHORT_LABELS[shape.label];
  const source = /^([A-Za-z]+)/.exec(shape.preview)?.[1];
  return source ? source.toLowerCase() : "notification";
}

function groupSummary(members: readonly GroupTurn[]): { notifications: number; tools: number; source: string | null } {
  const notes = members.filter(member => member.head === "notification");
  return {
    notifications: notes.length,
    tools: members.reduce((sum, member) => sum + member.shape.toolCalls, 0),
    source: notes.length === 1 ? shortSource(notes[0].shape) : null,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function planSignature(plan: MessagePlan): string {
  if (!plan) return "";
  if (plan.kind === "group") return `g${plan.role}|${plan.text ?? ""}|${planSignature(plan.inner ?? null)}`;
  if (plan.kind === "assistant") {
    return `a${plan.summary ?? ""}|${plan.hidden ? plan.hidden.map(value => value ? 1 : 0).join("") : "*"}|${plan.metaTag ?? ""}|${plan.gutter ?? ""}|${plan.metaHidden ? 1 : 0}`;
  }
  if (plan.kind === "notification") return `n${plan.open ? 1 : 0}${plan.toggleable ? 1 : 0}`;
  return `r${plan.header ?? ""}`;
}

function planGroups(
  messages: readonly Message[],
  start: number,
  turns: readonly number[],
  style: Exclude<FoldStyle, "rows">,
  expanded: WeakSet<object>,
  plans: MessagePlan[],
  signatures: string[],
): void {
  const set = (index: number, plan: MessagePlan) => {
    plans[index - start] = plan;
    signatures[index - start] = planSignature(plan);
  };
  const all: GroupTurn[] = [];
  for (let at = 0; at < turns.length; at += 2) {
    const from = turns[at];
    const to = turns[at + 1];
    const msg = messages[from];
    const head = msg.role !== "user" ? "none" : plans[from - start]?.kind === "notification" ? "notification" : "owner";
    all.push({ from, to, head, shape: turnShape(messages, from, to, plans, start) });
  }
  const assistants = (member: GroupTurn) => {
    const out: number[] = [];
    for (let index = member.from; index < member.to; index++) if (messages[index].role === "assistant") out.push(index);
    return out;
  };
  /** Open: render the group like Ctrl+O (every notification and all work). */
  const openMembers = (members: readonly GroupTurn[]) => {
    for (const member of members) {
      for (let index = member.from; index < member.to; index++) {
        const plan = plans[index - start];
        if (plan?.kind === "notification") set(index, { ...plan, open: true, toggleable: false });
        else if (plan?.kind === "assistant") set(index, { ...plan, hidden: null, summary: null });
      }
    }
  };
  /** The first message a group line can sit on: the notification, or the owner turn's first answer. */
  const lineHost = (member: GroupTurn) => member.head === "notification" ? member.from : assistants(member)[0];

  if (style === "episode") {
    let episode: GroupTurn[] = [];
    const flush = () => {
      const members = episode.filter(member => !member.shape.blocking);
      episode = [];
      const { notifications, tools } = groupSummary(members);
      if (members.length === 0 || (notifications === 0 && tools === 0)) return;
      const toggle = groupKey(messages[members[0].from]);
      const open = expanded.has(toggle);
      const parts = [notifications ? plural(notifications, "background turn") : null, tools ? plural(tools, "tool call") : null].filter(Boolean);
      const text = `${open ? "▾" : "▸"} ${parts.join(" · ")}`;
      const host = lineHost(members[0]);
      if (host === undefined) return;
      if (open) openMembers(members);
      const replies = members.filter(member => member.shape.reply);
      const lastReply = replies[replies.length - 1];
      if (!open) {
        for (const member of members) {
          const list = assistants(member);
          if (member.head === "notification") set(member.from, { kind: "group", role: member.shape.reply ? "spacer" : "hidden", text: null, toggle });
          for (const index of list) {
            const plan = plans[index - start];
            if (!member.shape.reply) set(index, { kind: "group", role: "hidden", text: null, toggle });
            else if (plan?.kind === "assistant") set(index, { ...plan, hidden: plan.hidden ?? null, summary: null, metaHidden: member !== lastReply, groupToggle: toggle });
          }
        }
      }
      // The line goes first: on the first notification, or under the owner's prompt.
      // The host still renders after its line unless the closed group hides it.
      const current = plans[host - start];
      const inner = current && !(current.kind === "group" && current.role === "hidden") ? current : null;
      set(host, { kind: "group", role: "line", text, toggle, ...(inner ? { inner } : {}) });
    };
    for (const turn of all) {
      if (turn.head !== "notification") flush();
      episode.push(turn);
    }
    flush();
    return;
  }

  // inline (A) and gutter (C): what folded since the last reply goes with the next reply.
  let pending: GroupTurn[] = [];
  const apply = (members: GroupTurn[], anchored: boolean) => {
    const { notifications, tools, source } = groupSummary(members);
    if (members.length === 0 || (notifications === 0 && tools === 0)) return;
    const toggle = groupKey(messages[members[0].from]);
    const open = expanded.has(toggle);
    const arrow = open ? "▾" : "▸";
    const who = notifications === 1 ? `↳ ${source}` : notifications > 1 ? `↳ ${plural(notifications, "background turn")}` : null;
    const work = tools ? plural(tools, "tool") : null;
    const summary = [who, work].filter(Boolean).join(" · ");
    if (open) openMembers(members);
    if (!anchored) {
      // Nothing answered after them: one dim line.
      const host = lineHost(members[0]);
      if (host === undefined) return;
      if (!open) {
        for (const member of members) {
          if (member.head === "notification") set(member.from, { kind: "group", role: "hidden", text: null, toggle });
          for (const index of assistants(member)) set(index, { kind: "group", role: "hidden", text: null, toggle });
        }
      }
      const inner = open ? plans[host - start] : null;
      set(host, { kind: "group", role: "line", text: `${arrow} ${summary}`, toggle, ...(inner ? { inner } : {}) });
      return;
    }
    const reply = members[members.length - 1];
    if (!open) {
      for (const member of members) {
        if (member.head === "notification") set(member.from, { kind: "group", role: member === reply ? "spacer" : "hidden", text: null, toggle });
        if (member === reply) continue;
        for (const index of assistants(member)) set(index, { kind: "group", role: "hidden", text: null, toggle });
      }
    }
    const list = assistants(reply);
    // Style A tags the metadata line (the turn's last answer); C marks the reply's first row.
    let target = list[list.length - 1];
    if (style === "gutter") {
      target = list.find(index => {
        const plan = plans[index - start];
        const msg = messages[index];
        return msg.role === "assistant" && msg.blocks.some((block, blockIndex) => hasText(block) && !(plan?.kind === "assistant" && plan.hidden?.[blockIndex]));
      }) ?? target;
    }
    for (const index of list) {
      const plan = plans[index - start];
      if (plan?.kind !== "assistant") continue;
      const mark = index === target
        ? style === "inline" ? { metaTag: `${summary} ${arrow}` } : { gutter: arrow }
        : {};
      set(index, { ...plan, summary: null, groupToggle: toggle, ...mark });
    }
  };
  for (const turn of all) {
    if (turn.head !== "notification") {
      apply(pending, false);
      pending = [];
      if (turn.shape.reply) apply([turn], true);
      else apply([turn], false);
      continue;
    }
    if (turn.shape.blocking || turn.to - turn.from === 1) {
      apply(pending, false);
      pending = [];
      continue;
    }
    pending.push(turn);
    if (turn.shape.reply) {
      apply(pending, true);
      pending = [];
    }
  }
  apply(pending, false);
}
