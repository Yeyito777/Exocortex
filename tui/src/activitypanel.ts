/**
 * Focused-conversation task panel.
 *
 * Renders active subagents and detached background commands as a compact
 * top-right overlay. The daemon supplies ephemeral task details on conversation
 * summaries; this module owns all visual formatting for the panel.
 */

import type { ConversationTaskSummary } from "./messages";
import type { RenderState } from "./state";
import { padRightToWidth, termWidth } from "./textwidth";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

const MAX_PANEL_WIDTH = 50;
const MIN_PANEL_WIDTH = 30;
const ELAPSED_WIDTH = 7;
const PANEL_BG_HEX = "#00050f";
const EXOCORTEX_FALLBACK_HEX = "#1d9bf0";
const BASH_FALLBACK_HEX = "#d19a66";

export interface TaskPanelRender {
  width: number;
  lines: string[];
}

export function focusedConversationTasks(state: RenderState): ConversationTaskSummary[] {
  if (!state.convId || state.folderInstructionsDoc) return [];
  return state.sidebar.conversations.find(conversation => conversation.id === state.convId)?.tasks ?? [];
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

function taskColor(state: RenderState, toolName: "exo" | "bash", fallback: string): string {
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
  const labelWidth = panelWidth >= 38 ? 13 : 6;
  const titleWidth = innerWidth - 1 - labelWidth - ELAPSED_WIDTH - 1;
  if (titleWidth < 1) return null;

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
    const color = isSubagent ? exocortex : bash;
    const label = panelWidth >= 38
      ? (isSubagent ? "◆ Exocortex" : "$ Bash")
      : (isSubagent ? "◆ Exo" : "$ Bash");
    const title = cleanTaskTitle(task.title) || (isSubagent ? "Subagent task" : "Background task");
    const elapsed = formatTaskElapsed(task.startedAt, now);
    lines.push(withPanelBg(
      `${outline}│${theme.reset} ${color}${padRightToWidth(label, labelWidth)}`
      + `${theme.text}${padRightToWidth(title, titleWidth)}`
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
