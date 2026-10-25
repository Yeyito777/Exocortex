import { getMarkFromTitle } from "../marks";
import { conversationActivityIndicator } from "./activityindicator";
import { areConversationNotificationsMuted, areFolderNotificationsMuted, currentFolder } from "./folders";
import { sameSidebarItem as sameItem, sidebarItemKey as itemKey } from "./items";
import { SIDEBAR_WIDTH } from "./layout";
import {
  getSidebarPromptAutocompleteRows,
  getSidebarPromptBar,
  sidebarPromptAutocompleteVisibleRows,
} from "./prompt";
import { buildDisplayRows, revealPrecedingSectionLabel, sidebarListRows, sidebarUpdateRows } from "./rows";
import { selectedDisplayRow, selectedVisualItems } from "./selection";
import type { SidebarState } from "./state";
import { isTreeFolderView } from "./tree";
import {
  getSearchableConversationTitle,
  getSidebarSearchBarViewport,
} from "../sidebarsearch";
import { theme } from "../theme";
import { conversationWorkCounts, hasInProgressModelWork, inlineLongSleepStartedAt, isDurablySleeping, shouldDisplayConversationTask } from "../taskvisibility";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { sanitizeUntrustedLabel } from "../terminaltext";
import type { ConversationTaskSummary } from "../messages";
import type { DisplayUpdateStatus } from "../update-status";

const UPDATE_LABELS: Record<DisplayUpdateStatus, string> = {
  checking: "Checking…",
  none: "None",
  update_available: "Update available",
  restart_needed: "Restart needed",
  disabled: "Disabled",
  unknown: "Unknown",
};

interface FolderAggregate {
  count: number;
  streamingCount: number;
  longSleep: boolean;
  globalIdle: boolean;
  unread: boolean;
  unreadCount: number;
  subagentCount: number;
  backgroundTaskCount: number;
  chronoTaskCount: number;
}

function countChronoTasks(tasks: readonly ConversationTaskSummary[] | undefined): number {
  let count = 0;
  for (const task of tasks ?? []) {
    // A sleep is represented by the blue streaming or yellow long-sleep
    // indicator rather than an additional green Chrono badge.
    if (task.kind !== "chrono" || task.chronoMode === "sleep" || !shouldDisplayConversationTask(task)) continue;
    count++;
  }
  return count;
}

/** Every input buildFolderAggregates reads, in order. */
function collectFolderAggregateInputs(
  sidebar: SidebarState,
  globalIdleConvIds: ReadonlySet<string>,
  optimisticStreamingConvId: string | null,
  out: unknown[],
): void {
  out.push(optimisticStreamingConvId, sidebar.partial, sidebar.folders.length);
  for (const folder of sidebar.folders) out.push(folder.id, folder.parentId);
  out.push(sidebar.conversations.length);
  for (const conv of sidebar.conversations) {
    out.push(conv.id, conv.folderId, conv.streaming, conv.unread, conv.tasks,
      conv.subagentCount, conv.backgroundTaskCount, globalIdleConvIds.has(conv.id));
  }
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface FolderAggregateCache {
  inputs: unknown[];
  aggregates: Map<string, FolderAggregate>;
}

/**
 * Aggregates walk every conversation, so they are reused while their inputs
 * are unchanged; with thousands of conversations this was most of each frame.
 * Summaries are updated in place in places, so inputs are compared by value.
 */
const folderAggregateCaches = new WeakMap<SidebarState, FolderAggregateCache>();
let folderAggregateScratch: unknown[] = [];

function folderAggregatesFor(
  sidebar: SidebarState,
  globalIdleConvIds: ReadonlySet<string>,
  optimisticStreamingConvId: string | null,
): Map<string, FolderAggregate> {
  const inputs = folderAggregateScratch;
  inputs.length = 0;
  collectFolderAggregateInputs(sidebar, globalIdleConvIds, optimisticStreamingConvId, inputs);
  const cached = folderAggregateCaches.get(sidebar);
  if (cached && sameInputs(cached.inputs, inputs)) return cached.aggregates;
  const aggregates = buildFolderAggregates(sidebar, globalIdleConvIds, optimisticStreamingConvId);
  folderAggregateScratch = cached?.inputs ?? [];
  folderAggregateCaches.set(sidebar, { inputs, aggregates });
  return aggregates;
}

function buildFolderAggregates(
  sidebar: SidebarState,
  globalIdleConvIds: ReadonlySet<string>,
  optimisticStreamingConvId: string | null,
): Map<string, FolderAggregate> {
  const aggregates = new Map<string, FolderAggregate>();
  const parentById = new Map<string, string | null>();
  for (const folder of sidebar.folders) {
    aggregates.set(folder.id, {
      count: 0,
      streamingCount: 0,
      longSleep: false,
      globalIdle: false,
      unread: false,
      unreadCount: 0,
      subagentCount: 0,
      backgroundTaskCount: 0,
      chronoTaskCount: 0,
    });
    parentById.set(folder.id, folder.parentId ?? null);
  }

  const lastVisitedBy = new Map<string, object>();
  for (const conv of sidebar.conversations) {
    const hasGlobalIdle = globalIdleConvIds.has(conv.id);
    const hasOptimisticStreaming = conv.id === optimisticStreamingConvId;
    const hasInlineSleep = inlineLongSleepStartedAt(conv) !== null;
    const hasLongSleep = hasInlineSleep || isDurablySleeping(conv);
    const hasModelWork = hasInProgressModelWork(conv) || hasOptimisticStreaming;
    const hasUnread = conv.unread && !hasModelWork;
    const chronoTaskCount = countChronoTasks(conv.tasks);
    const work = conversationWorkCounts(conv);
    let folderId = conv.folderId ?? null;
    // Guards against a parent cycle without allocating a set per conversation.
    while (folderId && aggregates.has(folderId) && lastVisitedBy.get(folderId) !== conv) {
      lastVisitedBy.set(folderId, conv);
      const aggregate = aggregates.get(folderId)!;
      aggregate.count++;
      if ((conv.streaming || hasOptimisticStreaming) && !hasInlineSleep) aggregate.streamingCount++;
      aggregate.longSleep ||= hasLongSleep;
      aggregate.globalIdle ||= hasGlobalIdle;
      aggregate.unread ||= hasUnread;
      if (hasUnread) aggregate.unreadCount++;
      aggregate.subagentCount += work.subagents;
      aggregate.backgroundTaskCount += work.commands;
      aggregate.chronoTaskCount += chronoTaskCount;
      folderId = parentById.get(folderId) ?? null;
    }
  }

  // Until the rest of a first page arrives, its counts come from the daemon.
  const counts = sidebar.partial?.folderConversationCounts;
  if (counts) for (const [folderId, aggregate] of aggregates) aggregate.count = counts[folderId] ?? aggregate.count;
  return aggregates;
}

function renderNotificationBadge(count: number): { text: string; width: number } | null {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  const rawText = ` ${label} `;
  return {
    text: `${theme.notificationBg}${theme.notificationFg}${rawText}${theme.reset}`,
    width: termWidth(rawText),
  };
}

function countedActivityIndicator(symbol: string, count: number): string {
  if (count <= 0) return "";
  if (count === 1) return `${symbol} `;
  return count > 99 ? `${symbol}99+ ` : `${symbol}${count} `;
}

function subagentIndicator(count: number): string {
  return countedActivityIndicator("◆", count);
}

function backgroundTaskIndicator(count: number): string {
  return countedActivityIndicator("$", count);
}

function chronoTaskIndicator(count: number): string {
  return countedActivityIndicator("◷", count);
}

function folderStreamingIndicator(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "◉ ";
  return count > 99 ? "◉99+ " : `◉${count} `;
}

function truncateSidebarTitle(text: string, maxWidth: number): string {
  // Folder names and titles come from the daemon, which takes them from any client.
  return truncateToWidth(sanitizeUntrustedLabel(text), maxWidth);
}

function contextualSidebarTitle(folderName: string | null, maxWidth: number): string {
  if (folderName === null) return truncateSidebarTitle("Conversations", maxWidth);
  if (maxWidth <= 1) return "/";
  return `${truncateSidebarTitle(folderName, maxWidth - 1)}/`;
}

/** Columns each tree-view nesting level is indented by. */
const TREE_INDENT = "  ";

/** Pad or truncate a string to exactly `width` terminal columns. */
function pad(text: string, width: number): string {
  return padRightToWidth(text, width);
}

export function renderSidebar(
  sidebar: SidebarState,
  totalRows: number,
  focused: boolean,
  currentConvId: string | null,
  globalIdleConvIds: ReadonlySet<string> = new Set(),
  optimisticStreamingConvId: string | null = null,
  remoteAlias: string | null = null,
): string[] {
  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1; // -1 for right border │
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;
  const borderBg = theme.appBg ?? '';

  // Row 1: header / breadcrumb. The tree view shows every level at once.
  const treeView = isTreeFolderView(sidebar);
  const folder = treeView ? null : currentFolder(sidebar);
  const separator = " — ";
  const aliasMaxWidth = Math.min(12, innerWidth - termWidth(` ${separator}`) - 1);
  const alias = remoteAlias
    ? truncateSidebarTitle(remoteAlias, aliasMaxWidth)
    : "";
  const titleMaxWidth = alias
    ? innerWidth - termWidth(` ${separator}${alias}`)
    : innerWidth - 1;
  const title = contextualSidebarTitle(folder?.name ?? null, titleMaxWidth);
  const headerPlain = alias ? ` ${title}${separator}${alias}` : ` ${title}`;
  const headerPadding = " ".repeat(Math.max(0, innerWidth - termWidth(headerPlain)));
  const headerStyled = alias
    ? `${theme.text}${theme.bold} ${title}${separator}${theme.goal}${alias}${headerPadding}`
    : `${theme.text}${theme.bold}${pad(headerPlain, innerWidth)}`;
  rows.push(
    theme.sidebarBg + headerStyled
    + theme.reset + borderBg + borderFg + "│" + theme.reset,
  );

  // Row 2: separator with ┤ junction
  rows.push(
    theme.sidebarBg + borderFg +
    "─".repeat(innerWidth) + borderBg + "┤" + theme.reset,
  );

  // Build display rows: section labels + delimiter + sidebar entries
  const convs = sidebar.conversations;
  const displayRows = buildDisplayRows(sidebar);
  const folderAggregates = sidebar.folders.length > 0
    ? folderAggregatesFor(sidebar, globalIdleConvIds, optimisticStreamingConvId)
    : null;
  // Compute visual selection once per render. Calling selectedVisualItems() per
  // row rebuilds displayRows each time; with an active /? filter this made `v`
  // feel very laggy on large conversation lists.
  const visualItems = sidebar.visualAnchor ? selectedVisualItems(sidebar) : [];
  const visualItemKeys = new Set(visualItems.map((item) => itemKey(item)));
  const pendingDeleteKeys = new Set<string>();
  const pendingDeleteKey = itemKey(sidebar.pendingDeleteItem);
  if (pendingDeleteKey) {
    if (sidebar.visualAnchor && visualItemKeys.has(pendingDeleteKey)) {
      for (const key of visualItemKeys) {
        if (key) pendingDeleteKeys.add(key);
      }
    } else {
      pendingDeleteKeys.add(pendingDeleteKey);
    }
  }

  // Map selected item to display row index for scroll tracking
  const selectedDisplayIdx = selectedDisplayRow(displayRows, sidebar);

  const listRows = sidebarListRows(totalRows, sidebar);
  let scrollOffset = sidebar.scrollOffset;
  if (selectedDisplayIdx < scrollOffset) {
    scrollOffset = revealPrecedingSectionLabel(displayRows, selectedDisplayIdx);
  } else if (selectedDisplayIdx >= scrollOffset + listRows) {
    scrollOffset = selectedDisplayIdx - listRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, displayRows.length - listRows)));
  sidebar.scrollOffset = scrollOffset;

  for (let i = 0; i < listRows; i++) {
    const di = scrollOffset + i;

    if (di >= displayRows.length) {
      // Empty row
      rows.push(
        theme.sidebarBg +
        " ".repeat(innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    const dr = displayRows[di];

    if (dr.type === "label") {
      rows.push(
        theme.sidebarBg + theme.text + theme.bold +
        pad(dr.text!, innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    if (dr.type === "delimiter") {
      const indent = TREE_INDENT.repeat(dr.depth ?? 0);
      rows.push(
        theme.sidebarBg + theme.muted +
        pad(" " + indent + "─".repeat(Math.max(0, innerWidth - 2 - termWidth(indent))) + " ", innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    // Entry row
    const item = dr.item ?? null;
    const isSelected = sameItem(sidebar.selectedItem, item);
    const itemVisualKey = item?.type === "up" ? null : itemKey(item);
    const isVisual = itemVisualKey !== null && visualItemKeys.has(itemVisualKey);
    const isPendingDelete = itemVisualKey !== null && pendingDeleteKeys.has(itemVisualKey);
    const prefix = (isSelected ? "▸ " : isVisual ? "│ " : "  ") + TREE_INDENT.repeat(dr.depth ?? 0);

    let streamIcon = "";
    let streamIconColor = "";
    let subagentIcon = "";
    let backgroundTaskIcon = "";
    let chronoTaskIcon = "";
    let starIcon = "";
    let emojiIcon = "";
    let rawTitle = "";
    let isCurrent = false;
    let itemFg = theme.muted;
    let notificationCount = 0;
    let notificationsMuted = false;
    let explicitlyMuted = false;

    if (item?.type === "up") {
      rawTitle = "..";
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "folder") {
      const folder = sidebar.folders[dr.folderIdx ?? -1];
      const aggregate = folder ? folderAggregates?.get(folder.id) : null;
      notificationsMuted = folder ? areFolderNotificationsMuted(sidebar, folder.id) : false;
      explicitlyMuted = folder?.muted === true;
      const isOpenTreeFolder = treeView && folder !== undefined && sidebar.expandedFolderIds.has(folder.id);
      const icon = isOpenTreeFolder ? "📂" : "📁";
      if (isOpenTreeFolder) {
        // An open folder's children are listed right below with their own
        // badges, so its aggregate badges and count would only repeat them.
        rawTitle = `${icon} ${folder.name}/`;
      } else {
        rawTitle = folder ? `${icon} ${folder.name}/ ${aggregate?.count ?? 0}` : `${icon} folder/`;
        const streamingCount = aggregate?.streamingCount ?? 0;
        const hasLongSleep = aggregate?.longSleep ?? false;
        const hasGlobalIdle = aggregate?.globalIdle ?? false;
        const hasUnread = !notificationsMuted && (aggregate?.unread ?? false);
        const hasWarningActivity = hasLongSleep || hasGlobalIdle;
        streamIcon = streamingCount > 0 ? folderStreamingIndicator(streamingCount) : hasWarningActivity ? "◉ " : hasUnread ? "◉ " : "";
        streamIconColor = streamingCount > 0 ? theme.accent : hasWarningActivity ? theme.warning : hasUnread ? theme.success : "";
        subagentIcon = subagentIndicator(aggregate?.subagentCount ?? 0);
        backgroundTaskIcon = backgroundTaskIndicator(aggregate?.backgroundTaskCount ?? 0);
        chronoTaskIcon = chronoTaskIndicator(aggregate?.chronoTaskCount ?? 0);
        notificationCount = notificationsMuted ? 0 : aggregate?.unreadCount ?? 0;
      }
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "conversation") {
      const conv = convs[dr.convIdx ?? -1];
      if (!conv) continue;
      notificationsMuted = areConversationNotificationsMuted(sidebar, conv);
      explicitlyMuted = conv.muted === true;
      isCurrent = conv.id === currentConvId;
      // Direct sends create pendingAI before IPC. Reflect that local accepted
      // input immediately instead of leaving the sidebar idle while a cold
      // canonical transcript is loaded and durably appended by the daemon.
      const indicator = conversationActivityIndicator(conv, {
        globalIdle: globalIdleConvIds.has(conv.id),
        optimisticStreaming: conv.id === optimisticStreamingConvId,
        notificationsMuted,
      });
      streamIcon = indicator.icon;
      streamIconColor = indicator.color;
      const work = conversationWorkCounts(conv);
      subagentIcon = subagentIndicator(work.subagents);
      backgroundTaskIcon = backgroundTaskIndicator(work.commands);
      chronoTaskIcon = chronoTaskIndicator(countChronoTasks(conv.tasks));
      starIcon = conv.marked ? "★ " : "";
      const mark = getMarkFromTitle(conv.title);
      emojiIcon = mark ? mark.emoji + " " : "";
      rawTitle = getSearchableConversationTitle(conv) || "(empty)";
      itemFg = (isSelected || isCurrent) ? theme.text : theme.muted;
    }

    const iconsWidth = termWidth(chronoTaskIcon) + termWidth(subagentIcon) + termWidth(backgroundTaskIcon)
      + termWidth(starIcon) + termWidth(emojiIcon);
    const prefixWidth = termWidth(prefix) + termWidth(streamIcon) + iconsWidth;
    // The bell represents this item's durable preference, not the effective
    // notification policy inherited from its folder path. Inherited muting
    // still suppresses unread indicators and badges below.
    const muteIcon = explicitlyMuted ? " 🔕" : "";
    const notificationBadge = notificationsMuted ? null : renderNotificationBadge(notificationCount);
    const badgeGap = notificationBadge ? 1 : 0;
    const badgeWidth = notificationBadge?.width ?? 0;
    const suffixWidth = termWidth(muteIcon) + badgeGap + badgeWidth;
    const maxTitle = Math.max(0, innerWidth - prefixWidth - suffixWidth);
    const title = truncateSidebarTitle(rawTitle, maxTitle);
    const bg = isSelected ? theme.sidebarSelBg : isVisual ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = isPendingDelete ? theme.error : itemFg;
    const paddedTitle = padRightToWidth(title, maxTitle);
    const titleText = isCurrent && !isPendingDelete ? theme.bold + paddedTitle + theme.boldOff : paddedTitle;
    const prefixText = isVisual && !isSelected && !isPendingDelete
      ? theme.muted + prefix + fg
      : prefix;
    const streamIconColored = streamIcon ? streamIconColor + streamIcon + fg : "";
    const subagentIconColored = subagentIcon ? theme.accent + subagentIcon + fg : "";
    const backgroundTaskIconColored = backgroundTaskIcon ? theme.warning + backgroundTaskIcon + fg : "";
    const chronoTaskIconColored = chronoTaskIcon ? theme.success + chronoTaskIcon + fg : "";
    const starIconColored = starIcon ? theme.warning + starIcon + fg : "";
    const emojiIconColored = emojiIcon ? theme.warning + emojiIcon + fg : "";

    rows.push(
      theme.reset + bg + fg +
      prefixText + streamIconColored + subagentIconColored + chronoTaskIconColored + backgroundTaskIconColored + starIconColored + emojiIconColored + titleText +
      muteIcon +
      (notificationBadge ? ` ${notificationBadge.text}` : "") +
      theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  if (sidebar.search?.barOpen) {
    const { line } = getSidebarSearchBarViewport(sidebar.search, innerWidth);
    rows.push(
      line +
      theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  } else if (sidebar.prompt) {
    const autocompleteRows = getSidebarPromptAutocompleteRows(
      sidebar.prompt,
      innerWidth,
      sidebarPromptAutocompleteVisibleRows(sidebar.prompt, Boolean(sidebar.search?.barOpen), totalRows),
    );
    for (const row of autocompleteRows) {
      rows.push(row + theme.reset + borderBg + borderFg + "│" + theme.reset);
    }
    rows.push(
      getSidebarPromptBar(sidebar.prompt, innerWidth) +
      theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  if (sidebarUpdateRows(totalRows, sidebar)) {
    // Keep the passive separator muted, but continue the sidebar's focused
    // straight right edge through the separator and status rows.
    const footerBorder = theme.borderUnfocused;
    rows.push(theme.sidebarBg + footerBorder + "─".repeat(innerWidth) + borderBg + borderFg + "│" + theme.reset);
    const status = sidebar.updateStatus!;
    const line = (prefix: string, value: DisplayUpdateStatus) => {
      const color = value === "update_available" || value === "restart_needed" ? theme.accent : theme.muted;
      const content = status.remote !== null
        ? theme.muted + prefix + color + pad(UPDATE_LABELS[value], innerWidth - termWidth(prefix))
        : color + pad(prefix + UPDATE_LABELS[value], innerWidth);
      rows.push(
        theme.sidebarBg + content +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
    };
    if (status.remote !== null) {
      line(" Remote: ", status.remote);
      line(" Local: ", status.local);
    } else {
      line(status.local === "restart_needed" ? " ↻ " : " ↑ ", status.local);
    }
  }

  return rows;
}
