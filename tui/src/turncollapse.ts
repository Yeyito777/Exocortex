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
  /** A folded turn with no reply drops its model/tokens/time line. */
  metaHidden?: boolean;
  /** Gutter style: a dim mark in the left gutter of this message's first row; it opens what folded before it. */
  gutter?: GutterMark;
  /** Gutter style: the fold group whose hidden blocks this message holds (search opens it). */
  groupToggle?: object;
}

/** `▸` (folded) or `▾` (open), and the fold group it toggles. */
export interface GutterMark {
  mark: string;
  toggle: object;
}

/**
 * Gutter style: a message folded into a group (a notification, a turn with no
 * reply), or the message hosting the group's mark on a row of its own.
 */
export interface GapPlan {
  kind: "gap";
  toggle: object;
  /** A row of its own carrying the mark, before the message (when it renders). */
  line: GutterMark | null;
  /** A blank row before the reply the group's hidden notification preceded. */
  spacer: boolean;
  /** How the message renders while the group is open; null renders nothing. */
  inner: MessagePlan;
}

/** Gutter style: a prompt bubble whose top or bottom margin row carries a group's mark. */
export interface PromptPlan {
  kind: "prompt";
  /** `from <title>` for a prompt another conversation sent. */
  from: string | null;
  above: GutterMark | null;
  below: GutterMark | null;
}

/**
 * A notification that started a turn: it has no row of its own, its label
 * leads the turn's work row (`▸ Subagent completion · 2 tool calls`), and it
 * shows in full when that row is opened.
 */
export interface MergedPlan {
  kind: "merged";
  label: string;
  /** The turn whose work row it joined. */
  toggle: object;
  /** An opened background run starts here: its `▾ …` row. */
  runHeader?: string;
  runToggle?: object;
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
  /** An opened turn's `▾ …` row: it leads the turn, so it sits above the turn's first notification. */
  turnRow?: string;
  turnToggle?: object;
  /** Gutter style: an opened group's mark, on this notification's first row (the top of what opened). */
  gutter?: GutterMark;
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

/** A prompt another conversation sent (an exo delegation or follow-up): a normal bubble, labelled with its sender. */
export interface FromPlan {
  kind: "from";
  label: string;
}

export type MessagePlan = AssistantPlan | NotificationPlan | RunPlan | MergedPlan | FromPlan | GapPlan | PromptPlan | null;

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
  /** Title of a conversation by id, for prompts other conversations sent. */
  conversationTitle?: (id: string) => string | null;
  /** How folded history looks: gutter marks (default) or rows (tui.foldStyle "rows"). */
  style?: FoldStyle;
  /** A message whose turn stays in view (an active durable sleep's clock keeps running). */
  active?: object | null;
  /** Gutter style: draw the faint marks (tui.foldMarks); off, folded history leaves no trace but search still opens it. */
  marks?: boolean;
}

export type FoldStyle = "gutter" | "rows";

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
    const automation = msg.metadata?.automation;
    if (automation?.kind === "exo_send") {
      const title = automation.sourceId ? input.conversationTitle?.(automation.sourceId) : null;
      const label = `from ${title || "another conversation"}`;
      plans[index - start] = { kind: "from", label };
      signatures[index - start] = `f${label}`;
      continue;
    }
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
  // Notifications delivered while another turn ran have no answer of their own
  // (the next message is another prompt): they join the next turn's work row.
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
    // new round starts streaming (or a client joins mid-turn), the last committed.
    const pendingLatest = inProgress ? latestStep(pendingAI!.blocks) : -1;
    let reveal: StepRef | null = null;
    for (let at = index - 1; inProgress && pendingLatest < 0 && at >= turnStart && !reveal; at--) {
      const msg = messages[at];
      const block = msg.role === "assistant" ? latestStep(msg.blocks) : -1;
      if (block >= 0) reveal = { message: at, block };
    }
    const turn = planTurn(messages, start, turnStart, index, inProgress, reveal, expanded, plans, signatures, orphanLabels);
    if (turn.absorbed) {
      for (let at = orphanStart; at < turnStart; at++) {
        const orphan = plans[at - start] as NotificationPlan;
        const lead = at === orphanStart ? turn.leadRow : null;
        const plan: MessagePlan = turn.open
          ? { kind: "notification", label: orphan.label, open: true, toggleable: false, ...(lead ? { turnRow: lead, turnToggle: turn.key } : {}) }
          : { kind: "merged", label: orphan.label, toggle: turn.key };
        plans[at - start] = plan;
        signatures[at - start] = turn.open ? `n10${lead ? `|T${lead}` : ""}` : `m${orphan.label}`;
      }
    }
    const from = turn.absorbed && orphanStart >= 0 ? orphanStart : turnStart;
    if (inProgress) pending = planPending(messages, turnStart, index, pendingAI!, pendingLatest, reveal, expanded, turn.label);
    else if (from < index) turns.push(from, index);
    orphanStart = -1;
    orphanLabels.length = 0;
    turnStart = index;
  }
  if (input.style === "rows") planRuns(messages, start, turns, expanded, plans, signatures);
  else planGutter(messages, start, pendingContinues ? liveTurnStart(messages, start) : count, expanded, plans, signatures, input.active ?? null, input.marks !== false);
  return { collapse, messages: plans, signatures, pending };
}

/** Where the live turn starts: its prompt (the last user message), or the window's start. */
function liveTurnStart(messages: readonly Message[], start: number): number {
  for (let index = messages.length - 1; index > start; index--) {
    if (messages[index].role === "user") return index;
  }
  return start;
}

// ── Gutter style ────────────────────────────────────────────────────

interface GutterSegment {
  from: number;
  to: number;
  /** owner: a prompt (typed, relayed or from another conversation); note: a notification; none: the window opens mid-turn. */
  head: "owner" | "note" | "none";
  /** Shows text (or attached images) after its folded work. */
  reply: boolean;
  /** Folds something worth a mark: a notification, tool calls or interim text. */
  folded: boolean;
  /** First assistant message showing reply content (the mark's row). */
  host: number;
}

const groupTokens = new WeakMap<object, object>();

function groupKey(head: object): object {
  let token = groupTokens.get(head);
  if (!token) groupTokens.set(head, token = {});
  return token;
}

function gutterSegment(messages: readonly Message[], start: number, from: number, to: number, plans: readonly MessagePlan[], active: object | null): GutterSegment {
  const first = messages[from];
  const headPlan = plans[from - start];
  const head = first.role !== "user" ? "none"
    : headPlan?.kind === "notification" || headPlan?.kind === "merged" ? "note" : "owner";
  let reply = false;
  let folded = head === "note";
  let host = -1;
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") continue;
    const plan = plans[index - start];
    const hidden = plan?.kind === "assistant" ? plan.hidden : null;
    let shows = false;
    msg.blocks.forEach((block, blockIndex) => {
      if (hidden?.[blockIndex]) {
        if (block.type === "tool_call" || hasText(block)) folded = true;
      } else if (hasText(block) || (block.type === "tool_result" && block.images?.length)) {
        shows = true;
      }
    });
    if (shows || msg === active) {
      reply = true;
      if (host < 0) host = index;
    }
  }
  return { from, to, head, reply, folded, host };
}

/**
 * Gutter style: a stretch of folded history (notifications, turns with no
 * reply, a reply's tool calls) leaves no row; a dim mark in the left gutter of
 * the next reply's first row (or, with no reply to carry it, of a blank row
 * where the stretch was) opens it. The transcript reads like a plain chat.
 */
function planGutter(
  messages: readonly Message[],
  start: number,
  liveFrom: number,
  expanded: WeakSet<object>,
  plans: MessagePlan[],
  signatures: string[],
  active: object | null,
  marks: boolean,
): void {
  const memo = gutterMemos.get(messages);
  if (memo && gutterMemoValid(memo, messages, start, liveFrom, active, marks, expanded, plans, signatures)) {
    for (let index = start; index < liveFrom; index++) {
      plans[index - start] = memo.outPlans[index - start];
      signatures[index - start] = memo.outSignatures[index - start];
    }
    return;
  }
  const inPlans = plans.slice(0, liveFrom - start);
  const inSignatures = signatures.slice(0, liveFrom - start);
  const groups: Array<{ toggle: object; open: boolean }> = [];
  planGutterFresh(messages, start, liveFrom, expanded, plans, signatures, active, marks, groups);
  gutterMemos.set(messages, {
    start, liveFrom, active, marks, groups,
    messages: messages.slice(start, liveFrom),
    inPlans, inSignatures,
    outPlans: plans.slice(0, liveFrom - start),
    outSignatures: signatures.slice(0, liveFrom - start),
  });
}

/**
 * The last gutter plan of a message list, reused while its inputs hold: every
 * streaming frame plans the whole loaded history, so without it long
 * conversations re-derived and re-allocated every group per frame.
 */
interface GutterMemo {
  start: number;
  liveFrom: number;
  active: object | null;
  marks: boolean;
  groups: Array<{ toggle: object; open: boolean }>;
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
  marks: boolean,
  expanded: WeakSet<object>,
  plans: readonly MessagePlan[],
  signatures: readonly string[],
): boolean {
  if (memo.start !== start || memo.liveFrom !== liveFrom || memo.active !== active || memo.marks !== marks) return false;
  for (const group of memo.groups) if (expanded.has(group.toggle) !== group.open) return false;
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
  expanded: WeakSet<object>,
  plans: MessagePlan[],
  signatures: string[],
  active: object | null,
  marks: boolean,
  groups: Array<{ toggle: object; open: boolean }>,
): void {
  const set = (index: number, plan: MessagePlan) => {
    plans[index - start] = plan;
    signatures[index - start] = gutterSignature(plan);
  };
  const prompt = (index: number): PromptPlan => {
    const plan = plans[index - start];
    if (plan?.kind === "prompt") return plan;
    return { kind: "prompt", from: plan?.kind === "from" ? plan.label : null, above: null, below: null };
  };
  /** A member as the opened group shows it (like Ctrl+O), or folded away. */
  const member = (segment: GutterSegment, toggle: object, open: boolean, keep: boolean, spacer = keep) => {
    for (let index = segment.from; index < segment.to; index++) {
      const msg = messages[index];
      const plan = plans[index - start];
      if (msg.role === "user" && segment.head === "note" && index === segment.from) {
        const label = plan?.kind === "notification" || plan?.kind === "merged" ? plan.label : "Notification";
        set(index, open
          ? { kind: "notification", label, open: true, toggleable: false }
          : { kind: "gap", toggle, line: null, spacer: keep && spacer, inner: null });
      } else if (msg.role === "user" && (plan?.kind === "notification" || plan?.kind === "merged")) {
        // A notification delivered mid-turn folds with its turn.
        set(index, open ? { kind: "notification", label: plan.label, open: true, toggleable: false } : { kind: "gap", toggle, line: null, spacer: false, inner: null });
      } else if (msg.role === "assistant" && plan?.kind === "assistant") {
        if (open) set(index, { kind: "assistant", hidden: null, summary: null, toggle: plan.toggle });
        else if (keep) set(index, { ...plan, summary: null, groupToggle: toggle });
        else set(index, { kind: "gap", toggle, line: null, spacer: false, inner: null });
      }
    }
  };

  /** A reply carries the mark: everything folded before it, and its own work. */
  const anchored = (members: readonly GutterSegment[]) => {
    if (!members.some(segment => segment.folded)) return;
    const reply = members[members.length - 1];
    const toggle = groupKey(messages[members[0].from]);
    const open = expanded.has(toggle);
    groups.push({ toggle, open });
    // A prompt's bubble already leaves a blank row above the reply its turn led to.
    const afterPrompt = members[0].head === "owner";
    for (const segment of members) member(segment, toggle, open, segment === reply, !afterPrompt);
    const mark: GutterMark = { mark: !marks ? "" : open ? "▾" : "▸", toggle };
    // Opened, the mark leads what opened: the first row of the stretch's first
    // folded message, so everything it opened reads below it in order.
    const top = open ? openedTop(members) : -1;
    const plan = plans[top - start];
    if (plan?.kind === "notification") set(top, { ...plan, gutter: mark });
    else if (plan?.kind === "assistant" && top !== reply.host) set(top, { ...plan, gutter: mark });
    const host = plans[reply.host - start];
    if (host?.kind === "assistant") set(reply.host, { ...host, ...(top < 0 || top === reply.host ? { gutter: mark } : {}), groupToggle: toggle });
  };

  /** An opened group's first shown message: a notification, or a turn's first visible step (a prompt stays where it was). */
  const openedTop = (members: readonly GutterSegment[]): number => {
    for (const segment of members) {
      for (let index = segment.from; index < segment.to; index++) {
        const msg = messages[index];
        const plan = plans[index - start];
        if (msg.role === "user" && plan?.kind === "notification") return index;
        if (msg.role === "assistant" && msg.blocks.some(block => block.type !== "thinking")) return index;
      }
    }
    return -1;
  };

  /** Nothing answered after them: the mark gets a row of its own where they were. */
  const unanchored = (members: readonly GutterSegment[], nextPrompt: number | null) => {
    if (!members.some(segment => segment.folded)) return;
    const toggle = groupKey(messages[members[0].from]);
    const open = expanded.has(toggle);
    groups.push({ toggle, open });
    for (const segment of members) member(segment, toggle, open, false);
    const mark: GutterMark = { mark: !marks ? "" : open ? "▾" : "▸", toggle };
    const first = members[0];
    if (first.head === "owner") {
      // A prompt that only got tool calls: the row below its bubble.
      set(first.from, { ...prompt(first.from), below: mark });
    } else if (first.head === "note" && nextPrompt !== null && !open) {
      // Right before the next prompt: the row above its bubble.
      set(nextPrompt, { ...prompt(nextPrompt), above: mark });
    } else if (marks || open) {
      const plan = plans[first.from - start];
      set(first.from, { kind: "gap", toggle, line: mark, spacer: false, inner: plan?.kind === "gap" ? null : plan });
    }
  };

  let stretch: GutterSegment[] = [];
  let from = start;
  for (let index = start + 1; index <= liveFrom; index++) {
    if (index < liveFrom && messages[index].role !== "user") continue;
    if (from >= index) continue;
    const segment = gutterSegment(messages, start, from, index, plans, active);
    from = index;
    if (segment.head === "owner") {
      unanchored(stretch, segment.from);
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
  unanchored(stretch, null);
}

function gutterSignature(plan: MessagePlan): string {
  if (!plan) return "";
  switch (plan.kind) {
    case "gap":
      return `g${plan.line?.mark ?? ""}|${plan.spacer ? 1 : 0}|${gutterSignature(plan.inner)}`;
    case "prompt":
      return `p${plan.from ?? ""}|${plan.above?.mark ?? ""}|${plan.below?.mark ?? ""}`;
    case "assistant":
      return `a${plan.summary ?? ""}|${plan.hidden ? plan.hidden.map(value => value ? 1 : 0).join("") : "*"}|${plan.metaHidden ? 1 : 0}|${plan.gutter?.mark ?? ""}`;
    case "notification":
      return `n${plan.open ? 1 : 0}${plan.toggleable ? 1 : 0}|${plan.gutter?.mark ?? ""}`;
    case "from":
      return `f${plan.label}`;
    case "merged":
      return `m${plan.label}`;
    case "run":
      return `r${plan.header ?? ""}`;
  }
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
  const label = head?.kind === "notification" || head?.kind === "merged" ? head.label : null;
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
      // Notifications delivered while it ran join it; a prompt or a notice does not.
      if (!(msg.role === "user" && notificationLabel(msg) !== null)) blocking = true;
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
    // One silent turn is already one row (its work row, without metadata).
    if (run.length + (closer ? 1 : 0) >= 2) applyRun(messages, start, run, closer, expanded, plans, signatures);
    run = [];
  };
  for (let at = 0; at < turns.length; at += 2) {
    const from = turns[at];
    const to = turns[at + 1];
    // Prompts the user typed (most turns) cannot be in a run: skip the shape walk. A
    // notification nothing answered (yet) is news, not background work: it stays a row.
    const kind = plans[from - start]?.kind;
    if ((kind !== "notification" && kind !== "merged") || to - from === 1) {
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
  const header = `${open ? "▾" : "▸"} ${members.length} background turns${work}`;

  if (open) {
    const plan = plans[first.from - start] as NotificationPlan | MergedPlan;
    plans[first.from - start] = { ...plan, runHeader: header, runToggle: toggle };
    signatures[first.from - start] += `|R${header}`;
    return;
  }
  const gap = closer !== null;
  const label = null;
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
  for (let index = closer.from; index < closer.to; index++) {
    // Its notifications (and any delivered before it) fold into the run's row.
    if (messages[index].role === "user") {
      plans[index - start] = memo.rest;
      signatures[index - start] = "r";
      continue;
    }
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
  /** Labels of notifications before the turn that nothing answered on its own. */
  orphanLabels: readonly string[],
): { key: object; open: boolean; absorbed: boolean; label: string | null; leadRow: string | null } {
  if (from >= to) return { key: {}, open: false, absorbed: false, label: null, leadRow: null };
  const key = turnKey(messages, from, messages[from]);
  const open = expanded.has(key);
  const memo = turnMemos.get(key);
  const headPlan = plans[from - start];
  const label = headPlan?.kind === "notification" ? headPlan.label : null;
  const orphans = orphanLabels.join("\n");
  if (memo && memo.label === label && memo.orphans === orphans && turnMemoValid(memo, messages, from, to, inProgress, reveal, open)) {
    for (let index = from; index < to; index++) {
      if (messages[index].role !== "assistant" && !(index === from && memo.merged)) continue;
      plans[index - start] = memo.plans[index - from];
      signatures[index - start] = memo.signatures[index - from];
    }
    return { key, open, absorbed: memo.absorbed, label: memo.rowLabel, leadRow: memo.leadRow };
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

  // A notification that started the turn joins its work row (the working row
  // while it runs); one nothing answered yet keeps its own row.
  let firstAssistant = -1;
  let reply = false;
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") continue;
    if (firstAssistant < 0) firstAssistant = index;
    const hidden = hiddenByMessage[index - from]!;
    if (msg.blocks.some((block, blockIndex) => hasText(block) && !hidden[blockIndex])) reply = true;
  }
  const answered = firstAssistant >= 0 || inProgress;
  const merged = label !== null && answered;
  const absorbed = orphanLabels.length > 0 && answered;
  const rowLabel = combineLabels([...(absorbed ? orphanLabels : []), ...(merged ? [label!] : [])]);
  if (rowLabel && host < 0) host = firstAssistant;
  const summaryText = [rowLabel, workSummaryText(stats)].filter(Boolean).join(" · ");
  // Opened, the row leads what it opened: above the turn's first notification
  // (one delivered before the turn, else its own), never below them.
  const lead = open && !inProgress && rowLabel !== null && summaryText ? `▾ ${summaryText}` : null;
  if (merged) {
    const turnRow = lead && !absorbed ? { turnRow: lead, turnToggle: key } : {};
    const plan: MessagePlan = open ? { kind: "notification", label, open: true, toggleable: false, ...turnRow } : { kind: "merged", label, toggle: key };
    plans[from - start] = plan;
    signatures[from - start] = open ? `n10${lead && !absorbed ? `|T${lead}` : ""}` : `m${label}`;
  }
  // A folded turn with nothing to read drops its metadata line.
  const metaHidden = !open && !inProgress && !reply;
  for (let index = from; index < to; index++) {
    const msg = messages[index];
    if (msg.role !== "assistant") continue;
    const hidden = open ? null : hiddenByMessage[index - from];
    // An in-progress turn's summary is its working row under the pending blocks.
    const summary = !inProgress && !lead && index === host && summaryText ? `${open ? "▾" : "▸"} ${summaryText}` : null;
    plans[index - start] = { kind: "assistant", hidden, summary, toggle: key, ...(metaHidden ? { metaHidden } : {}) };
    signatures[index - start] = `a${summary ?? ""}|${hidden ? hidden.map(value => value ? 1 : 0).join("") : "*"}|${metaHidden ? 1 : 0}`;
  }
  turnMemos.set(key, {
    label,
    merged,
    orphans,
    absorbed,
    rowLabel,
    leadRow: lead && absorbed ? lead : null,
    messages: messages.slice(from, to),
    blockCodes: messages.slice(from, to).map(msg => msg.role === "assistant" ? msg.blocks.map(blockCode) : null),
    inProgress,
    reveal: reveal ? { message: reveal.message - from, block: reveal.block } : null,
    open,
    plans: plans.slice(from - start, to - start),
    signatures: signatures.slice(from - start, to - start),
  });
  return { key, open, absorbed, label: rowLabel, leadRow: lead && absorbed ? lead : null };
}

/** `Subagent completion`, `Chrono ×2`, or `3 notifications`. */
function combineLabels(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.every(label => label === labels[0])) return labels.length === 1 ? labels[0] : `${labels[0]} ×${labels.length}`;
  return `${labels.length} notifications`;
}

/**
 * A finished turn's plan, reused while nothing it was planned from changed.
 * Every streaming frame plans the whole loaded history; without this, long
 * conversations re-derived (and re-allocated) thousands of plans per frame.
 */
interface TurnMemo {
  /** The label of the notification that started the turn, and whether it joined the work row. */
  label: string | null;
  merged: boolean;
  /** Labels of unanswered notifications before the turn, whether they joined it, and the row's label. */
  orphans: string;
  absorbed: boolean;
  rowLabel: string | null;
  /** The opened turn's row, for the first absorbed notification to carry. */
  leadRow: string | null;
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
  /** The notification that started the turn leads its working row. */
  label: string | null,
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
  const summary = [label, workSummaryText(stats)].filter(Boolean).join(" · ");
  return { hidden: open ? null : hidden, summary: summary || null, expanded: open, toggle: key };
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
    if (messagePlan.kind === "gap") {
      if (!messagePlan.inner) {
        if (msg.role === "user") add(messagePlan.toggle, msg.text);
        else if (msg.role === "assistant") addBlocks(messagePlan.toggle, msg.blocks, msg.blocks.map(() => true));
      }
    } else if (messagePlan.kind === "assistant" && messagePlan.groupToggle && messagePlan.hidden && msg.role === "assistant") {
      addBlocks(messagePlan.groupToggle, msg.blocks, messagePlan.hidden);
    } else if (messagePlan.kind === "merged") {
      if (msg.role === "user") add(messagePlan.runToggle ?? messagePlan.toggle, msg.text);
    } else if (messagePlan.kind === "run") {
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
