import { getMarkFromTitle } from "../marks";
import { currentFolder, subagentsFolderIds } from "./folders";
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
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";

interface FolderAggregate {
  count: number;
  streaming: boolean;
  globalIdle: boolean;
  unread: boolean;
  unreadCount: number;
  backgroundTaskCount: number;
}

function buildFolderAggregates(sidebar: SidebarState, globalIdleConvIds: ReadonlySet<string>): Map<string, FolderAggregate> {
  const aggregates = new Map<string, FolderAggregate>();
  const parentById = new Map<string, string | null>();
  for (const folder of sidebar.folders) {
    aggregates.set(folder.id, { count: 0, streaming: false, globalIdle: false, unread: false, unreadCount: 0, backgroundTaskCount: 0 });
    parentById.set(folder.id, folder.parentId ?? null);
  }

  for (const conv of sidebar.conversations) {
    const hasGlobalIdle = globalIdleConvIds.has(conv.id);
    let folderId = conv.folderId ?? null;
    const seen = new Set<string>();
    while (folderId && aggregates.has(folderId) && !seen.has(folderId)) {
      seen.add(folderId);
      const aggregate = aggregates.get(folderId)!;
      aggregate.count++;
      aggregate.streaming ||= conv.streaming;
      aggregate.globalIdle ||= hasGlobalIdle;
      aggregate.unread ||= conv.unread;
      if (conv.unread) aggregate.unreadCount++;
      aggregate.backgroundTaskCount += conv.backgroundTaskCount ?? 0;
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

function backgroundTaskIndicator(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "$ ";
  return count > 99 ? "$99+ " : `$${count} `;
}

function truncateSidebarTitle(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth);
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
): string[] {
  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1; // -1 for right border │
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;
  const borderBg = theme.appBg ?? '';

  // Row 1: header / breadcrumb
  const folder = currentFolder(sidebar);
  const header = folder ? ` ${truncateSidebarTitle(folder.name, innerWidth - 1)}/` : " Conversations";
  rows.push(
    theme.sidebarBg + theme.text + theme.bold + pad(header, innerWidth)
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
  const folderAggregates = sidebar.folders.length > 0 ? buildFolderAggregates(sidebar, globalIdleConvIds) : null;
  const subagentFolderIds = sidebar.folders.length > 0 ? subagentsFolderIds(sidebar.folders) : new Set<string>();
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
    let taskIcon = "";
    let starIcon = "";
    let emojiIcon = "";
    let rawTitle = "";
    let isCurrent = false;
    let itemFg = theme.muted;
    let notificationCount = 0;

    if (item?.type === "up") {
      rawTitle = "..";
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "folder_instructions") {
      rawTitle = "📄 AGENTS.md";
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "folder") {
      const folder = sidebar.folders[dr.folderIdx ?? -1];
      const aggregate = folder ? folderAggregates?.get(folder.id) : null;
      rawTitle = folder ? `📁 ${folder.name}/ ${aggregate?.count ?? 0}` : "📁 folder/";
      const hasStreaming = aggregate?.streaming ?? false;
      const hasGlobalIdle = aggregate?.globalIdle ?? false;
      const hasUnread = (aggregate?.unread ?? false) && !(folder && subagentFolderIds.has(folder.id));
      streamIcon = hasStreaming ? "◉ " : hasGlobalIdle ? "◉ " : hasUnread ? "◉ " : "";
      streamIconColor = hasStreaming ? theme.accent : hasGlobalIdle ? theme.warning : hasUnread ? theme.success : "";
      taskIcon = backgroundTaskIndicator(aggregate?.backgroundTaskCount ?? 0);
      notificationCount = folder && !subagentFolderIds.has(folder.id) ? aggregate?.unreadCount ?? 0 : 0;
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "conversation") {
      const conv = convs[dr.convIdx ?? -1];
      if (!conv) continue;
      isCurrent = conv.id === currentConvId;
      const hasGlobalIdle = globalIdleConvIds.has(conv.id);
      const hasUnread = conv.unread && !(conv.folderId && subagentFolderIds.has(conv.folderId));
      streamIcon = conv.streaming ? "◉ " : hasGlobalIdle ? "◉ " : hasUnread ? "◉ " : "";
      streamIconColor = conv.streaming ? theme.accent : hasGlobalIdle ? theme.warning : hasUnread ? theme.success : "";
      taskIcon = backgroundTaskIndicator(conv.backgroundTaskCount ?? 0);
      starIcon = conv.marked ? "★ " : "";
      const mark = getMarkFromTitle(conv.title);
      emojiIcon = mark ? mark.emoji + " " : "";
      rawTitle = getSearchableConversationTitle(conv) || "(empty)";
      itemFg = (isSelected || isCurrent) ? theme.text : theme.muted;
    }

    const iconsWidth = termWidth(starIcon) + termWidth(emojiIcon);
    const prefixWidth = termWidth(prefix) + termWidth(streamIcon) + termWidth(taskIcon) + iconsWidth;
    const notificationBadge = renderNotificationBadge(notificationCount);
    const badgeGap = notificationBadge ? 1 : 0;
    const badgeWidth = notificationBadge?.width ?? 0;
    const maxTitle = Math.max(0, innerWidth - prefixWidth - badgeGap - badgeWidth);
    const title = truncateSidebarTitle(rawTitle, maxTitle);
    const bg = isSelected ? theme.sidebarSelBg : isVisual ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = isPendingDelete ? theme.error : itemFg;
    const paddedTitle = padRightToWidth(title, maxTitle);
    const titleText = isCurrent && !isPendingDelete ? theme.bold + paddedTitle + theme.boldOff : paddedTitle;
    const prefixText = isVisual && !isSelected && !isPendingDelete
      ? theme.muted + prefix + fg
      : prefix;
    const streamIconColored = streamIcon ? streamIconColor + streamIcon + fg : "";
    const taskIconColored = taskIcon ? theme.warning + taskIcon + fg : "";
    const starIconColored = starIcon ? theme.warning + starIcon + fg : "";
    const emojiIconColored = emojiIcon ? theme.warning + emojiIcon + fg : "";

    rows.push(
      theme.reset + bg + fg +
      prefixText + streamIconColored + taskIconColored + starIconColored + emojiIconColored + titleText +
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
