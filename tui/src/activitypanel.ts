/**
 * Focused-conversation activity cards.
 *
 * The Tasks card renders the current goal, active subagents, detached
 * background commands and displayable Chrono work; the Subscriptions card
 * below it renders durable external notification subscriptions. The daemon
 * supplies conversation summaries; this module adds the durable goal and owns
 * all visual formatting and horizontal space reservation for both cards.
 *
 * Collapsed, every entry is one compact row and the card is capped in height,
 * its last row counting the entries left out. When it leaves out an entry or
 * part of a title, a click toggles an expanded form that lists every entry,
 * grows leftward (keeping its right edge) as far as its longest title needs, up
 * to EXPANDED_PANEL_WIDTH_FACTOR × the collapsed width, wraps titles longer
 * than that onto indented continuation rows (a subagent's prompt up to
 * EXPANDED_SUBAGENT_TITLE_ROWS rows), and scrolls when it outgrows the message
 * area. A collapsed card that already shows everything ignores clicks.
 * Shift+click on a card's header folds it to that row alone (sidecards.ts).
 *
 * A subagent's rows are a link to its conversation while Shift is held: the
 * pointer over them highlights them, and a Shift+click there opens the
 * subagent instead of toggling the card.
 */

import type { ConversationGoalStatus, ConversationTaskSummary, ExternalIntegrationSummary } from "./messages";
import { ACTIVITY_GLYPH, conversationActivityIndicator, type ConversationActivityIndicator } from "./sidebar/activityindicator";
import { areConversationNotificationsMuted } from "./sidebar/folders";
import { isGlobalIdleQueuedMessage } from "./queue";
import { focusedConversation, type RenderState } from "./state";
import { conversationById } from "./sidebar/state";
import { isAgentBackgroundTask, shouldDisplayConversationTask } from "./taskvisibility";
import { padRightToWidth, termWidth, truncateToWidth } from "./textwidth";
import { wordWrap } from "./textwrap";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";
import { collapseOtherExpansions, isCardFolded } from "./sidecards";

export const MAX_PANEL_WIDTH = 50;
export const MIN_PANEL_WIDTH = 30;
/** The expanded card grows leftward up to this multiple of its collapsed width, room and titles permitting. */
export const EXPANDED_PANEL_WIDTH_FACTOR = 1.5;
/** Keep the floating card compact even when a conversation owns many schedules. */
export const MAX_TASK_PANEL_HEIGHT = 12;
/** Keep enough chat beside the panel for useful word wrapping. */
export const MIN_TASK_PANEL_HISTORY_WIDTH = 30;
/** Blank column separating wrapped history from the task-panel border. */
export const TASK_PANEL_HISTORY_GAP = 1;
const ELAPSED_WIDTH = 7;
/** An expanded subagent entry shows this much of its prompt, on at most this many rows. */
export const EXPANDED_SUBAGENT_TITLE_CHARS = 160;
export const EXPANDED_SUBAGENT_TITLE_ROWS = 3;
const INTEGRATION_STATE_WIDTH = 14;
const PANEL_BG_HEX = "#00050f";
const EXOCORTEX_FALLBACK_HEX = "#1d9bf0";
const BASH_FALLBACK_HEX = "#d19a66";
const GOAL_FALLBACK_HEX = "#c792ea";
const CHRONO_FALLBACK_HEX = "#4ec9b0";

export interface TaskPanelEntry extends Omit<ConversationTaskSummary, "kind"> {
  kind: ConversationTaskSummary["kind"] | "goal";
  goalStatus?: ConversationGoalStatus;
}

export interface TaskPanelRender {
  width: number;
  lines: string[];
  /** Expanded body rows scrolled out of view above the card. */
  scroll: number;
  /** Largest useful `scroll`; 0 when the whole card fits or it is collapsed. */
  maxScroll: number;
  /** A click changes the card: it is expanded, or collapsed with an entry or part of a title left out. */
  toggleable: boolean;
  /** Subagent rows that open the child conversation, in card-relative cells. */
  links: TaskPanelLink[];
}

/**
 * One row of a subagent's entry: line `line` of the card, columns
 * `left`..`right` (0-based, inclusive, inside the borders), and how to draw
 * that line highlighted, for while Shift and the pointer are over the entry.
 */
export interface TaskPanelLink {
  line: number;
  left: number;
  right: number;
  convId: string;
  hoverLine: () => string;
}

/** The conversation whose subagent row is at (col, row), or null; nothing is clickable under a modal overlay. */
export function taskPanelLinkAt(state: RenderState, col: number, row: number): string | null {
  if (state.imageModal || state.accountsScreen || state.instructionsModal || state.editMessagePrompt
    || state.queuePrompt || state.sidebar.actionMenu) return null;
  return state.layout.taskPanelLinks.find(link => link.row === row && col >= link.left && col <= link.right)?.convId ?? null;
}

/** The subagent the pointer highlights: only while Shift is held. */
export function taskPanelHoverTarget(state: RenderState): string | null {
  const pointer = state.taskPanelPointer;
  return pointer?.shift ? taskPanelLinkAt(state, pointer.col, pointer.row) : null;
}

/** Whether the last pointer report highlights a different subagent than the last frame drew. */
export function taskPanelHoverChanged(state: RenderState): boolean {
  return taskPanelHoverTarget(state) !== (state.taskPanelHover ?? null);
}

export interface TaskPanelLayout {
  panel: TaskPanelRender | null;
  /** Width available to history rows that are vertically beside the panel. */
  historyWidth: number;
}

export function focusedConversationTasks(state: RenderState): TaskPanelEntry[] {
  if (!state.convId) return [];
  const activityTasks = (focusedConversation(state)?.tasks ?? [])
    .filter(shouldDisplayConversationTask);
  const goal = state.goal;
  const goalTask: TaskPanelEntry[] = goal && goal.status !== "complete"
    ? [{
        id: `goal:${goal.createdAt}`,
        kind: "goal",
        title: goal.reason ? `${goal.objective} — ${goal.reason}` : goal.objective,
        startedAt: goal.createdAt,
        goalStatus: goal.status,
      }]
    : [];
  return [...goalTask, ...activityTasks];
}

/** Whether the focused conversation's panel is expanded; another conversation's expansion never carries over. */
export function isTaskPanelExpanded(state: RenderState): boolean {
  return state.convId !== null && state.taskPanelExpansion?.convId === state.convId;
}

/** Expand the focused conversation's Tasks card at its top (collapsing any other card), or collapse it. */
export function toggleTaskPanelExpansion(state: RenderState): void {
  state.taskPanelExpansion = isTaskPanelExpanded(state) || !state.convId
    ? null
    : { convId: state.convId, scroll: 0 };
  if (state.taskPanelExpansion) collapseOtherExpansions(state, "tasks");
}

/** Scroll the expanded panel by `delta` rows within what the last frame could show; true when it moved. */
export function scrollTaskPanel(state: RenderState, delta: number): boolean {
  const expansion = state.taskPanelExpansion;
  if (!expansion || !isTaskPanelExpanded(state)) return false;
  return scrollExpansion(expansion, state.layout.taskPanelMaxScroll, delta);
}

export function isSubscriptionsExpanded(state: RenderState): boolean {
  return state.convId !== null && state.subscriptionsExpansion?.convId === state.convId;
}

/** Expand the focused conversation's Subscriptions card (collapsing any other card), or collapse it. */
export function toggleSubscriptionsExpansion(state: RenderState): void {
  state.subscriptionsExpansion = isSubscriptionsExpanded(state) || !state.convId
    ? null
    : { convId: state.convId, scroll: 0 };
  if (state.subscriptionsExpansion) collapseOtherExpansions(state, "subscriptions");
}

export function scrollSubscriptions(state: RenderState, delta: number): boolean {
  const expansion = state.subscriptionsExpansion;
  if (!expansion || !isSubscriptionsExpanded(state)) return false;
  return scrollExpansion(expansion, state.layout.subscriptionsMaxScroll, delta);
}

/** Move an expanded card's scroll by `delta` within 0..maxScroll; true when it moved. */
export function scrollExpansion(expansion: { scroll: number }, maxScroll: number, delta: number): boolean {
  const scroll = Math.max(0, Math.min(maxScroll, expansion.scroll + delta));
  if (scroll === expansion.scroll) return false;
  expansion.scroll = scroll;
  return true;
}

export function hasFocusedConversationTasks(state: RenderState): boolean {
  return focusedConversationTasks(state).length > 0;
}

/** Durable external notification subscriptions targeting the focused conversation. */
export function focusedConversationIntegrations(state: RenderState): ExternalIntegrationSummary[] {
  if (!state.convId) return [];
  return focusedConversation(state)?.integrations ?? [];
}

export function hasFocusedConversationIntegrations(state: RenderState): boolean {
  return focusedConversationIntegrations(state).length > 0;
}

/** Compact elapsed time with a stable width suitable for the task card. */
export function formatTaskElapsed(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 7) return `${totalDays}d ${totalHours % 24}h`;
  return `${Math.floor(totalDays / 7)}w ${totalDays % 7}d`;
}

/** Compact remaining time for a scheduled Chrono task. */
export function formatTaskCountdown(dueAt: number, now = Date.now()): string {
  const remainingSeconds = Math.ceil((dueAt - now) / 1000);
  if (remainingSeconds <= 0) return "due";
  if (remainingSeconds < 60) return `in ${remainingSeconds}s`;
  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) return `in ${remainingMinutes}m`;
  const remainingHours = Math.ceil(remainingMinutes / 60);
  if (remainingHours < 24) return `in ${remainingHours}h`;
  return `in ${Math.ceil(remainingHours / 24)}d`;
}

/** Scheduled Chrono work counts down to its due time; a running occurrence shows elapsed time instead. */
function isChronoCountdown(task: TaskPanelEntry): task is TaskPanelEntry & { dueAt: number } {
  return task.kind === "chrono" && task.chronoMode !== "wait" && !task.chronoRunning && task.dueAt !== undefined;
}

function msUntilNextUnitBoundary(value: number, unitMs: number): number {
  const remainder = value % unitMs;
  return remainder === 0 ? unitMs : unitMs - remainder;
}

/**
 * Delay until an entry's rendered time label can actually change.
 *
 * Active work shows seconds only during its first hour, then progressively
 * coarser minute/hour/day units. Scheduled Chrono entries use the same idea in
 * reverse: a wake several days away does not need a one-second repaint timer.
 */
export function msUntilTaskPanelEntryUpdate(task: TaskPanelEntry, now = Date.now()): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(task.startedAt)) return null;
  if (task.kind === "goal" && task.goalStatus !== "active") return null;

  if (isChronoCountdown(task)) {
    if (!Number.isFinite(task.dueAt)) return null;
    const remainingMs = task.dueAt - now;
    if (remainingMs <= 0) return null;

    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const unitMs = remainingSeconds < 60
      ? 1000
      : Math.ceil(remainingSeconds / 60) < 60
        ? 60 * 1000
        : Math.ceil(remainingSeconds / (60 * 60)) < 24
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
    const remainder = remainingMs % unitMs;
    return remainder === 0 ? unitMs : remainder;
  }

  const elapsedMs = Math.max(0, now - task.startedAt);
  const unitMs = elapsedMs < 60 * 60 * 1000
    ? 1000
    : elapsedMs < 24 * 60 * 60 * 1000
      ? 60 * 1000
      : elapsedMs < 7 * 24 * 60 * 60 * 1000
        ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  return msUntilNextUnitBoundary(elapsedMs, unitMs);
}

/** Name of the tool running a background command: Exocortex's shells are Bash, like Claude Code's. */
function backgroundTaskName(toolName: string | undefined): string {
  return !toolName || toolName === "bash" || toolName === "exec_command" ? "Bash" : toolName;
}

function taskColor(state: RenderState, toolName: "exo" | "bash" | "goal" | "chrono", fallback: string): string {
  const color = state.toolRegistry.find(tool => tool.name === toolName)?.color ?? fallback;
  return hexToAnsi(color);
}

function cleanPanelText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F-\x9F]/g, "").replace(/\s+/g, " ").trim();
}

function padLeftToWidth(text: string, width: number): string {
  const clipped = padRightToWidth(text, width).trimEnd();
  return " ".repeat(Math.max(0, width - termWidth(clipped))) + clipped;
}

/** Compact delivery and health text used in place of a task's elapsed time. */
export function formatIntegrationDeliveryStatus(
  integration: Pick<ExternalIntegrationSummary, "delivery" | "status">,
): string {
  return `${integration.delivery} ${integration.status}`;
}

/** The goal and Exocortex subagents lead the Tasks card; other tasks keep the daemon's order. */
function isPriorityTask(task: TaskPanelEntry): boolean {
  return task.kind === "goal" || task.kind === "subagent";
}

export interface PanelPalette {
  outline: string;
  topOutline: string;
  exocortex: string;
  bash: string;
  goal: string;
  chrono: string;
  withPanelBg: (line: string) => string;
}

export function panelPalette(state: RenderState): PanelPalette {
  const panelBg = hexToAnsiBg(PANEL_BG_HEX);
  return {
    outline: `${theme.dim}${theme.text}`,
    topOutline: `${theme.bold}${theme.muted}`,
    exocortex: taskColor(state, "exo", EXOCORTEX_FALLBACK_HEX),
    bash: taskColor(state, "bash", BASH_FALLBACK_HEX),
    goal: taskColor(state, "goal", GOAL_FALLBACK_HEX),
    chrono: taskColor(state, "chrono", CHRONO_FALLBACK_HEX),
    withPanelBg: (line: string) => {
      const persistentBg = line.replaceAll(theme.reset, `${theme.reset}${panelBg}`);
      return `${panelBg}${persistentBg}${theme.reset}`;
    },
  };
}

/**
 * The sidebar's activity indicator for a subagent's child conversation, or
 * null (keep the static diamond) when the child is unknown to the sidebar or idle.
 */
function subagentIndicator(state: RenderState, task: TaskPanelEntry): ConversationActivityIndicator | null {
  if (task.kind !== "subagent") return null;
  const child = conversationById(state.sidebar, task.id);
  if (!child) return null;
  const indicator = conversationActivityIndicator(child, {
    globalIdle: state.queuedMessages.some(message => message.convId === child.id && isGlobalIdleQueuedMessage(message)),
    optimisticStreaming: Boolean(state.pendingAI) && state.convId === child.id,
    notificationsMuted: areConversationNotificationsMuted(state.sidebar, child),
  });
  return indicator.icon ? indicator : null;
}

/**
 * The title column of one entry: truncated to a single row, or word-wrapped
 * onto as many rows as it needs, or as `limit` allows with an ellipsis after
 * what it cuts. Every row is padded to `width`.
 */
function titleRows(title: string, width: number, wrap: boolean, limit?: { chars: number; rows: number }): string[] {
  if (!wrap) return [padRightToWidth(title, width)];
  const chars = Array.from(title);
  const clipped = limit && chars.length > limit.chars ? `${chars.slice(0, limit.chars - 1).join("").trimEnd()}…` : title;
  let rows = wordWrap(clipped, Math.max(1, width)).lines.map(row => row.trim()).filter(Boolean);
  if (limit && rows.length > limit.rows) {
    rows = rows.slice(0, limit.rows);
    // Room for the ellipsis on the last row kept.
    const last = rows.length - 1;
    rows[last] = `${truncateToWidth(rows[last], Math.max(1, width - 1)).replace(/…$/, "").trimEnd()}…`;
  }
  return (rows.length > 0 ? rows : [""]).map(row => padRightToWidth(row, width));
}

/**
 * An entry's rows: label, the first title row and the status column, then any
 * continuation rows indented under the title with the status column left blank.
 */
function entryRows(
  palette: PanelPalette,
  lead: string,
  leadWidth: number,
  titles: string[],
  status: string,
  statusWidth: number,
  highlight = false,
): string[] {
  // Highlighted, everything between the borders sits on the hover background.
  const inside = (text: string) => highlight
    ? `${theme.sidebarSelBg}${text.replaceAll(theme.reset, `${theme.reset}${theme.sidebarSelBg}`)}${theme.reset}`
    : text;
  const row = (start: string, title: string, end: string) => palette.withPanelBg(
    `${palette.outline}│${theme.reset}${inside(` ${start}${theme.text} ${title}${theme.muted}${end}${theme.reset} `)}${palette.outline}│`,
  );
  const blankLead = " ".repeat(leadWidth);
  const blankStatus = " ".repeat(statusWidth);
  return titles.map((title, index) => index === 0
    ? row(lead, title, padLeftToWidth(status, statusWidth))
    : row(blankLead, title, blankStatus));
}

/**
 * Card width at which an entry fits on one row: its label, title and status
 * columns, the gaps between them and the borders, as entryRows lays them out.
 */
function entryFitWidth(label: string, title: string, statusWidth: number): number {
  return termWidth(label) + termWidth(title) + statusWidth + 5;
}

/** A task's label column; `active` marks a subagent with the sidebar's activity glyph. */
function taskLabel(task: TaskPanelEntry, compactExocortex: boolean, active = false): string {
  if (task.kind === "goal") return `${task.goalStatus !== "active" ? "◇" : "◆"} Goal`;
  if (task.kind === "subagent") return `${active ? ACTIVITY_GLYPH : "◆"} ${compactExocortex ? "Exo" : "Exocortex"}`;
  // Claude Code's background agents and workflows run inside Claude Code, not as Exocortex conversations.
  if (isAgentBackgroundTask(task)) return `◆ ${task.toolName}`;
  if (task.kind === "chrono") return "◷ Chrono";
  return `$ ${backgroundTaskName(task.toolName)}`;
}

function taskTitle(task: TaskPanelEntry): string {
  const fallbackTitle = task.kind === "goal" ? "Conversation goal"
    : task.kind === "subagent" || isAgentBackgroundTask(task) ? "Subagent task"
    : task.kind === "chrono" ? "Chrono task"
    : "Background task";
  return cleanPanelText(task.title) || fallbackTitle;
}

/**
 * One entry: label, the title truncated (or wrapped) to fit, and the countdown,
 * elapsed time, or a paused goal's status. `highlight` draws its rows on
 * the hover background.
 */
function taskRows(
  task: TaskPanelEntry,
  palette: PanelPalette,
  innerWidth: number,
  compactExocortex: boolean,
  now: number,
  indicator: ConversationActivityIndicator | null,
  wrap: boolean,
  highlight = false,
): string[] {
  const isSubagent = task.kind === "subagent";
  const isGoal = task.kind === "goal";
  const color = isGoal ? palette.goal
    : isSubagent || isAgentBackgroundTask(task) ? palette.exocortex
    : task.kind === "chrono" ? palette.chrono
    : palette.bash;
  const label = taskLabel(task, compactExocortex, indicator !== null);
  const title = taskTitle(task);
  const time = taskTime(task, now);
  const titleWidth = innerWidth - termWidth(label) - ELAPSED_WIDTH - 3;
  const lead = `${color}${indicator ? `${indicator.color}${label[0]}${color}${label.slice(1)}` : label}`;
  // A subagent's title is its prompt, which can run long: expanded, it gets a few rows, not the whole prompt.
  const limit = isSubagent ? { chars: EXPANDED_SUBAGENT_TITLE_CHARS, rows: EXPANDED_SUBAGENT_TITLE_ROWS } : undefined;
  return entryRows(palette, lead, termWidth(label), titleRows(title, titleWidth, wrap, limit), time, ELAPSED_WIDTH, highlight);
}

function integrationStyle(state: RenderState, integration: ExternalIntegrationSummary): { label: string; color: string } {
  const style = state.externalToolStyles.find(candidate => candidate.cmd === integration.toolName);
  return {
    label: cleanPanelText(style?.label ?? integration.toolName) || "External",
    color: style ? hexToAnsi(style.color) : theme.tool,
  };
}

function integrationTitle(integration: ExternalIntegrationSummary): string {
  const fallbackTitle = cleanPanelText(integration.description ?? "")
    || cleanPanelText(integration.sourceId)
    || "Subscription";
  return cleanPanelText(integration.label) || fallbackTitle;
}

function integrationRows(
  state: RenderState,
  palette: PanelPalette,
  innerWidth: number,
  integration: ExternalIntegrationSummary,
  wrap: boolean,
): string[] {
  const { label: rawToolLabel, color } = integrationStyle(state, integration);
  const title = integrationTitle(integration);
  const deliveryStatus = formatIntegrationDeliveryStatus(integration);
  const labelAndTitleWidth = innerWidth - INTEGRATION_STATE_WIDTH - 3;
  const labelWidth = Math.min(termWidth(rawToolLabel), Math.max(1, labelAndTitleWidth - 1));
  const toolLabel = padRightToWidth(rawToolLabel, labelWidth).trimEnd();
  const titleWidth = Math.max(1, labelAndTitleWidth - termWidth(toolLabel));
  return entryRows(
    palette,
    `${color}${toolLabel}`,
    termWidth(toolLabel),
    titleRows(title, titleWidth, wrap),
    deliveryStatus,
    INTEGRATION_STATE_WIDTH,
  );
}

/** Bottom border of an expanded card: hidden rows on the left, how to collapse on the right (with `hint`). */
export function expandedPanelFooter(palette: PanelPalette, innerWidth: number, above: number, below: number, hint = true): string {
  const scrollText = [above > 0 ? `↑ ${above} above` : "", below > 0 ? `↓ ${below} below` : ""].filter(Boolean).join(" · ");
  // Each text is framed as `─ text ` or ` text ─`; narrow cards drop the hint first, then the scroll counts.
  const framed = (text: string) => text ? termWidth(text) + 3 : 0;
  const hints = hint ? ["click to collapse", "collapse", ""] : [""];
  const hintText = hints.find(text => framed(scrollText) + framed(text) <= innerWidth) ?? "";
  const scroll = framed(scrollText) + framed(hintText) <= innerWidth ? scrollText : "";
  const fill = "─".repeat(Math.max(0, innerWidth - framed(scroll) - framed(hintText)));
  const muted = (text: string) => `${theme.reset}${theme.muted}${text}${palette.outline}`;
  return palette.withPanelBg(
    `${palette.outline}╰${scroll ? `─ ${muted(scroll)} ` : ""}${fill}${hintText ? ` ${muted(hintText)} ─` : ""}╯`,
  );
}

/** The time an entry shows: its state, countdown or elapsed time. */
function taskTime(task: TaskPanelEntry, now: number): string {
  return task.kind === "goal" && task.goalStatus !== "active"
    ? task.goalStatus ?? "paused"
    : isChronoCountdown(task)
      ? formatTaskCountdown(task.dueAt, now)
      : formatTaskElapsed(task.startedAt, now);
}

/**
 * A card's top row: its title on the left and `count` (when not empty) on the
 * right. Folded, the row is the whole card and its corners close it.
 */
export function cardHeader(palette: PanelPalette, innerWidth: number, title: string, count: string, folded = false): string {
  const left = `─ ${title} `;
  const right = count ? ` ${count} ─` : "";
  const fill = "─".repeat(Math.max(0, innerWidth - termWidth(left) - termWidth(right)));
  const [open, close] = folded ? ["╶", "╴"] : ["╭", "╮"];
  return palette.withPanelBg(
    `${palette.topOutline}${open}─ ${theme.reset}${theme.muted}${title}${palette.topOutline} ${fill}`
    + (count ? `${theme.reset}${theme.muted} ${count}${palette.topOutline} ─` : "")
    + close,
  );
}

/** One entry of an entry card: its rows at a card width, how wide a card fits it on one row, and the conversation its rows open. */
interface CardEntry {
  fitWidth: number;
  rows: (innerWidth: number, wrap: boolean, highlight: boolean) => string[];
  linkConvId?: string;
}

interface EntryCardSpec {
  title: string;
  /** Entries, built for this collapsed width (a subagent's label is shorter on a narrow card). */
  entries: (collapsedWidth: number) => CardEntry[];
  expansion: { scroll: number } | null;
  folded: boolean;
  /** Whether the expanded card's footer says how to collapse it. */
  footerHint: boolean;
}

/**
 * Build an entry card (Tasks or Subscriptions).
 *
 * `maxHeight` is the rows the card may take. Collapsed, the card is capped at
 * MAX_TASK_PANEL_HEIGHT; when every entry cannot fit, the final content row
 * reports how many entries are hidden and invites a click, while the header
 * keeps the total count visible. Expanded, the same rows list every entry up
 * to `maxHeight`, scrolling by the expansion's scroll; the card widens
 * leftward until its longest title fits on one row, but never past
 * EXPANDED_PANEL_WIDTH_FACTOR × its collapsed width or `chatWidth`, and wraps
 * titles instead of truncating them. Folded, it is its header row alone.
 */
function buildEntryCard(state: RenderState, spec: EntryCardSpec, chatWidth: number, maxHeight: number): TaskPanelRender | null {
  const collapsedWidth = Math.min(MAX_PANEL_WIDTH, chatWidth);
  const entries = spec.entries(collapsedWidth);
  const expanded = spec.expansion !== null && !spec.folded;
  const panelHeight = spec.folded ? 1 : expanded ? maxHeight : Math.min(maxHeight, MAX_TASK_PANEL_HEIGHT);
  if (entries.length === 0 || chatWidth < MIN_PANEL_WIDTH || panelHeight < (spec.folded ? 1 : 3)) return null;
  const palette = panelPalette(state);
  const count = String(entries.length);
  if (spec.folded) {
    return { width: collapsedWidth, lines: [cardHeader(palette, collapsedWidth - 2, spec.title, count, true)], scroll: 0, maxScroll: 0, toggleable: false, links: [] };
  }

  const widestEntry = Math.max(...entries.map(entry => entry.fitWidth));
  const panelWidth = expanded
    ? Math.max(collapsedWidth, Math.min(widestEntry, chatWidth, Math.floor(collapsedWidth * EXPANDED_PANEL_WIDTH_FACTOR)))
    : collapsedWidth;
  const innerWidth = panelWidth - 2;
  const maxContentRows = panelHeight - 2;
  const visibleCount = expanded || entries.length <= maxContentRows ? entries.length : Math.max(0, maxContentRows - 1);
  const lines = [cardHeader(palette, innerWidth, spec.title, count)];

  const body: string[] = [];
  // Every row of a linked entry opens its conversation, label, title and time, between the borders.
  const bodyLinks: Array<Omit<TaskPanelLink, "line"> & { bodyIndex: number }> = [];
  for (const entry of entries.slice(0, visibleCount)) {
    const rows = entry.rows(innerWidth, expanded, false);
    const convId = entry.linkConvId;
    if (convId) {
      let hoverRows: string[] | null = null;
      const highlighted = () => hoverRows ??= entry.rows(innerWidth, expanded, true);
      rows.forEach((_, index) => bodyLinks.push({
        bodyIndex: body.length + index,
        left: 1,
        right: innerWidth,
        convId,
        hoverLine: () => highlighted()[index],
      }));
    }
    body.push(...rows);
  }
  const linksFrom = (scroll: number, shownRows: number): TaskPanelLink[] => bodyLinks
    .filter(link => link.bodyIndex >= scroll && link.bodyIndex < scroll + shownRows)
    .map(({ bodyIndex, ...link }) => ({ ...link, line: 1 + bodyIndex - scroll }));

  if (expanded) {
    const maxScroll = Math.max(0, body.length - maxContentRows);
    const scroll = Math.max(0, Math.min(maxScroll, spec.expansion?.scroll ?? 0));
    const shown = body.slice(scroll, scroll + maxContentRows);
    lines.push(...shown);
    lines.push(expandedPanelFooter(palette, innerWidth, scroll, body.length - scroll - shown.length, spec.footerHint));
    return { width: panelWidth, lines, scroll, maxScroll, toggleable: true, links: linksFrom(scroll, shown.length) };
  }

  lines.push(...body);
  const hiddenCount = entries.length - visibleCount;
  if (hiddenCount > 0) {
    // The overflow row is the way in to the rest: say so when it fits.
    const more = `▸ ${hiddenCount} more`;
    const invitation = `${more} · click to expand`;
    const overflow = termWidth(invitation) <= innerWidth - 2 ? invitation : more;
    lines.push(palette.withPanelBg(
      `${palette.outline}│${theme.reset} ${theme.muted}`
      + `${padRightToWidth(overflow, innerWidth - 2)}${theme.reset} ${palette.outline}│`,
    ));
  }

  lines.push(palette.withPanelBg(`${palette.outline}╰${"─".repeat(innerWidth)}╯`));
  // Expanding shows the entries the card leaves out and the rest of any title it cuts short; with neither, a click has nothing to show.
  const toggleable = hiddenCount > 0 || widestEntry > panelWidth;
  return { width: panelWidth, lines, scroll: 0, maxScroll: 0, toggleable, links: linksFrom(0, body.length) };
}

const taskPanelCache = new WeakMap<RenderState, { key: unknown[]; panel: TaskPanelRender | null }>();

/**
 * The Tasks card, built again only when something it shows changed: its
 * entries, their times as shown (a countdown or elapsed time changes at most
 * once a second), their activity, the card's expansion, fold and size. Scroll
 * and glide frames reuse it.
 */
export function renderTaskPanel(
  state: RenderState,
  chatWidth: number,
  maxHeight: number,
  now = Date.now(),
): TaskPanelRender | null {
  const key: unknown[] = [
    state.convId, chatWidth, maxHeight, state.taskPanelExpansion?.convId, state.taskPanelExpansion?.scroll,
    isCardFolded(state, "tasks"), state.goal, state.toolRegistry, theme.name,
  ];
  for (const task of focusedConversationTasks(state)) {
    const indicator = subagentIndicator(state, task);
    key.push(task.id, task.kind, task.title, task.toolName, task.goalStatus, task.startedAt, task.dueAt, task.chronoMode, task.chronoRunning,
      taskTime(task, now), indicator?.icon, indicator?.color);
  }
  const cached = taskPanelCache.get(state);
  if (cached && cached.key.length === key.length && cached.key.every((value, index) => value === key[index])) return cached.panel;
  const panel = buildTaskPanel(state, chatWidth, maxHeight, now);
  taskPanelCache.set(state, { key, panel });
  return panel;
}

function buildTaskPanel(state: RenderState, chatWidth: number, maxHeight: number, now: number): TaskPanelRender | null {
  // Priority tasks lead the card, collapsed or expanded; the rest keep the daemon's order.
  const allTasks = focusedConversationTasks(state);
  const tasks = [...allTasks.filter(isPriorityTask), ...allTasks.filter(task => !isPriorityTask(task))];
  const palette = panelPalette(state);
  return buildEntryCard(state, {
    title: "Tasks",
    entries: collapsedWidth => {
      // Only a card at MAX_PANEL_WIDTH widens, so a subagent's label keeps its form when the card expands.
      const compactExocortex = collapsedWidth < 38;
      return tasks.map(task => {
        const indicator = subagentIndicator(state, task);
        return {
          fitWidth: entryFitWidth(taskLabel(task, compactExocortex), taskTitle(task), ELAPSED_WIDTH),
          rows: (innerWidth, wrap, highlight) => taskRows(task, palette, innerWidth, compactExocortex, now, indicator, wrap, highlight),
          ...(task.kind === "subagent" ? { linkConvId: task.id } : {}),
        };
      });
    },
    expansion: isTaskPanelExpanded(state) ? state.taskPanelExpansion : null,
    folded: isCardFolded(state, "tasks"),
    footerHint: true,
  }, chatWidth, maxHeight);
}

const subscriptionsPanelCache = new WeakMap<RenderState, { key: unknown[]; panel: TaskPanelRender | null }>();

/** The Subscriptions card, built again only when its entries, expansion, fold, size or colours changed. */
export function renderSubscriptionsPanel(state: RenderState, chatWidth: number, maxHeight: number): TaskPanelRender | null {
  const key: unknown[] = [
    state.convId, chatWidth, maxHeight, isSubscriptionsExpanded(state), state.subscriptionsExpansion?.scroll,
    isCardFolded(state, "subscriptions"), focusedConversation(state)?.integrations, state.externalToolStyles, state.toolRegistry, theme.name,
  ];
  const cached = subscriptionsPanelCache.get(state);
  if (cached && cached.key.every((value, index) => value === key[index])) return cached.panel;
  const panel = buildSubscriptionsPanel(state, chatWidth, maxHeight);
  subscriptionsPanelCache.set(state, { key, panel });
  return panel;
}

function buildSubscriptionsPanel(state: RenderState, chatWidth: number, maxHeight: number): TaskPanelRender | null {
  const integrations = focusedConversationIntegrations(state);
  const palette = panelPalette(state);
  return buildEntryCard(state, {
    title: "Subscriptions",
    entries: () => integrations.map(integration => ({
      fitWidth: entryFitWidth(integrationStyle(state, integration).label, integrationTitle(integration), INTEGRATION_STATE_WIDTH),
      rows: (innerWidth, wrap) => integrationRows(state, palette, innerWidth, integration, wrap),
    })),
    expansion: isSubscriptionsExpanded(state) ? state.subscriptionsExpansion : null,
    folded: isCardFolded(state, "subscriptions"),
    footerHint: true,
  }, chatWidth, maxHeight);
}

/**
 * Lay out the panel as a right-hand float while preserving a readable history
 * column to its left. On narrow terminals the panel is omitted instead of
 * covering the entire conversation.
 */
export function layoutTaskPanel(
  state: RenderState,
  chatWidth: number,
  maxHeight: number,
  now = Date.now(),
): TaskPanelLayout {
  const availablePanelWidth = chatWidth - MIN_TASK_PANEL_HISTORY_WIDTH - TASK_PANEL_HISTORY_GAP;
  const panel = renderTaskPanel(state, availablePanelWidth, maxHeight, now);
  return {
    panel,
    historyWidth: panel ? chatWidth - panel.width - TASK_PANEL_HISTORY_GAP : chatWidth,
  };
}
