/**
 * Turn folding and notification identity for the history view.
 *
 * Folded (the default), the history reads like a plain chat: the user's
 * messages and the agent's final replies with their metadata. Everything else
 * leaves no row: a turn's thinking, tool calls and interim text, notifications,
 * background turns with no reply, and informational notices. Ctrl+O shows all of
 * it and Ctrl+I the detail view; nothing opens on its own. The in-progress turn
 * shows only its latest step under a Working row.
 *
 * planHistory is a cheap pass over block types only. Its per-message signatures
 * let the committed-row cache in conversation.ts rebuild exactly the messages
 * whose plan changed (a turn finishing, a reply arriving), not the whole history.
 */

import { isAutomatedUserPrompt, isInformationalNotice, ownerRelayedText, type AIMessage, type Block, type Message, type UserMessage, type UserMessageAutomation } from "./messages";
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

/**
 * Whether a user-role message carries the owner's own words: typed, or relayed
 * from their Discord/WhatsApp. Only these get the user bubble's background;
 * everything automated (a parent conversation's prompts included) gets the
 * automated one. Takes a queued message's `automation` as well as a message's.
 */
export function ownerWords(text: string, automation: UserMessageAutomation | undefined): boolean {
  return !automation || ownerRelayedText(text, { automation }) !== null;
}

/**
 * The line under a prompt another conversation sent (a parent's delegation or
 * follow-up, a child's `exo queue` report): `⚙ Exo delegation · from 📡
 * paramount`, by the sender's title, else its id.
 */
export function parentPromptLabel(automation: UserMessageAutomation, conversationTitle?: (id: string) => string | null): string {
  const title = automation.sourceId ? conversationTitle?.(automation.sourceId) || automation.sourceId : null;
  return `⚙ ${automationLabel(automation)} · from ${title ?? "another conversation"}`;
}

/** Label for a user-role message that was not typed by the user, or null for a real one. */
export function notificationLabel(msg: Pick<UserMessage, "text" | "metadata">): string | null {
  if (!isAutomatedUserPrompt(msg.text, msg.metadata) || ownerRelay(msg)) return null;
  // A parent conversation's delegation or follow-up is this conversation's prompt.
  if (msg.metadata?.automation?.kind === "exo_send") return null;
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

/** A user message's notification label, kept while its text and metadata are. */
interface NotificationMemo {
  text: string;
  metadata: UserMessage["metadata"];
  label: string | null;
  plan: NotificationPlan | null;
}

const notificationMemos = new WeakMap<object, NotificationMemo>();

function notificationMemo(msg: UserMessage): NotificationMemo {
  let memo = notificationMemos.get(msg);
  if (!memo || memo.text !== msg.text || memo.metadata !== msg.metadata) {
    const label = notificationLabel(msg);
    memo = { text: msg.text, metadata: msg.metadata, label, plan: label ? { kind: "notification", label } : null };
    notificationMemos.set(msg, memo);
  }
  return memo;
}

export interface AssistantPlan {
  kind: "assistant";
  /** Per block: true when the block folds away. */
  hidden: readonly boolean[] | null;
  /** A folded turn with no reply drops its model/tokens/time line. */
  metaHidden?: boolean;
}

/**
 * A message that folds away (a notification, a turn with no reply, an
 * informational notice): no rows, or only the blank row before the reply it led to.
 */
export interface HiddenPlan {
  kind: "hidden";
  spacer: boolean;
}

/** The notification that started the live turn: no row of its own; its label leads the Working row. */
export interface MergedPlan {
  kind: "merged";
}

/** A notification shown in full (Ctrl+O), on the assistant's side behind a muted gutter. */
export interface NotificationPlan {
  kind: "notification";
  label: string;
}

/**
 * A prompt another conversation sent (an exo delegation or follow-up): it reads
 * as this conversation's prompt, in the automated bubble, labelled with its sender.
 */
export interface FromPlan {
  kind: "from";
  label: string;
}

export type MessagePlan = AssistantPlan | HiddenPlan | MergedPlan | NotificationPlan | FromPlan | null;

export interface PendingPlan {
  /** Per pending block: true when folded behind the Working row. */
  hidden: readonly boolean[];
  /** The live turn's folded work (and the notification that started it), e.g. `Subagent completion · 7 tool calls`. */
  summary: string | null;
  /**
   * The newest step when it is already committed (a client joining mid-turn,
   * or a new round not streaming yet): it renders under the Working row, not in
   * the committed rows above it, so the row never sits below the latest command.
   */
  revealed: Block | null;
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
function workSummaryText(stats: WorkStats): string | null {
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
  /** Folded (the default); false under Ctrl+O and Ctrl+I. */
  collapse: boolean;
  /** Title of a conversation by id, for prompts other conversations sent. */
  conversationTitle?: (id: string) => string | null;
  /** A message whose turn stays in view (an active durable sleep's clock keeps running). */
  active?: object | null;
}

const NO_SIGNATURE = "";
const HIDDEN: HiddenPlan = { kind: "hidden", spacer: false };
const HIDDEN_SPACER: HiddenPlan = { kind: "hidden", spacer: true };
const MERGED: MergedPlan = { kind: "merged" };

/** An informational transcript notice: it folds with its turn's work. */
function isFoldedNotice(msg: Message | undefined): boolean {
  return msg?.role === "system" && isInformationalNotice(msg);
}

export function planHistory(input: PlanHistoryInput): HistoryPlan {
  const { messages, start, pendingAI, collapse } = input;
  const count = messages.length;
  const plans: MessagePlan[] = new Array(Math.max(0, count - start)).fill(null);
  const signatures: string[] = new Array(Math.max(0, count - start)).fill(NO_SIGNATURE);
  let pending: PendingPlan | null = null;

  for (let index = start; index < count; index++) {
    const msg = messages[index];
    if (msg.role !== "user") continue;
    const automation = msg.metadata?.automation;
    if (automation?.kind === "exo_send") {
      const label = parentPromptLabel(automation, input.conversationTitle);
      plans[index - start] = { kind: "from", label };
      signatures[index - start] = `f${label}`;
      continue;
    }
    const memo = notificationMemo(msg);
    if (!memo.plan) continue;
    plans[index - start] = memo.plan;
    signatures[index - start] = "n";
  }
  if (!collapse) return { collapse, messages: plans, signatures, pending };

  const pendingContinues = pendingAI?.role === "assistant";
  let turnStart = start;
  // Notifications delivered while another turn ran have no answer of their own
  // (the next message is another prompt): they join the next turn.
  let orphanStart = -1;
  const orphanLabels: string[] = [];
  for (let index = start; index <= count; index++) {
    if (index < count && (index === start || messages[index].role !== "user")) continue;
    const inProgress = index === count && pendingContinues;
    const head = plans[turnStart - start];
    if (!inProgress && index < count && index - turnStart === 1 && head?.kind === "notification") {
      if (orphanStart < 0) orphanStart = turnStart;
      orphanLabels.push(head.label);
      turnStart = index;
      continue;
    }
    // The live turn keeps its newest step in view: the pending one, or until a
    // new round starts streaming (or a client joins mid-turn), the last committed,
    // from before any message delivered into the run.
    const pendingLatest = inProgress ? latestStep(pendingAI!.blocks) : -1;
    const runStart = inProgress ? liveRunStart(messages, start, turnStart, pendingAI!.metadata?.startedAt) : turnStart;
    const reveal = inProgress && pendingLatest < 0 ? latestCommittedStep(messages, runStart, turnStart, index) : null;
    const turn = planTurn(messages, start, turnStart, index, inProgress, reveal, plans, signatures, orphanLabels);
    if (turn.absorbed) {
      for (let at = orphanStart; at < turnStart; at++) {
        plans[at - start] = MERGED;
        signatures[at - start] = "m";
      }
    }
    if (inProgress) pending = planPending(messages, start, runStart, index, plans, pendingAI!, pendingLatest, reveal, turn.label);
    orphanStart = -1;
    orphanLabels.length = 0;
    turnStart = index;
  }
  planGutter(messages, start, pendingContinues ? liveTurnStart(messages, start) : count, plans, signatures, input.active ?? null);
  return { collapse, messages: plans, signatures, pending };
}

/** Where the live turn starts: its prompt (the last user message), or the window's start. */
function liveTurnStart(messages: readonly Message[], start: number): number {
  for (let index = messages.length - 1; index > start; index--) {
    if (messages[index].role === "user") return index;
  }
  return start;
}

/**
 * A message delivered into the running turn (a next-turn or steering prompt, a
 * notification): queued, and stamped after the run started. A prompt that
 * started its own run (a message-end handoff) carries the run's start.
 */
function deliveredMidRun(msg: Message, runStartedAt: number | undefined): boolean {
  return msg.role === "user" && runStartedAt !== undefined && !!msg.metadata?.queueEntryId
    && (msg.metadata.startedAt ?? 0) > runStartedAt;
}

/** Where the running turn's work starts: its live turn, reaching back past messages delivered into it. */
function liveRunStart(messages: readonly Message[], start: number, turnStart: number, runStartedAt: number | undefined): number {
  let at = turnStart;
  while (at > start && deliveredMidRun(messages[at], runStartedAt)) {
    at--;
    while (at > start && messages[at].role !== "user") at--;
  }
  return at;
}

/**
 * The newest committed step of the running turn. One from before a delivered
 * message stays only while it is a command: text there is a reply, already in view.
 */
function latestCommittedStep(messages: readonly Message[], runStart: number, turnStart: number, to: number): StepRef | null {
  for (let at = to - 1; at >= runStart; at--) {
    const msg = messages[at];
    if (msg.role !== "assistant") continue;
    const block = latestStep(msg.blocks);
    if (block < 0) continue;
    return at >= turnStart || msg.blocks[block].type === "tool_call" ? { message: at, block } : null;
  }
  return null;
}

// ── Folded stretches ────────────────────────────────────────────────

interface GutterSegment {
  from: number;
  to: number;
  /** owner: a prompt (typed, relayed or from another conversation); note: a notification; none: the window opens mid-turn. */
  head: "owner" | "note" | "none";
  /** Shows text (or attached images) after its folded work. */
  reply: boolean;
  /** Folds something away: a notification, tool calls, interim text or a notice. */
  folded: boolean;
}

function gutterSegment(messages: readonly Message[], start: number, from: number, to: number, plans: readonly MessagePlan[], active: object | null): GutterSegment {
  const first = messages[from];
  const headPlan = plans[from - start];
  const head = first.role !== "user" ? "none"
    : headPlan?.kind === "notification" || headPlan?.kind === "merged" ? "note" : "owner";
  let reply = false;
  let folded = head === "note";
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (isFoldedNotice(msg)) folded = true;
    if (msg.role !== "assistant") continue;
    const plan = plans[index - start];
    const hidden = plan?.kind === "assistant" ? plan.hidden : null;
    msg.blocks.forEach((block, blockIndex) => {
      // Attached images show under their message even when its tool calls fold:
      // they keep the segment, so a message delivered into the turn after them
      // cannot fold them away with the work before it.
      if (block.type === "tool_result" && block.images?.length) reply = true;
      if (hidden?.[blockIndex]) {
        if (block.type === "tool_call" || hasText(block)) folded = true;
      } else if (hasText(block)) {
        reply = true;
      }
    });
    if (msg === active) reply = true;
  }
  return { from, to, head, reply, folded };
}

/**
 * A stretch of history between replies (notifications, turns with no reply, a
 * reply's tool calls, notices) leaves no row; the next reply follows the last
 * one as in a plain chat.
 */
function planGutter(
  messages: readonly Message[],
  start: number,
  liveFrom: number,
  plans: MessagePlan[],
  signatures: string[],
  active: object | null,
): void {
  const memo = gutterMemos.get(messages);
  if (memo && gutterMemoValid(memo, messages, start, liveFrom, active, plans, signatures)) {
    for (let index = start; index < liveFrom; index++) {
      plans[index - start] = memo.outPlans[index - start];
      signatures[index - start] = memo.outSignatures[index - start];
    }
    return;
  }
  const inPlans = plans.slice(0, liveFrom - start);
  const inSignatures = signatures.slice(0, liveFrom - start);
  planGutterFresh(messages, start, liveFrom, plans, signatures, active);
  gutterMemos.set(messages, {
    start, liveFrom, active,
    messages: messages.slice(start, liveFrom),
    inPlans, inSignatures,
    outPlans: plans.slice(0, liveFrom - start),
    outSignatures: signatures.slice(0, liveFrom - start),
  });
}

/**
 * The last folded plan of a message list, reused while its inputs hold: every
 * streaming frame plans the whole loaded history, so without it long
 * conversations re-derived and re-allocated every stretch per frame.
 */
interface GutterMemo {
  start: number;
  liveFrom: number;
  active: object | null;
  messages: Message[];
  inPlans: MessagePlan[];
  inSignatures: string[];
  outPlans: MessagePlan[];
  outSignatures: string[];
}

const gutterMemos = new WeakMap<object, GutterMemo>();

function gutterMemoValid(
  memo: GutterMemo,
  messages: readonly Message[],
  start: number,
  liveFrom: number,
  active: object | null,
  plans: readonly MessagePlan[],
  signatures: readonly string[],
): boolean {
  if (memo.start !== start || memo.liveFrom !== liveFrom || memo.active !== active) return false;
  for (let index = start; index < liveFrom; index++) {
    const at = index - start;
    if (memo.messages[at] !== messages[index]) return false;
    // planTurn reuses its plan objects while a turn is unchanged; other plans compare by signature.
    if (memo.inPlans[at] !== plans[at] && (messages[index].role === "assistant" || memo.inSignatures[at] !== signatures[at])) return false;
  }
  return true;
}

function planGutterFresh(
  messages: readonly Message[],
  start: number,
  liveFrom: number,
  plans: MessagePlan[],
  signatures: string[],
  active: object | null,
): void {
  const set = (index: number, plan: MessagePlan) => {
    plans[index - start] = plan;
    signatures[index - start] = gutterSignature(plan);
  };
  /** Fold a segment's members away; the reply segment keeps its reply. */
  const fold = (segment: GutterSegment, keep: boolean, spacer = keep) => {
    for (let index = segment.from; index < segment.to; index++) {
      const msg = messages[index];
      const plan = plans[index - start];
      if (msg.role === "user" && segment.head === "note" && index === segment.from) {
        set(index, keep && spacer ? HIDDEN_SPACER : HIDDEN);
      } else if (msg.role === "user" && (plan?.kind === "notification" || plan?.kind === "merged")) {
        // A notification delivered mid-turn folds with its turn.
        set(index, HIDDEN);
      } else if (isFoldedNotice(msg)) {
        set(index, HIDDEN);
      } else if (msg.role === "assistant" && plan?.kind === "assistant" && !keep) {
        set(index, HIDDEN);
      }
    }
  };

  /** A reply ends the stretch: everything folded before it goes, and its own work. */
  const anchored = (members: readonly GutterSegment[]) => {
    if (!members.some(segment => segment.folded)) return;
    const reply = members[members.length - 1];
    // A prompt's bubble already leaves a blank row above the reply its turn led to.
    const afterPrompt = members[0].head === "owner";
    for (const segment of members) fold(segment, segment === reply, !afterPrompt);
  };
  /** Nothing answered after them: they go without a trace. */
  const unanchored = (members: readonly GutterSegment[]) => {
    for (const segment of members) if (segment.folded) fold(segment, false);
  };

  let stretch: GutterSegment[] = [];
  let from = start;
  for (let index = start + 1; index <= liveFrom; index++) {
    if (index < liveFrom && messages[index].role !== "user") continue;
    if (from >= index) continue;
    const segment = gutterSegment(messages, start, from, index, plans, active);
    from = index;
    if (segment.head === "owner") {
      unanchored(stretch);
      stretch = [];
      if (segment.reply) anchored([segment]);
      else if (segment.folded) stretch.push(segment);
      continue;
    }
    stretch.push(segment);
    if (segment.reply) {
      anchored(stretch);
      stretch = [];
    }
  }
  unanchored(stretch);
}

function gutterSignature(plan: MessagePlan): string {
  if (!plan) return "";
  switch (plan.kind) {
    case "hidden":
      return `h${plan.spacer ? 1 : 0}`;
    case "assistant":
      return `a${plan.hidden ? plan.hidden.map(value => value ? 1 : 0).join("") : "*"}|${plan.metaHidden ? 1 : 0}`;
    case "notification":
      return "n";
    case "from":
      return `f${plan.label}`;
    case "merged":
      return "m";
  }
}

// ── Turns ───────────────────────────────────────────────────────────

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

/** A turn's memo identity: a token per opening message. */
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
  plans: MessagePlan[],
  signatures: string[],
  /** Labels of notifications before the turn that nothing answered on its own. */
  orphanLabels: readonly string[],
): { absorbed: boolean; label: string | null } {
  if (from >= to) return { absorbed: false, label: null };
  const key = turnKey(messages, from, messages[from]);
  const memo = turnMemos.get(key);
  const headPlan = plans[from - start];
  const label = headPlan?.kind === "notification" ? headPlan.label : null;
  const orphans = orphanLabels.join("\n");
  if (memo && memo.label === label && memo.orphans === orphans && turnMemoValid(memo, messages, from, to, inProgress, reveal)) {
    for (let index = from; index < to; index++) {
      const role = messages[index].role;
      if (role === "user" ? !(index === from && memo.merged) : role !== "assistant" && !isFoldedNotice(messages[index])) continue;
      plans[index - start] = memo.plans[index - from];
      signatures[index - start] = memo.signatures[index - from];
    }
    return { absorbed: memo.absorbed, label: memo.rowLabel };
  }

  // The final reply is the text after the last tool block; everything before
  // it is work. A turn still running has no final reply yet: all of it folds
  // (its newest step renders under the Working row).
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

  let firstAssistant = -1;
  let reply = false;
  const hiddenByMessage: Array<boolean[] | null> = [];
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") {
      hiddenByMessage.push(null);
      continue;
    }
    if (firstAssistant < 0) firstAssistant = index;
    const hidden = msg.blocks.map((block, blockIndex) => inProgress
      || index < lastToolMessage
      || (index === lastToolMessage && blockIndex <= lastToolBlock)
      || block.type === "thinking");
    if (msg.blocks.some((block, blockIndex) => hasText(block) && !hidden[blockIndex])) reply = true;
    hiddenByMessage.push(hidden);
  }
  // A folded turn with nothing to read drops its metadata line.
  const metaHidden = !inProgress && !reply;
  for (let index = from; index < to; index++) {
    const hidden = hiddenByMessage[index - from];
    if (!hidden) continue;
    plans[index - start] = { kind: "assistant", hidden, ...(metaHidden ? { metaHidden } : {}) };
    signatures[index - start] = `a${hidden.map(value => value ? 1 : 0).join("")}|${metaHidden ? 1 : 0}`;
  }

  // A notification that started the turn leads its Working row; one nothing answered yet folds on its own.
  const answered = firstAssistant >= 0 || inProgress;
  const merged = label !== null && answered;
  if (merged) {
    plans[from - start] = MERGED;
    signatures[from - start] = "m";
  }
  const absorbed = orphanLabels.length > 0 && answered;
  const rowLabel = combineLabels([...(absorbed ? orphanLabels : []), ...(merged ? [label!] : [])]);
  // Informational notices (a daemon restart, a retry…) fold with the turn's work.
  for (let index = from; index < to; index++) {
    if (!isFoldedNotice(messages[index])) continue;
    plans[index - start] = HIDDEN;
    signatures[index - start] = "h0";
  }
  turnMemos.set(key, {
    label,
    merged,
    orphans,
    absorbed,
    rowLabel,
    messages: messages.slice(from, to),
    blockCodes: messages.slice(from, to).map(msg => msg.role === "assistant" ? msg.blocks.map(blockCode) : null),
    inProgress,
    reveal: reveal ? { message: reveal.message - from, block: reveal.block } : null,
    plans: plans.slice(from - start, to - start),
    signatures: signatures.slice(from - start, to - start),
  });
  return { absorbed, label: rowLabel };
}

/** `Subagent completion`, `Chrono ×2`, or `3 notifications`. */
function combineLabels(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.every(label => label === labels[0])) return labels.length === 1 ? labels[0] : `${labels[0]} ×${labels.length}`;
  return `${labels.length} notifications`;
}

interface TurnMemo {
  /** The label of the notification that started the turn, and whether it leads the turn. */
  label: string | null;
  merged: boolean;
  /** Labels of unanswered notifications before the turn, whether they joined it, and the Working row's label. */
  orphans: string;
  absorbed: boolean;
  rowLabel: string | null;
  messages: Message[];
  /** blockCode of every block of each assistant message. */
  blockCodes: Array<number[] | null>;
  inProgress: boolean;
  /** Relative to the turn's first message. */
  reveal: StepRef | null;
  plans: MessagePlan[];
  signatures: string[];
}

/** Last plan of each turn, keyed by turnKey: unchanged turns skip planning. */
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
): boolean {
  if (memo.messages.length !== to - from || memo.inProgress !== inProgress) return false;
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
  start: number,
  from: number,
  to: number,
  plans: readonly MessagePlan[],
  pendingAI: AIMessage,
  latest: number,
  reveal: StepRef | null,
  /** The notification that started the turn leads its Working row. */
  label: string | null,
): PendingPlan {
  const stats: WorkStats = { toolCalls: 0, texts: 0 };
  // The whole run's folded work: a message delivered into it does not reset the count.
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    const plan = plans[index - start];
    if (msg.role !== "assistant" || plan?.kind !== "assistant") continue;
    msg.blocks.forEach((block, blockIndex) => {
      if (!plan.hidden?.[blockIndex] || (reveal?.message === index && reveal.block === blockIndex)) return;
      if (block.type === "tool_call") stats.toolCalls++;
      else if (hasText(block)) stats.texts++;
    });
  }
  const hidden = pendingAI.blocks.map((block, index) => {
    const isHidden = index !== latest;
    if (isHidden) {
      if (block.type === "tool_call") stats.toolCalls++;
      else if (hasText(block)) stats.texts++;
    }
    return isHidden;
  });
  const summary = [label, workSummaryText(stats)].filter(Boolean).join(" · ");
  const revealed = reveal ? (messages[reveal.message] as Extract<Message, { role: "assistant" }>).blocks[reveal.block] ?? null : null;
  return { hidden, summary: summary || null, revealed };
}
