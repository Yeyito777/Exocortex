/**
 * Focused-conversation activity panel.
 *
 * Renders the current goal, active subagents, detached background commands,
 * displayable Chrono work, and durable external notification subscriptions.
 * The daemon supplies conversation summaries;
 * this module adds the durable goal and owns all visual formatting and
 * horizontal space reservation for the panel.
 *
 * Collapsed, every entry is one compact row and the card is capped in height,
 * its last row counting the entries left out. When it leaves out an entry or
 * part of a title, a click toggles an expanded form that lists every entry,
 * grows leftward (keeping its right edge) as far as its longest title needs, up
 * to EXPANDED_PANEL_WIDTH_FACTOR × the collapsed width, wraps titles longer
 * than that onto indented continuation rows (a subagent's prompt up to
 * EXPANDED_SUBAGENT_TITLE_ROWS rows), and scrolls when it outgrows the message
 * area. A collapsed card that already shows everything ignores clicks.
 */

import type { ConversationGoalStatus, ConversationTaskSummary, ExternalIntegrationSummary } from "./messages";
import { ACTIVITY_GLYPH, conversationActivityIndicator, type ConversationActivityIndicator } from "./sidebar/activityindicator";
import { areConversationNotificationsMuted } from "./sidebar/folders";
import { isGlobalIdleQueuedMessage } from "./queue";
import type { RenderState } from "./state";
import { isAgentBackgroundTask, shouldDisplayConversationTask } from "./taskvisibility";
import { padRightToWidth, termWidth, truncateToWidth } from "./textwidth";
import { wordWrap } from "./textwrap";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

const MAX_PANEL_WIDTH = 50;
const MIN_PANEL_WIDTH = 30;
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
}

export interface TaskPanelLayout {
  panel: TaskPanelRender | null;
  /** Width available to history rows that are vertically beside the panel. */
  historyWidth: number;
}

export function focusedConversationTasks(state: RenderState): TaskPanelEntry[] {
  if (!state.convId) return [];
  const activityTasks = (state.sidebar.conversations.find(conversation => conversation.id === state.convId)?.tasks ?? [])
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

/** Expand the focused conversation's panel at its top, or collapse it. */
export function toggleTaskPanelExpansion(state: RenderState): void {
  state.taskPanelExpansion = isTaskPanelExpanded(state) || !state.convId
    ? null
    : { convId: state.convId, scroll: 0 };
}

/** Scroll the expanded panel by `delta` rows within what the last frame could show; true when it moved. */
export function scrollTaskPanel(state: RenderState, delta: number): boolean {
  const expansion = state.taskPanelExpansion;
  if (!expansion || !isTaskPanelExpanded(state)) return false;
  const scroll = Math.max(0, Math.min(state.layout.taskPanelMaxScroll, expansion.scroll + delta));
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
  return state.sidebar.conversations.find(conversation => conversation.id === state.convId)?.integrations ?? [];
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

type PanelSectionTitle = "Tasks" | "Subscriptions";

interface VisiblePanelContent {
  tasks: TaskPanelEntry[];
  integrations: ExternalIntegrationSummary[];
  hiddenCount: number;
  headerTitle: PanelSectionTitle;
  showSubscriptionsDivider: boolean;
}

/** The goal and Exocortex subagents outrank subscriptions, which outrank other tasks. */
function isPriorityTask(task: TaskPanelEntry): boolean {
  return task.kind === "goal" || task.kind === "subagent";
}

/**
 * Fit entries when the card cannot show them all. `tasks` lists priority
 * tasks (isPriorityTask) first; they get every slot they need, subscriptions
 * the slots left after them, and other tasks whatever remains. The
 * Subscriptions divider keeps their count even when none of their rows fit.
 */
function fitTasksAndSubscriptions(
  tasks: TaskPanelEntry[],
  integrations: ExternalIntegrationSummary[],
  maxContentRows: number,
): VisiblePanelContent {
  const totalEntries = tasks.length + integrations.length;
  const headerTitle = tasks.length > 0 ? "Tasks" : "Subscriptions";

  if (tasks.length === 0 || integrations.length === 0) {
    const entriesFit = totalEntries <= maxContentRows;
    const visibleCount = entriesFit ? totalEntries : Math.max(0, maxContentRows - 1);
    return {
      tasks: tasks.slice(0, visibleCount),
      integrations: integrations.slice(0, visibleCount),
      hiddenCount: totalEntries - visibleCount,
      headerTitle,
      showSubscriptionsDivider: false,
    };
  }

  if (totalEntries + 1 <= maxContentRows) {
    return {
      tasks,
      integrations,
      hiddenCount: 0,
      headerTitle,
      showSubscriptionsDivider: true,
    };
  }

  if (maxContentRows < 2) {
    return {
      tasks: [],
      integrations: [],
      hiddenCount: 0,
      headerTitle,
      showSubscriptionsDivider: true,
    };
  }

  const entrySlots = Math.max(0, maxContentRows - 2);
  const priorityCount = Math.min(entrySlots, tasks.filter(isPriorityTask).length);
  const visibleIntegrationCount = Math.min(integrations.length, entrySlots - priorityCount);
  const visibleTaskCount = Math.min(tasks.length, entrySlots - visibleIntegrationCount);

  return {
    tasks: tasks.slice(0, visibleTaskCount),
    integrations: integrations.slice(0, visibleIntegrationCount),
    hiddenCount: totalEntries - visibleTaskCount - visibleIntegrationCount,
    headerTitle,
    showSubscriptionsDivider: true,
  };
}

interface PanelPalette {
  outline: string;
  topOutline: string;
  exocortex: string;
  bash: string;
  goal: string;
  chrono: string;
  withPanelBg: (line: string) => string;
}

function panelPalette(state: RenderState): PanelPalette {
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
  const child = state.sidebar.conversations.find(conversation => conversation.id === task.id);
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
): string[] {
  const row = (start: string, title: string, end: string) => palette.withPanelBg(
    `${palette.outline}│${theme.reset} ${start}${theme.text} ${title}`
    + `${theme.muted}${end}${theme.reset} ${palette.outline}│`,
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

/** One entry: label, the title truncated (or wrapped) to fit, and the countdown, elapsed time, or a paused goal's status. */
function taskRows(
  task: TaskPanelEntry,
  palette: PanelPalette,
  innerWidth: number,
  compactExocortex: boolean,
  now: number,
  indicator: ConversationActivityIndicator | null,
  wrap: boolean,
): string[] {
  const isSubagent = task.kind === "subagent";
  const isGoal = task.kind === "goal";
  const color = isGoal ? palette.goal
    : isSubagent || isAgentBackgroundTask(task) ? palette.exocortex
    : task.kind === "chrono" ? palette.chrono
    : palette.bash;
  const label = taskLabel(task, compactExocortex, indicator !== null);
  const title = taskTitle(task);
  const time = isGoal && task.goalStatus !== "active"
    ? task.goalStatus ?? "paused"
    : isChronoCountdown(task)
      ? formatTaskCountdown(task.dueAt, now)
    : formatTaskElapsed(task.startedAt, now);
  const titleWidth = innerWidth - termWidth(label) - ELAPSED_WIDTH - 3;
  const lead = `${color}${indicator ? `${indicator.color}${label[0]}${color}${label.slice(1)}` : label}`;
  // A subagent's title is its prompt, which can run long: expanded, it gets a few rows, not the whole prompt.
  const limit = isSubagent ? { chars: EXPANDED_SUBAGENT_TITLE_CHARS, rows: EXPANDED_SUBAGENT_TITLE_ROWS } : undefined;
  return entryRows(palette, lead, termWidth(label), titleRows(title, titleWidth, wrap, limit), time, ELAPSED_WIDTH);
}

function sectionDivider(palette: PanelPalette, innerWidth: number, title: string, count: number): string {
  const left = `─ ${title} `;
  const right = ` ${count} ─`;
  const fill = "─".repeat(Math.max(0, innerWidth - termWidth(left) - termWidth(right)));
  return palette.withPanelBg(
    `${palette.outline}├─ ${theme.reset}${theme.muted}${title}${palette.outline} ${fill}`
    + `${theme.reset}${theme.muted} ${count}${palette.outline} ─┤`,
  );
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

/** Bottom border of the expanded card: hidden rows on the left, how to collapse on the right. */
function expandedPanelFooter(palette: PanelPalette, innerWidth: number, above: number, below: number): string {
  const scrollText = [above > 0 ? `↑ ${above} above` : "", below > 0 ? `↓ ${below} below` : ""].filter(Boolean).join(" · ");
  // Each text is framed as `─ text ` or ` text ─`; narrow cards drop the hint first, then the scroll counts.
  const framed = (text: string) => text ? termWidth(text) + 3 : 0;
  const hint = ["click to collapse", "collapse", ""].find(text => framed(scrollText) + framed(text) <= innerWidth) ?? "";
  const scroll = framed(scrollText) + framed(hint) <= innerWidth ? scrollText : "";
  const fill = "─".repeat(Math.max(0, innerWidth - framed(scroll) - framed(hint)));
  const muted = (text: string) => `${theme.reset}${theme.muted}${text}${palette.outline}`;
  return palette.withPanelBg(
    `${palette.outline}╰${scroll ? `─ ${muted(scroll)} ` : ""}${fill}${hint ? ` ${muted(hint)} ─` : ""}╯`,
  );
}

/**
 * Build the activity panel for the focused conversation.
 *
 * `maxHeight` is the available message-area height. Collapsed, the card is
 * capped at MAX_TASK_PANEL_HEIGHT; when every entry cannot fit, the final
 * content row reports how many entries are hidden and invites a click, while
 * the header keeps the total count visible. Expanded, the same rows list every
 * entry up to `maxHeight`, scrolling by `state.taskPanelExpansion.scroll` rows;
 * the card widens leftward until its longest title fits on one row, but never
 * past EXPANDED_PANEL_WIDTH_FACTOR × its collapsed width or `chatWidth`, and
 * wraps titles instead of truncating them.
 */
export function renderTaskPanel(
  state: RenderState,
  chatWidth: number,
  maxHeight: number,
  now = Date.now(),
): TaskPanelRender | null {
  // Priority tasks lead the Tasks section, collapsed or expanded; the rest keep the daemon's order.
  const allTasks = focusedConversationTasks(state);
  const tasks = [...allTasks.filter(isPriorityTask), ...allTasks.filter(task => !isPriorityTask(task))];
  const integrations = focusedConversationIntegrations(state);
  const totalEntries = tasks.length + integrations.length;
  const expanded = isTaskPanelExpanded(state);
  const panelHeight = expanded ? maxHeight : Math.min(maxHeight, MAX_TASK_PANEL_HEIGHT);
  if (totalEntries === 0 || chatWidth < MIN_PANEL_WIDTH || panelHeight < 3) return null;

  const collapsedWidth = Math.min(MAX_PANEL_WIDTH, chatWidth);
  // Only a card at MAX_PANEL_WIDTH widens, so a subagent's label keeps its form when the card expands.
  const compactExocortex = collapsedWidth < 38;
  const widestEntry = Math.max(
    ...tasks.map(task => entryFitWidth(taskLabel(task, compactExocortex), taskTitle(task), ELAPSED_WIDTH)),
    ...integrations.map(integration =>
      entryFitWidth(integrationStyle(state, integration).label, integrationTitle(integration), INTEGRATION_STATE_WIDTH)),
  );
  const panelWidth = expanded
    ? Math.max(collapsedWidth, Math.min(widestEntry, chatWidth, Math.floor(collapsedWidth * EXPANDED_PANEL_WIDTH_FACTOR)))
    : collapsedWidth;
  const innerWidth = panelWidth - 2;
  const maxContentRows = panelHeight - 2;
  const visible = fitTasksAndSubscriptions(tasks, integrations, expanded ? Infinity : maxContentRows);
  const palette = panelPalette(state);
  const { outline, topOutline, withPanelBg } = palette;

  const headerTitle = visible.headerTitle;
  const entryCount = String(totalEntries);
  const headerLeft = `─ ${headerTitle} `;
  const headerRight = ` ${entryCount} ─`;
  const headerFill = "─".repeat(Math.max(0, innerWidth - termWidth(headerLeft) - termWidth(headerRight)));
  const lines = [
    withPanelBg(
      `${topOutline}╭─ ${theme.reset}${theme.muted}${headerTitle}${topOutline} ${headerFill}`
      + `${theme.reset}${theme.muted} ${entryCount}${topOutline} ─╮`,
    ),
  ];

  const body = visible.tasks.flatMap(task =>
    taskRows(task, palette, innerWidth, compactExocortex, now, subagentIndicator(state, task), expanded));
  if (visible.showSubscriptionsDivider) {
    body.push(sectionDivider(palette, innerWidth, "Subscriptions", integrations.length));
  }
  body.push(...visible.integrations.flatMap(integration => integrationRows(state, palette, innerWidth, integration, expanded)));

  if (expanded) {
    const maxScroll = Math.max(0, body.length - maxContentRows);
    const scroll = Math.max(0, Math.min(maxScroll, state.taskPanelExpansion?.scroll ?? 0));
    const shown = body.slice(scroll, scroll + maxContentRows);
    lines.push(...shown);
    lines.push(expandedPanelFooter(palette, innerWidth, scroll, body.length - scroll - shown.length));
    return { width: panelWidth, lines, scroll, maxScroll, toggleable: true };
  }

  lines.push(...body);
  if (visible.hiddenCount > 0) {
    // The overflow row is the way in to the rest: say so when it fits.
    const more = `▸ ${visible.hiddenCount} more`;
    const invitation = `${more} · click to expand`;
    const overflow = termWidth(invitation) <= innerWidth - 2 ? invitation : more;
    lines.push(withPanelBg(
      `${outline}│${theme.reset} ${theme.muted}`
      + `${padRightToWidth(overflow, innerWidth - 2)}${theme.reset} ${outline}│`,
    ));
  }

  lines.push(withPanelBg(`${outline}╰${"─".repeat(innerWidth)}╯`));
  // Expanding shows the entries the card leaves out and the rest of any title it cuts short; with neither, a click has nothing to show.
  const toggleable = visible.tasks.length + visible.integrations.length < totalEntries || widestEntry > panelWidth;
  return { width: panelWidth, lines, scroll: 0, maxScroll: 0, toggleable };
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
