/**
 * Focused-conversation activity panel.
 *
 * Renders the current goal, active subagents, detached background commands,
 * displayable Chrono work, and durable external notification subscriptions as a
 * compact top-right panel. The daemon supplies conversation summaries; this
 * module adds the focused conversation's durable goal and owns all visual
 * formatting and horizontal space reservation for the panel.
 */

import type { ConversationGoalStatus, ConversationTaskSummary, ExternalIntegrationSummary } from "./messages";
import type { RenderState } from "./state";
import { shouldDisplayConversationTask } from "./taskvisibility";
import { padRightToWidth, termWidth } from "./textwidth";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

const MAX_PANEL_WIDTH = 50;
const MIN_PANEL_WIDTH = 30;
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
        title: goal.objective,
        startedAt: goal.createdAt,
        goalStatus: goal.status,
      }]
    : [];
  return [...goalTask, ...activityTasks];
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

interface VisiblePanelContent {
  tasks: TaskPanelEntry[];
  integrations: ExternalIntegrationSummary[];
  hiddenCount: number;
  showSubscriptionsDivider: boolean;
}

/**
 * Fit task-panel entries into the card. Subscriptions always keep their own
 * divider, including when no ordinary task rows are currently present.
 */
function fitPanelContent(
  tasks: TaskPanelEntry[],
  integrations: ExternalIntegrationSummary[],
  maxContentRows: number,
): VisiblePanelContent {
  const totalEntries = tasks.length + integrations.length;

  if (integrations.length === 0) {
    const entriesFit = totalEntries <= maxContentRows;
    const visibleCount = entriesFit ? totalEntries : Math.max(0, maxContentRows - 1);
    return {
      tasks: tasks.slice(0, visibleCount),
      integrations: [],
      hiddenCount: totalEntries - visibleCount,
      showSubscriptionsDivider: false,
    };
  }

  // A subscription-bearing card always has one internal divider in addition
  // to its entries, preserving Tasks as the panel's outer identity.
  if (totalEntries + 1 <= maxContentRows) {
    return {
      tasks,
      integrations,
      hiddenCount: 0,
      showSubscriptionsDivider: true,
    };
  }

  // At the absolute three-line panel minimum, the section divider and its
  // count are more informative than an unclassified overflow row.
  if (maxContentRows < 2) {
    return { tasks: [], integrations: [], hiddenCount: 0, showSubscriptionsDivider: true };
  }

  // Reserve one row each for the Subscriptions divider and overflow notice.
  // In a combined panel, represent both sections once two entry slots exist;
  // otherwise use all available entry slots for subscription rows.
  const entrySlots = Math.max(0, maxContentRows - 2);
  let visibleTaskCount = tasks.length > 0 && entrySlots > 0 ? 1 : 0;
  let visibleIntegrationCount = tasks.length > 0 && entrySlots > 1
    ? 1
    : tasks.length === 0 ? Math.min(integrations.length, entrySlots) : 0;
  let remainingSlots = entrySlots - visibleTaskCount - visibleIntegrationCount;

  const additionalTasks = Math.min(tasks.length - visibleTaskCount, remainingSlots);
  visibleTaskCount += additionalTasks;
  remainingSlots -= additionalTasks;
  visibleIntegrationCount += Math.min(integrations.length - visibleIntegrationCount, remainingSlots);

  return {
    tasks: tasks.slice(0, visibleTaskCount),
    integrations: integrations.slice(0, visibleIntegrationCount),
    hiddenCount: totalEntries - visibleTaskCount - visibleIntegrationCount,
    showSubscriptionsDivider: true,
  };
}

/**
 * Build the activity panel for the focused conversation.
 *
 * `maxHeight` is the available message-area height. When every entry cannot fit,
 * the final content row reports how many entries are hidden while the header
 * keeps the total count visible.
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
  if (totalEntries === 0 || chatWidth < MIN_PANEL_WIDTH || maxHeight < 3) return null;

  const panelWidth = Math.min(MAX_PANEL_WIDTH, chatWidth);
  const innerWidth = panelWidth - 2;
  const maxContentRows = maxHeight - 2;
  const visible = fitPanelContent(tasks, integrations, maxContentRows);

  const panelBg = hexToAnsiBg(PANEL_BG_HEX);
  const outline = `${theme.dim}${theme.text}`;
  const topOutline = `${theme.bold}${theme.muted}`;
  const exocortex = taskColor(state, "exo", EXOCORTEX_FALLBACK_HEX);
  const bash = taskColor(state, "bash", BASH_FALLBACK_HEX);
  const goal = taskColor(state, "goal", GOAL_FALLBACK_HEX);
  const chrono = taskColor(state, "chrono", CHRONO_FALLBACK_HEX);

  const withPanelBg = (line: string) => {
    const persistentBg = line.replaceAll(theme.reset, `${theme.reset}${panelBg}`);
    return `${panelBg}${persistentBg}${theme.reset}`;
  };

  const headerTitle = "Tasks";
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

  for (const task of visible.tasks) {
    const isSubagent = task.kind === "subagent";
    const isGoal = task.kind === "goal";
    const isChrono = task.kind === "chrono";
    const color = isGoal ? goal : isSubagent ? exocortex : isChrono ? chrono : bash;
    const label = panelWidth >= 38
      ? (isGoal ? `${task.goalStatus === "paused" ? "◇" : "◆"} Goal` : isSubagent ? "◆ Exocortex" : isChrono ? "◷ Chrono" : "$ Bash")
      : (isGoal ? `${task.goalStatus === "paused" ? "◇" : "◆"} Goal` : isSubagent ? "◆ Exo" : isChrono ? "◷ Chrono" : "$ Bash");
    const fallbackTitle = isGoal ? "Conversation goal" : isSubagent ? "Subagent task" : isChrono ? "Chrono task" : "Background task";
    const title = cleanPanelText(task.title) || fallbackTitle;
    const elapsed = isGoal && task.goalStatus === "paused"
      ? "paused"
      : isChrono && task.chronoMode !== "wait" && task.dueAt !== undefined
        ? formatTaskCountdown(task.dueAt, now)
      : formatTaskElapsed(task.startedAt, now);
    const titleWidth = innerWidth - termWidth(label) - ELAPSED_WIDTH - 3;
    lines.push(withPanelBg(
      `${outline}│${theme.reset} ${color}${label}`
      + `${theme.text} ${padRightToWidth(title, titleWidth)}`
      + `${theme.muted}${padLeftToWidth(elapsed, ELAPSED_WIDTH)}${theme.reset} ${outline}│`,
    ));
  }

  if (visible.showSubscriptionsDivider) {
    const sectionTitle = "Subscriptions";
    const sectionCount = String(integrations.length);
    const sectionLeft = `─ ${sectionTitle} `;
    const sectionRight = ` ${sectionCount} ─`;
    const sectionFill = "─".repeat(Math.max(0, innerWidth - termWidth(sectionLeft) - termWidth(sectionRight)));
    lines.push(withPanelBg(
      `${outline}├─ ${theme.reset}${theme.muted}${sectionTitle}${outline} ${sectionFill}`
      + `${theme.reset}${theme.muted} ${sectionCount}${outline} ─┤`,
    ));
  }

  for (const integration of visible.integrations) {
    const style = state.externalToolStyles.find(candidate => candidate.cmd === integration.toolName);
    const rawToolLabel = cleanPanelText(style?.label ?? integration.toolName) || "External";
    const color = style ? hexToAnsi(style.color) : theme.tool;
    const fallbackTitle = cleanPanelText(integration.description ?? "")
      || cleanPanelText(integration.sourceId)
      || "Subscription";
    const title = cleanPanelText(integration.label) || fallbackTitle;
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
    lines.push(withPanelBg(
      `${outline}│${theme.reset} ${theme.muted}`
      + `${padRightToWidth(`… ${visible.hiddenCount} more`, innerWidth - 2)}${theme.reset} ${outline}│`,
    ));
  }

  lines.push(withPanelBg(`${outline}╰${"─".repeat(innerWidth)}╯`));
  return { width: panelWidth, lines };
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
