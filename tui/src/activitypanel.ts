/**
 * Focused-conversation task panel.
 *
 * Renders the current goal, active subagents, detached background commands, and
 * displayable Chrono work as a compact top-right overlay. The daemon supplies
 * conversation summaries; this module adds the focused conversation's durable
 * goal and owns all visual formatting for the panel.
 */

import type { ConversationGoalStatus, ConversationTaskSummary } from "./messages";
import type { RenderState } from "./state";
import { shouldDisplayConversationTask } from "./taskvisibility";
import { padRightToWidth, termWidth } from "./textwidth";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

const MAX_PANEL_WIDTH = 50;
const MIN_PANEL_WIDTH = 30;
const ELAPSED_WIDTH = 7;
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

function cleanTaskTitle(title: string): string {
  return title.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
}

function padLeftToWidth(text: string, width: number): string {
  const clipped = padRightToWidth(text, width).trimEnd();
  return " ".repeat(Math.max(0, width - termWidth(clipped))) + clipped;
}

/**
 * Build the task panel for the focused conversation.
 *
 * `maxHeight` is the available message-area height. When every task cannot fit,
 * the final content row reports how many tasks are hidden while the header keeps
 * the total count visible.
 */
export function renderTaskPanel(
  state: RenderState,
  chatWidth: number,
  maxHeight: number,
  now = Date.now(),
): TaskPanelRender | null {
  const tasks = focusedConversationTasks(state);
  if (tasks.length === 0 || chatWidth < MIN_PANEL_WIDTH || maxHeight < 3) return null;

  const panelWidth = Math.min(MAX_PANEL_WIDTH, chatWidth);
  const innerWidth = panelWidth - 2;
  const maxLabelWidth = panelWidth >= 38 ? termWidth("◆ Exocortex") : termWidth("$ Bash");
  if (innerWidth - maxLabelWidth - ELAPSED_WIDTH - 3 < 1) return null;

  const maxContentRows = maxHeight - 2;
  const hasOverflow = tasks.length > maxContentRows;
  const visibleTaskCount = hasOverflow ? Math.max(0, maxContentRows - 1) : tasks.length;
  const visibleTasks = tasks.slice(0, visibleTaskCount);
  const hiddenCount = tasks.length - visibleTasks.length;

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
  const taskCount = String(tasks.length);
  const headerLeft = `─ ${headerTitle} `;
  const headerRight = ` ${taskCount} ─`;
  const headerFill = "─".repeat(Math.max(0, innerWidth - termWidth(headerLeft) - termWidth(headerRight)));
  const lines = [
    withPanelBg(
      `${topOutline}╭─ ${theme.reset}${theme.muted}${headerTitle}${topOutline} ${headerFill}`
      + `${theme.reset}${theme.muted} ${taskCount}${topOutline} ─╮`,
    ),
  ];

  for (const task of visibleTasks) {
    const isSubagent = task.kind === "subagent";
    const isGoal = task.kind === "goal";
    const isChrono = task.kind === "chrono";
    const color = isGoal ? goal : isSubagent ? exocortex : isChrono ? chrono : bash;
    const label = panelWidth >= 38
      ? (isGoal ? `${task.goalStatus === "paused" ? "◇" : "◆"} Goal` : isSubagent ? "◆ Exocortex" : isChrono ? "◷ Chrono" : "$ Bash")
      : (isGoal ? `${task.goalStatus === "paused" ? "◇" : "◆"} Goal` : isSubagent ? "◆ Exo" : isChrono ? "◷ Chrono" : "$ Bash");
    const fallbackTitle = isGoal ? "Conversation goal" : isSubagent ? "Subagent task" : isChrono ? "Chrono task" : "Background task";
    const title = cleanTaskTitle(task.title) || fallbackTitle;
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

  if (hiddenCount > 0) {
    lines.push(withPanelBg(
      `${outline}│${theme.reset} ${theme.muted}`
      + `${padRightToWidth(`… ${hiddenCount} more`, innerWidth - 2)}${theme.reset} ${outline}│`,
    ));
  }

  lines.push(withPanelBg(`${outline}╰${"─".repeat(innerWidth)}╯`));
  return { width: panelWidth, lines };
}
