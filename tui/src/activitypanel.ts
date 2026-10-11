/**
 * Focused-conversation activity panel.
 *
 * Renders the current goal, active subagents, detached background commands,
 * displayable Chrono work, and durable external notification subscriptions.
 * The daemon supplies conversation summaries;
 * this module adds the durable goal and owns all visual formatting and
 * horizontal space reservation for the panel.
 *
 * A click toggles the card between its compact one-row-per-entry form and an
 * expanded form that lists every entry in full, scrolling when it outgrows
 * the message area.
 */

import type { ConversationGoalStatus, ConversationTaskSummary, ExternalIntegrationSummary } from "./messages";
import type { RenderState } from "./state";
import { formatQueueDueTime } from "./queue";
import { isAgentBackgroundTask, shouldDisplayConversationTask } from "./taskvisibility";
import { padRightToWidth, termWidth, visibleLength } from "./textwidth";
import { wordWrap } from "./textwrap";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

const MAX_PANEL_WIDTH = 50;
/** Wide enough for most titles on one or two rows without becoming a page. */
const EXPANDED_MAX_PANEL_WIDTH = 72;
const MIN_PANEL_WIDTH = 30;
/** Keep the floating card compact even when a conversation owns many schedules. */
export const MAX_TASK_PANEL_HEIGHT = 12;
/** Keep enough chat beside the panel for useful word wrapping. */
export const MIN_TASK_PANEL_HISTORY_WIDTH = 30;
/** Blank column separating wrapped history from the task-panel border. */
export const TASK_PANEL_HISTORY_GAP = 1;
const ELAPSED_WIDTH = 7;
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
}

export interface TaskPanelLayout {
  panel: TaskPanelRender | null;
  /** Width available to history rows that are vertically beside the panel. */
  historyWidth: number;
}

export function focusedConversationTasks(state: RenderState): TaskPanelEntry[] {
  if (!state.convId || state.folderInstructionsDoc) return [];
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
  if (!state.convId || state.folderInstructionsDoc) return [];
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
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
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

/** Prioritize durable subscriptions when the card cannot fit all entries. */
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

  // Subscriptions are durable inbound connections, so allocate every available
  // entry slot to them before using any remaining slots for tasks.
  const entrySlots = Math.max(0, maxContentRows - 2);
  const visibleIntegrationCount = Math.min(integrations.length, entrySlots);
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

interface TaskRowParts {
  color: string;
  label: string;
  title: string;
  /** Countdown, elapsed time, or a paused goal's status. */
  time: string;
}

function taskRowParts(task: TaskPanelEntry, palette: PanelPalette, compactExocortex: boolean, now: number): TaskRowParts {
  const isSubagent = task.kind === "subagent";
  // Claude Code's background agents and workflows run inside Claude Code, not as Exocortex conversations.
  const isAgent = isAgentBackgroundTask(task);
  const isGoal = task.kind === "goal";
  const isChrono = task.kind === "chrono";
  const color = isGoal ? palette.goal : isSubagent || isAgent ? palette.exocortex : isChrono ? palette.chrono : palette.bash;
  const label = isGoal ? `${task.goalStatus !== "active" ? "◇" : "◆"} Goal`
    : isSubagent ? (compactExocortex ? "◆ Exo" : "◆ Exocortex")
    : isAgent ? `◆ ${task.toolName}`
    : isChrono ? "◷ Chrono"
    : `$ ${backgroundTaskName(task.toolName)}`;
  const fallbackTitle = isGoal ? "Conversation goal" : isSubagent || isAgent ? "Subagent task" : isChrono ? "Chrono task" : "Background task";
  const time = isGoal && task.goalStatus !== "active"
    ? task.goalStatus ?? "paused"
    : isChronoCountdown(task)
      ? formatTaskCountdown(task.dueAt, now)
    : formatTaskElapsed(task.startedAt, now);
  return { color, label, title: cleanPanelText(task.title) || fallbackTitle, time };
}

/** What the compact row leaves out: the kind of work, Chrono's mode and its wall-clock times. */
function expandedTaskDetails(task: TaskPanelEntry, now: number): string[] {
  const at = (time: number) => formatQueueDueTime(time, now);
  if (task.kind === "goal") return [task.goalStatus ?? "active", `set ${at(task.startedAt)}`];
  if (task.kind === "subagent") return ["subagent", `started ${at(task.startedAt)}`];
  if (task.kind === "background") {
    return [isAgentBackgroundTask(task) ? "background agent" : "background command", `started ${at(task.startedAt)}`];
  }
  const details: string[] = [task.chronoMode ?? "wake"];
  if (task.chronoRunning) details.push(`running since ${at(task.startedAt)}`);
  else if (task.dueAt !== undefined) details.push(`due ${at(task.dueAt)}`);
  return details;
}

/** One bordered row holding pre-styled `content` of the given visible width. */
function panelRow(palette: PanelPalette, innerWidth: number, content: string): string {
  const padding = " ".repeat(Math.max(0, innerWidth - 2 - visibleLength(content)));
  return palette.withPanelBg(`${palette.outline}│${theme.reset} ${content}${theme.reset}${padding} ${palette.outline}│`);
}

/**
 * An expanded entry's heading: label and time, with `· details` beside the
 * label when they fit, else wrapped on their own rows below it.
 */
function expandedEntryHeading(
  palette: PanelPalette,
  innerWidth: number,
  color: string,
  label: string,
  details: string,
  time: string,
): string[] {
  const contentWidth = innerWidth - 2;
  const timeWidth = Math.min(termWidth(time), Math.max(0, contentWidth - 2));
  const leftWidth = Math.max(1, contentWidth - timeWidth - (timeWidth > 0 ? 1 : 0));
  const shownLabel = padRightToWidth(label, leftWidth).trimEnd();
  const inlineDetails = details ? ` · ${details}` : "";
  const detailsInline = termWidth(shownLabel) + termWidth(inlineDetails) <= leftWidth;
  const shownDetails = padRightToWidth(detailsInline ? inlineDetails : "", leftWidth - termWidth(shownLabel));
  const shownTime = timeWidth > 0 ? ` ${padLeftToWidth(time, timeWidth)}` : "";
  return [
    panelRow(palette, innerWidth, `${color}${shownLabel}${theme.muted}${shownDetails}${shownTime}`),
    ...(details && !detailsInline ? expandedEntryText(palette, innerWidth, theme.muted, details) : []),
  ];
}

/** Full text wrapped under an entry's heading, indented past its icon. */
function expandedEntryText(palette: PanelPalette, innerWidth: number, style: string, text: string): string[] {
  const indent = "  ";
  const width = Math.max(1, innerWidth - 2 - indent.length);
  return wordWrap(text, width).lines.map(line => panelRow(palette, innerWidth, `${style}${indent}${line.trimEnd()}`));
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

/** Every entry in full: a heading with its details and time, then the wrapped title. */
function expandedPanelBody(
  state: RenderState,
  palette: PanelPalette,
  innerWidth: number,
  tasks: TaskPanelEntry[],
  integrations: ExternalIntegrationSummary[],
  now: number,
): string[] {
  const body: string[] = [];
  for (const task of tasks) {
    const parts = taskRowParts(task, palette, false, now);
    body.push(...expandedEntryHeading(palette, innerWidth, parts.color, parts.label, expandedTaskDetails(task, now).join(" · "), parts.time));
    body.push(...expandedEntryText(palette, innerWidth, theme.text, parts.title));
  }
  if (tasks.length > 0 && integrations.length > 0) {
    body.push(sectionDivider(palette, innerWidth, "Subscriptions", integrations.length));
  }
  for (const integration of integrations) {
    const { label, color } = integrationStyle(state, integration);
    const title = integrationTitle(integration);
    const sourceLabel = cleanPanelText(integration.sourceLabel ?? "");
    const description = cleanPanelText(integration.description ?? "");
    body.push(...expandedEntryHeading(palette, innerWidth, color, label, sourceLabel, formatIntegrationDeliveryStatus(integration)));
    body.push(...expandedEntryText(palette, innerWidth, theme.text, title));
    if (description && description !== title) body.push(...expandedEntryText(palette, innerWidth, theme.muted, description));
  }
  return body;
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
 * the header keeps the total count visible. Expanded, the card grows wider and
 * up to `maxHeight`, and scrolls by `state.taskPanelExpansion.scroll` rows.
 */
export function renderTaskPanel(
  state: RenderState,
  chatWidth: number,
  maxHeight: number,
  now = Date.now(),
): TaskPanelRender | null {
  const tasks = focusedConversationTasks(state);
  const integrations = focusedConversationIntegrations(state);
  const totalEntries = tasks.length + integrations.length;
  const expanded = isTaskPanelExpanded(state);
  const panelHeight = expanded ? maxHeight : Math.min(maxHeight, MAX_TASK_PANEL_HEIGHT);
  if (totalEntries === 0 || chatWidth < MIN_PANEL_WIDTH || panelHeight < 3) return null;

  const panelWidth = Math.min(expanded ? EXPANDED_MAX_PANEL_WIDTH : MAX_PANEL_WIDTH, chatWidth);
  const innerWidth = panelWidth - 2;
  const maxContentRows = panelHeight - 2;
  const visible = fitTasksAndSubscriptions(tasks, integrations, maxContentRows);
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

  if (expanded) {
    const body = expandedPanelBody(state, palette, innerWidth, tasks, integrations, now);
    const maxScroll = Math.max(0, body.length - maxContentRows);
    const scroll = Math.max(0, Math.min(maxScroll, state.taskPanelExpansion?.scroll ?? 0));
    const shown = body.slice(scroll, scroll + maxContentRows);
    lines.push(...shown);
    lines.push(expandedPanelFooter(palette, innerWidth, scroll, body.length - scroll - shown.length));
    return { width: panelWidth, lines, scroll, maxScroll };
  }

  for (const task of visible.tasks) {
    const { color, label, title, time } = taskRowParts(task, palette, panelWidth < 38, now);
    const titleWidth = innerWidth - termWidth(label) - ELAPSED_WIDTH - 3;
    lines.push(withPanelBg(
      `${outline}│${theme.reset} ${color}${label}`
      + `${theme.text} ${padRightToWidth(title, titleWidth)}`
      + `${theme.muted}${padLeftToWidth(time, ELAPSED_WIDTH)}${theme.reset} ${outline}│`,
    ));
  }

  if (visible.showSubscriptionsDivider) {
    lines.push(sectionDivider(palette, innerWidth, "Subscriptions", integrations.length));
  }

  for (const integration of visible.integrations) {
    const { label: rawToolLabel, color } = integrationStyle(state, integration);
    const title = integrationTitle(integration);
    const deliveryStatus = formatIntegrationDeliveryStatus(integration);
    const labelAndTitleWidth = innerWidth - INTEGRATION_STATE_WIDTH - 3;
    const labelWidth = Math.min(termWidth(rawToolLabel), Math.max(1, labelAndTitleWidth - 1));
    const toolLabel = padRightToWidth(rawToolLabel, labelWidth).trimEnd();
    const titleWidth = Math.max(1, labelAndTitleWidth - termWidth(toolLabel));
    lines.push(withPanelBg(
      `${outline}│${theme.reset} ${color}${toolLabel}`
      + `${theme.text} ${padRightToWidth(title, titleWidth)}`
      + `${theme.muted}${padLeftToWidth(deliveryStatus, INTEGRATION_STATE_WIDTH)}${theme.reset} ${outline}│`,
    ));
  }

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
  return { width: panelWidth, lines, scroll: 0, maxScroll: 0 };
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
