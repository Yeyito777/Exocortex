import { toggleMark } from "../marks";
import { getSelectedVisibleConversation } from "./selection";
import type { SidebarState } from "./state";
import type { SidebarKeyResult } from "./types";

/**
 * Toggle an emoji mark on the selected conversation.
 * key 1-9 sets (or toggles off) the corresponding mark.
 * key 0 clears any mark.
 */
export function handleSidebarMark(sidebar: SidebarState, key: number): SidebarKeyResult {
  const conv = getSelectedVisibleConversation(sidebar);
  if (!conv) return { type: "handled" };

  const newTitle = toggleMark(conv.title, key);
  if (newTitle === conv.title) return { type: "handled" };

  // Optimistic update
  conv.title = newTitle;
  return { type: "rename_conversation", convId: conv.id, title: newTitle };
}
