import type { EditMessageState } from "./state";
import { EDIT_INDEX_INSTRUCTIONS } from "./state";
import { termWidth, truncateToWidth } from "./textwidth";

export const EDIT_MESSAGE_TITLE = "Edit message:";

export interface EditMessageOverlayLayout {
  boxLeft: number;
  boxWidth: number;
  innerWidth: number;
  boxTop: number;
  firstItemRow: number;
  maxVisible: number;
  scrollStart: number;
  previews: string[];
}

function buildEditMessagePreviews(em: EditMessageState, maxPreviewLen: number): string[] {
  return em.items.map((item) => {
    const prefix = item.userMessageIndex === EDIT_INDEX_INSTRUCTIONS ? "📌 " : "";
    return truncateToWidth(prefix + item.text.replace(/\n/g, " "), maxPreviewLen);
  });
}

export function computeEditMessageOverlayLayout(
  em: EditMessageState,
  chatW: number,
  chatCol: number,
  sepRow: number,
  messageAreaHeight: number,
): EditMessageOverlayLayout | null {
  if (em.items.length === 0) return null;
  if (chatW <= 0 || chatCol <= 0 || sepRow <= 0) return null;

  const maxPreviewLen = Math.max(0, Math.min(50, chatW - 12));
  const previews = buildEditMessagePreviews(em, maxPreviewLen);
  const maxContentLen = Math.max(
    termWidth(EDIT_MESSAGE_TITLE),
    ...previews.map((preview) => termWidth(preview) + 2),
  );
  const innerWidth = Math.max(0, Math.min(maxContentLen + 4, chatW - 4));
  const boxWidth = innerWidth + 2;
  const boxLeft = chatCol + Math.floor((chatW - boxWidth) / 2);
  const maxVisible = Math.min(em.items.length, Math.max(3, messageAreaHeight - 4));

  let scrollStart = em.scrollOffset;
  if (em.selection < scrollStart) scrollStart = em.selection;
  if (em.selection >= scrollStart + maxVisible) scrollStart = em.selection - maxVisible + 1;
  scrollStart = Math.max(0, Math.min(scrollStart, em.items.length - maxVisible));

  const styledLineCount = 2 + maxVisible; // title, blank line, visible items
  const boxTop = Math.max(3, sepRow - styledLineCount - 2);

  return {
    boxLeft,
    boxWidth,
    innerWidth,
    boxTop,
    firstItemRow: boxTop + 3,
    maxVisible,
    scrollStart,
    previews,
  };
}
