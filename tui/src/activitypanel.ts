/**
 * Focused-conversation activity panel.
 *
 * Renders the current goal, active subagents, detached background commands,
 * displayable Chrono work, durable external notification subscriptions, and
 * non-default disabled tools as a compact top-right panel. The daemon supplies
 * conversation summaries and the focused conversation's resolved tool policy;
 * this module adds the durable goal and owns all visual formatting and
 * horizontal space reservation for the panel.
 */

import type { ConversationGoalStatus, ConversationTaskSummary, ExternalIntegrationSummary, ToolPolicyKind } from "./messages";
import type { RenderState } from "./state";
import { wrapAnsiLine } from "./ansiwrap";
import { shouldDisplayConversationTask } from "./taskvisibility";
import { padRightToWidth, termWidth, visibleLength } from "./textwidth";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

const MAX_PANEL_WIDTH = 50;
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

export interface DisabledToolEntry {
  kind: ToolPolicyKind;
  name: string;
  label: string;
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

/** Disabled tools are exceptional state; an all-enabled default yields no rows. */
export function focusedConversationDisabledTools(state: RenderState): DisabledToolEntry[] {
  if (!state.convId || state.folderInstructionsDoc || state.activeToolPolicy?.convId !== state.convId) return [];
  return [
    ...state.activeToolPolicy.internal
      .filter(tool => !tool.enabled)
      .map(tool => ({ kind: "internal" as const, name: tool.name, label: tool.label })),
    ...state.activeToolPolicy.external
      .filter(tool => !tool.enabled)
      .map(tool => ({ kind: "external" as const, name: tool.name, label: tool.label })),
  ];
}

export function hasFocusedConversationDisabledTools(state: RenderState): boolean {
  return focusedConversationDisabledTools(state).length > 0;
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
  if (task.kind === "goal" && task.goalStatus === "paused") return null;

  if (task.kind === "chrono" && task.chronoMode !== "wait" && task.dueAt !== undefined) {
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

function taskColor(state: RenderState, toolName: "exo" | "bash" | "goal" | "chrono", fallback: string): string {
  const color = state.toolRegistry.find(tool => tool.name === toolName)?.color ?? fallback;
  return hexToAnsi(color);
}

function cleanPanelText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
}

function disabledToolDisplay(
  state: RenderState,
  tool: DisabledToolEntry,
): { label: string; color: string } {
  if (tool.kind === "internal") {
    const style = state.toolRegistry.find(candidate => candidate.name === tool.name);
    // Bash's compact invocation label is "$", but the policy row is a list of
    // tool identities, where "Bash" is substantially clearer.
    const rawLabel = tool.name === "bash" ? "Bash" : style?.label ?? tool.label ?? tool.name;
    return {
      label: cleanPanelText(rawLabel) || tool.name,
      color: style ? hexToAnsi(style.color) : theme.tool,
    };
  }

  const style = state.externalToolStyles.find(candidate => candidate.cmd === tool.name);
  return {
    label: cleanPanelText(style?.label ?? tool.label ?? tool.name) || tool.name,
    color: style ? hexToAnsi(style.color) : theme.tool,
  };
}

interface DisabledToolGroupLayout {
  kind: ToolPolicyKind;
  tools: DisabledToolEntry[];
  lines: string[];
  /** Wrapped rows for prefixes of one through tools.length items. */
  prefixLines: string[][];
}

/** Wrap one independently colored comma-list without abbreviating tool names. */
function wrapDisabledToolGroup(state: RenderState, tools: DisabledToolEntry[], width: number): string[] {
  const bodyWidth = Math.max(1, width - 2);
  const rows: string[] = [];
  let body = "";
  let bodyUsed = 0;

  const pushBody = (value: string) => {
    const prefix = rows.length === 0 ? `${theme.muted}⊘ ` : `${theme.muted}  `;
    const line = `${prefix}${value}${theme.muted}`;
    rows.push(line + " ".repeat(Math.max(0, width - visibleLength(line))));
  };

  const flush = () => {
    if (!body) return;
    pushBody(body);
    body = "";
    bodyUsed = 0;
  };

  for (let index = 0; index < tools.length; index++) {
    const { label, color } = disabledToolDisplay(state, tools[index]);
    const comma = index < tools.length - 1 ? "," : "";
    const token = `${color}${label}${theme.muted}${comma}`;
    const tokenWidth = termWidth(label) + termWidth(comma);
    const separator = body ? " " : "";

    if (bodyUsed + termWidth(separator) + tokenWidth <= bodyWidth) {
      body += `${separator}${token}`;
      bodyUsed += termWidth(separator) + tokenWidth;
      continue;
    }

    flush();
    if (tokenWidth <= bodyWidth) {
      body = token;
      bodyUsed = tokenWidth;
      continue;
    }

    // Manifest labels can themselves exceed the card width. The generic ANSI
    // wrapper preserves the item's active display color across hard wraps.
    const wrapped = wrapAnsiLine(token, bodyWidth).lines;
    for (let wrappedIndex = 0; wrappedIndex < wrapped.length - 1; wrappedIndex++) {
      pushBody(wrapped[wrappedIndex]);
    }
    body = wrapped.at(-1) ?? "";
    bodyUsed = visibleLength(body);
    if (bodyUsed >= bodyWidth) flush();
  }

  flush();
  return rows;
}

function layoutDisabledToolGroups(
  state: RenderState,
  tools: DisabledToolEntry[],
  width: number,
): DisabledToolGroupLayout[] {
  return (["internal", "external"] as const).flatMap((kind) => {
    const groupTools = tools.filter(tool => tool.kind === kind);
    if (groupTools.length === 0) return [];
    const prefixLines = groupTools.map((_, index) => wrapDisabledToolGroup(state, groupTools.slice(0, index + 1), width));
    return [{ kind, tools: groupTools, lines: prefixLines.at(-1) ?? [], prefixLines }];
  });
}

/** Fit complete tool names into a vertical row budget, preserving group order. */
function fitDisabledToolGroups(
  groups: DisabledToolGroupLayout[],
  rowSlots: number,
): DisabledToolGroupLayout[] {
  const visible: DisabledToolGroupLayout[] = [];
  let remaining = Math.max(0, rowSlots);

  for (const group of groups) {
    let visibleToolCount = 0;
    for (let count = group.tools.length; count >= 1; count--) {
      if (group.prefixLines[count - 1].length <= remaining) {
        visibleToolCount = count;
        break;
      }
    }
    if (visibleToolCount === 0) break;
    const lines = group.prefixLines[visibleToolCount - 1];
    visible.push({
      kind: group.kind,
      tools: group.tools.slice(0, visibleToolCount),
      lines,
      prefixLines: group.prefixLines.slice(0, visibleToolCount),
    });
    remaining -= lines.length;
    if (visibleToolCount < group.tools.length) break;
  }
  return visible;
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

type PanelSectionTitle = "Tasks" | "Subscriptions" | "Disabled Tools";

interface VisiblePanelContent {
  tasks: TaskPanelEntry[];
  integrations: ExternalIntegrationSummary[];
  disabledToolGroups: DisabledToolGroupLayout[];
  hiddenCount: number;
  headerTitle: PanelSectionTitle;
  showSubscriptionsDivider: boolean;
  showDisabledToolsDivider: boolean;
}

/** Preserve the established two-section fitting exactly when tools are normal. */
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
      disabledToolGroups: [],
      hiddenCount: totalEntries - visibleCount,
      headerTitle,
      showSubscriptionsDivider: false,
      showDisabledToolsDivider: false,
    };
  }

  if (totalEntries + 1 <= maxContentRows) {
    return {
      tasks,
      integrations,
      disabledToolGroups: [],
      hiddenCount: 0,
      headerTitle,
      showSubscriptionsDivider: true,
      showDisabledToolsDivider: false,
    };
  }

  if (maxContentRows < 2) {
    return {
      tasks: [],
      integrations: [],
      disabledToolGroups: [],
      hiddenCount: 0,
      headerTitle,
      showSubscriptionsDivider: true,
      showDisabledToolsDivider: false,
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
    disabledToolGroups: [],
    hiddenCount: totalEntries - visibleTaskCount - visibleIntegrationCount,
    headerTitle,
    showSubscriptionsDivider: true,
    showDisabledToolsDivider: false,
  };
}

/**
 * Fit all three sections while keeping disabled tools visible under pressure.
 * They are the exceptional state this section exists to surface, followed by
 * durable subscriptions and finally transient task rows.
 */
function fitPanelContent(
  tasks: TaskPanelEntry[],
  integrations: ExternalIntegrationSummary[],
  disabledToolGroups: DisabledToolGroupLayout[],
  maxContentRows: number,
): VisiblePanelContent {
  if (disabledToolGroups.length === 0) return fitTasksAndSubscriptions(tasks, integrations, maxContentRows);

  const disabledToolCount = disabledToolGroups.reduce((count, group) => count + group.tools.length, 0);
  const totalEntries = tasks.length + integrations.length + disabledToolCount;
  const headerTitle: PanelSectionTitle = tasks.length > 0
    ? "Tasks"
    : integrations.length > 0
      ? "Subscriptions"
      : "Disabled Tools";
  const showSubscriptionsDivider = tasks.length > 0 && integrations.length > 0;
  const showDisabledToolsDivider = tasks.length > 0 || integrations.length > 0;
  const dividerRows = Number(showSubscriptionsDivider) + Number(showDisabledToolsDivider);

  const disabledToolRows = disabledToolGroups.reduce((count, group) => count + group.lines.length, 0);
  const totalRows = tasks.length + integrations.length + disabledToolRows + dividerRows;
  if (totalRows <= maxContentRows) {
    return {
      tasks,
      integrations,
      disabledToolGroups,
      hiddenCount: 0,
      headerTitle,
      showSubscriptionsDivider,
      showDisabledToolsDivider,
    };
  }

  // Reserve the final content row for overflow. If the card is too short even
  // for both earlier dividers and one disabled tool, promote Disabled Tools to
  // the header rather than rendering section labels with no useful anomaly.
  const entrySlots = maxContentRows - dividerRows - 1;
  if (entrySlots < 1) {
    const visibleDisabledGroups = fitDisabledToolGroups(disabledToolGroups, maxContentRows - 1);
    const visibleDisabledCount = visibleDisabledGroups.reduce((count, group) => count + group.tools.length, 0);
    return {
      tasks: [],
      integrations: [],
      disabledToolGroups: visibleDisabledGroups,
      hiddenCount: totalEntries - visibleDisabledCount,
      headerTitle: "Disabled Tools",
      showSubscriptionsDivider: false,
      showDisabledToolsDivider: false,
    };
  }

  const visibleDisabledGroups = fitDisabledToolGroups(disabledToolGroups, entrySlots);
  const visibleDisabledCount = visibleDisabledGroups.reduce((count, group) => count + group.tools.length, 0);
  const visibleDisabledRows = visibleDisabledGroups.reduce((count, group) => count + group.lines.length, 0);
  let remaining = visibleDisabledCount === disabledToolCount ? entrySlots - visibleDisabledRows : 0;
  const visibleIntegrationCount = Math.min(integrations.length, remaining);
  remaining -= visibleIntegrationCount;
  const visibleTaskCount = Math.min(tasks.length, remaining);

  return {
    tasks: tasks.slice(0, visibleTaskCount),
    integrations: integrations.slice(0, visibleIntegrationCount),
    disabledToolGroups: visibleDisabledGroups,
    hiddenCount: totalEntries - visibleTaskCount - visibleIntegrationCount - visibleDisabledCount,
    headerTitle,
    showSubscriptionsDivider,
    showDisabledToolsDivider,
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
  const disabledTools = focusedConversationDisabledTools(state);
  const totalEntries = tasks.length + integrations.length + disabledTools.length;
  const panelHeight = Math.min(maxHeight, MAX_TASK_PANEL_HEIGHT);
  if (totalEntries === 0 || chatWidth < MIN_PANEL_WIDTH || panelHeight < 3) return null;

  const panelWidth = Math.min(MAX_PANEL_WIDTH, chatWidth);
  const innerWidth = panelWidth - 2;
  const maxContentRows = panelHeight - 2;
  const disabledToolGroups = layoutDisabledToolGroups(state, disabledTools, innerWidth - 2);
  const visible = fitPanelContent(tasks, integrations, disabledToolGroups, maxContentRows);

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

  if (visible.showDisabledToolsDivider) {
    const sectionTitle = "Disabled Tools";
    const sectionCount = String(disabledTools.length);
    const sectionLeft = `─ ${sectionTitle} `;
    const sectionRight = ` ${sectionCount} ─`;
    const sectionFill = "─".repeat(Math.max(0, innerWidth - termWidth(sectionLeft) - termWidth(sectionRight)));
    lines.push(withPanelBg(
      `${outline}├─ ${theme.reset}${theme.muted}${sectionTitle}${outline} ${sectionFill}`
      + `${theme.reset}${theme.muted} ${sectionCount}${outline} ─┤`,
    ));
  }

  for (const group of visible.disabledToolGroups) {
    for (const wrappedLine of group.lines) {
      lines.push(withPanelBg(
        `${outline}│${theme.reset} ${wrappedLine}${theme.reset} ${outline}│`,
      ));
    }
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
