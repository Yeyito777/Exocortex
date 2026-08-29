import { getMarkFromTitle } from "../marks";
import { areConversationNotificationsMuted, areFolderNotificationsMuted, currentFolder } from "./folders";
import { sameSidebarItem as sameItem, sidebarItemKey as itemKey } from "./items";
import { SIDEBAR_WIDTH } from "./layout";
import {
  getSidebarPromptAutocompleteRows,
  getSidebarPromptBar,
  sidebarPromptAutocompleteVisibleRows,
} from "./prompt";
import { buildDisplayRows, revealPrecedingSectionLabel, sidebarListRows } from "./rows";
import { selectedDisplayRow, selectedVisualItems } from "./selection";
import type { SidebarState } from "./state";
import {
  getSearchableConversationTitle,
  getSidebarSearchBarViewport,
} from "../sidebarsearch";
import { theme } from "../theme";
import { hasInProgressModelWork, isDurablySleeping, shouldDisplayConversationTask } from "../taskvisibility";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import type { ConversationTaskSummary } from "../messages";

interface FolderAggregate {
  count: number;
  streamingCount: number;
  goalReviewing: boolean;
  durableSleep: boolean;
  globalIdle: boolean;
  unread: boolean;
  unreadCount: number;
  subagentCount: number;
  backgroundTaskCount: number;
  chronoTaskCount: number;
  activeCallCount: number;
}

function countChronoTasks(tasks: readonly ConversationTaskSummary[] | undefined): number {
  let count = 0;
  for (const task of tasks ?? []) {
    // A sleep is represented by the blue connected-stream or yellow durable-
    // sleep indicator rather than an additional green Chrono badge.
    if (task.kind !== "chrono" || task.chronoMode === "sleep" || !shouldDisplayConversationTask(task)) continue;
    count++;
  }
  return count;
}

function buildFolderAggregates(
  sidebar: SidebarState,
  globalIdleConvIds: ReadonlySet<string>,
  optimisticStreamingConvId: string | null,
  activeCallConvIds: ReadonlySet<string>,
): Map<string, FolderAggregate> {
  const aggregates = new Map<string, FolderAggregate>();
  const parentById = new Map<string, string | null>();
  for (const folder of sidebar.folders) {
    aggregates.set(folder.id, {
      count: 0,
      streamingCount: 0,
      goalReviewing: false,
      durableSleep: false,
      globalIdle: false,
      unread: false,
      unreadCount: 0,
      subagentCount: 0,
      backgroundTaskCount: 0,
      chronoTaskCount: 0,
      activeCallCount: 0,
    });
    parentById.set(folder.id, folder.parentId ?? null);
  }

  for (const conv of sidebar.conversations) {
    const hasGlobalIdle = globalIdleConvIds.has(conv.id);
    const hasOptimisticStreaming = conv.id === optimisticStreamingConvId;
    const hasDurableSleep = isDurablySleeping(conv);
    const hasModelWork = hasInProgressModelWork(conv) || hasOptimisticStreaming;
    const hasUnread = conv.unread && !hasModelWork;
    const chronoTaskCount = countChronoTasks(conv.tasks);
    let folderId = conv.folderId ?? null;
    const seen = new Set<string>();
    while (folderId && aggregates.has(folderId) && !seen.has(folderId)) {
      seen.add(folderId);
      const aggregate = aggregates.get(folderId)!;
      aggregate.count++;
      if (conv.streaming || conv.goalReviewing || hasOptimisticStreaming) aggregate.streamingCount++;
      aggregate.goalReviewing ||= conv.goalReviewing === true;
      aggregate.durableSleep ||= hasDurableSleep;
      aggregate.globalIdle ||= hasGlobalIdle;
      aggregate.unread ||= hasUnread;
      if (hasUnread) aggregate.unreadCount++;
      aggregate.subagentCount += conv.subagentCount ?? 0;
      aggregate.backgroundTaskCount += conv.backgroundTaskCount ?? 0;
      aggregate.chronoTaskCount += chronoTaskCount;
      if (activeCallConvIds.has(conv.id)) aggregate.activeCallCount++;
      folderId = parentById.get(folderId) ?? null;
    }
  }

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
  return truncateToWidth(text, maxWidth);
}

function contextualSidebarTitle(folderName: string | null, maxWidth: number): string {
  if (folderName === null) return truncateSidebarTitle("Conversations", maxWidth);
  if (maxWidth <= 1) return "/";
  return `${truncateSidebarTitle(folderName, maxWidth - 1)}/`;
}

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
  activeCallConvIds: ReadonlySet<string> = new Set(),
  remoteAlias: string | null = null,
): string[] {
  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1; // -1 for right border │
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;
  const borderBg = theme.appBg ?? '';

  // Row 1: header / breadcrumb
  const folder = currentFolder(sidebar);
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
    ? buildFolderAggregates(sidebar, globalIdleConvIds, optimisticStreamingConvId, activeCallConvIds)
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
      rows.push(
        theme.sidebarBg + theme.muted +
        pad(" " + "─".repeat(innerWidth - 2) + " ", innerWidth) +
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
    const prefix = isSelected ? "▸ " : isVisual ? "│ " : "  ";

    let streamIcon = "";
    let streamIconColor = "";
    let subagentIcon = "";
    let backgroundTaskIcon = "";
    let chronoTaskIcon = "";
    let callIcon = "";
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
    } else if (item?.type === "folder_instructions") {
      rawTitle = "📄 AGENTS.md";
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "folder") {
      const folder = sidebar.folders[dr.folderIdx ?? -1];
      const aggregate = folder ? folderAggregates?.get(folder.id) : null;
      notificationsMuted = folder ? areFolderNotificationsMuted(sidebar, folder.id) : false;
      explicitlyMuted = folder?.muted === true;
      rawTitle = folder ? `📁 ${folder.name}/ ${aggregate?.count ?? 0}` : "📁 folder/";
      const streamingCount = aggregate?.streamingCount ?? 0;
      const goalReviewing = aggregate?.goalReviewing ?? false;
      const hasDurableSleep = aggregate?.durableSleep ?? false;
      const hasGlobalIdle = aggregate?.globalIdle ?? false;
      const hasUnread = !notificationsMuted && (aggregate?.unread ?? false);
      const hasWarningActivity = hasDurableSleep || hasGlobalIdle;
      streamIcon = streamingCount > 0 ? folderStreamingIndicator(streamingCount) : hasWarningActivity ? "◉ " : hasUnread ? "◉ " : "";
      streamIconColor = goalReviewing ? theme.goal : streamingCount > 0 ? theme.accent : hasWarningActivity ? theme.warning : hasUnread ? theme.success : "";
      subagentIcon = subagentIndicator(aggregate?.subagentCount ?? 0);
      backgroundTaskIcon = backgroundTaskIndicator(aggregate?.backgroundTaskCount ?? 0);
      chronoTaskIcon = chronoTaskIndicator(aggregate?.chronoTaskCount ?? 0);
      callIcon = countedActivityIndicator("☎", aggregate?.activeCallCount ?? 0);
      notificationCount = notificationsMuted ? 0 : aggregate?.unreadCount ?? 0;
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "conversation") {
      const conv = convs[dr.convIdx ?? -1];
      if (!conv) continue;
      notificationsMuted = areConversationNotificationsMuted(sidebar, conv);
      explicitlyMuted = conv.muted === true;
      isCurrent = conv.id === currentConvId;
      const hasGlobalIdle = globalIdleConvIds.has(conv.id);
      // Direct sends create pendingAI before IPC. Reflect that local accepted
      // input immediately instead of leaving the sidebar idle while a cold
      // canonical transcript is loaded and durably appended by the daemon.
      const hasOptimisticStreaming = conv.id === optimisticStreamingConvId;
      const hasDurableSleep = isDurablySleeping(conv);
      const hasModelWork = hasInProgressModelWork(conv) || hasOptimisticStreaming;
      const hasUnread = !notificationsMuted && conv.unread && !hasModelWork;
      const hasStreamingIndicator = conv.streaming || conv.goalReviewing === true || hasOptimisticStreaming;
      const hasWarningActivity = hasDurableSleep || hasGlobalIdle;
      streamIcon = hasStreamingIndicator ? "◉ " : hasWarningActivity ? "◉ " : hasUnread ? "◉ " : "";
      streamIconColor = conv.goalReviewing === true ? theme.goal : hasStreamingIndicator ? theme.accent : hasWarningActivity ? theme.warning : hasUnread ? theme.success : "";
      subagentIcon = subagentIndicator(conv.subagentCount ?? 0);
      backgroundTaskIcon = backgroundTaskIndicator(conv.backgroundTaskCount ?? 0);
      chronoTaskIcon = chronoTaskIndicator(countChronoTasks(conv.tasks));
      callIcon = activeCallConvIds.has(conv.id) ? "☎ " : "";
      starIcon = conv.marked ? "★ " : "";
      const mark = getMarkFromTitle(conv.title);
      emojiIcon = mark ? mark.emoji + " " : "";
      rawTitle = getSearchableConversationTitle(conv) || "(empty)";
      itemFg = (isSelected || isCurrent) ? theme.text : theme.muted;
    }

    const iconsWidth = termWidth(callIcon) + termWidth(chronoTaskIcon) + termWidth(subagentIcon) + termWidth(backgroundTaskIcon)
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
    const callIconColored = callIcon ? theme.tool + callIcon + fg : "";
    const starIconColored = starIcon ? theme.warning + starIcon + fg : "";
    const emojiIconColored = emojiIcon ? theme.warning + emojiIcon + fg : "";

    rows.push(
      theme.reset + bg + fg +
      prefixText + streamIconColored + callIconColored + chronoTaskIconColored + subagentIconColored + backgroundTaskIconColored + starIconColored + emojiIconColored + titleText +
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

  return rows;
}
