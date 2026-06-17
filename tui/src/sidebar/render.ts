import { getMarkFromTitle } from "../marks";
import { currentFolder } from "./folders";
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
  unread: boolean;
}

function buildFolderAggregates(sidebar: SidebarState): Map<string, FolderAggregate> {
  const aggregates = new Map<string, FolderAggregate>();
  const parentById = new Map<string, string | null>();
  for (const folder of sidebar.folders) {
    aggregates.set(folder.id, { count: 0, streaming: false, unread: false });
    parentById.set(folder.id, folder.parentId ?? null);
  }

  for (const conv of sidebar.conversations) {
    let folderId = conv.folderId ?? null;
    const seen = new Set<string>();
    while (folderId && aggregates.has(folderId) && !seen.has(folderId)) {
      seen.add(folderId);
      const aggregate = aggregates.get(folderId)!;
      aggregate.count++;
      aggregate.streaming ||= conv.streaming;
      aggregate.unread ||= conv.unread;
      folderId = parentById.get(folderId) ?? null;
    }
  }

  return aggregates;
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
  const folderAggregates = sidebar.folders.length > 0 ? buildFolderAggregates(sidebar) : null;
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
    let starIcon = "";
    let emojiIcon = "";
    let rawTitle = "";
    let isCurrent = false;
    let itemFg = theme.muted;

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
      const hasUnread = aggregate?.unread ?? false;
      streamIcon = hasStreaming ? "◉ " : hasUnread ? "◉ " : "";
      streamIconColor = hasStreaming ? theme.accent : hasUnread ? theme.success : "";
      itemFg = isSelected ? theme.text : theme.muted;
    } else if (item?.type === "conversation") {
      const conv = convs[dr.convIdx ?? -1];
      if (!conv) continue;
      isCurrent = conv.id === currentConvId;
      streamIcon = conv.streaming ? "◉ " : conv.unread ? "◉ " : "";
      streamIconColor = conv.streaming ? theme.accent : conv.unread ? theme.success : "";
      starIcon = conv.marked ? "★ " : "";
      const mark = getMarkFromTitle(conv.title);
      emojiIcon = mark ? mark.emoji + " " : "";
      rawTitle = getSearchableConversationTitle(conv) || "(empty)";
      itemFg = (isSelected || isCurrent) ? theme.text : theme.muted;
    }

    const iconsWidth = termWidth(starIcon) + termWidth(emojiIcon);
    const prefixWidth = termWidth(prefix) + termWidth(streamIcon) + iconsWidth;
    const maxTitle = Math.max(0, innerWidth - prefixWidth);
    const title = truncateSidebarTitle(rawTitle, maxTitle);
    const bg = isSelected ? theme.sidebarSelBg : isVisual ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = isPendingDelete ? theme.error : itemFg;
    const paddedTitle = padRightToWidth(title, maxTitle);
    const titleText = isCurrent && !isPendingDelete ? theme.bold + paddedTitle + theme.boldOff : paddedTitle;
    const prefixText = isVisual && !isSelected && !isPendingDelete
      ? theme.muted + prefix + fg
      : prefix;
    const streamIconColored = streamIcon ? streamIconColor + streamIcon + fg : "";
    const starIconColored = starIcon ? theme.warning + starIcon + fg : "";
    const emojiIconColored = emojiIcon ? theme.warning + emojiIcon + fg : "";

    rows.push(
      theme.reset + bg + fg +
      prefixText + streamIconColored + starIconColored + emojiIconColored + titleText +
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
