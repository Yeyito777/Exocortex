import type { SidebarItemRef } from "../messages";
import type { MoveSidebarItemsOptions } from "../protocol";

export type SidebarKeyResult =
  | { type: "handled" }
  | { type: "select"; convId: string }
  | { type: "open_folder_instructions"; folderId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "delete_conversations"; convIds: string[] }
  | { type: "delete_folder"; folderId: string; mode: "recursive" | "unwrap" }
  | { type: "undo_delete" }
  | { type: "redo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "rename_conversation"; convId: string; title: string }
  | { type: "pin_conversation"; convId: string; pinned: boolean }
  | { type: "pin_folder"; folderId: string; pinned: boolean }
  | { type: "pin_sidebar_items"; pins: { item: SidebarItemRef; pinned: boolean }[] }
  | { type: "move_conversation"; convId: string; direction: "up" | "down" }
  | { type: "move_sidebar_item"; item: SidebarItemRef; direction: "up" | "down" }
  | ({ type: "move_sidebar_items"; items: SidebarItemRef[]; parentId: string | null; before?: SidebarItemRef } & MoveSidebarItemsOptions)
  | { type: "clone_conversation"; convId: string }
  | { type: "create_folder"; name: string; parentId: string | null; items: SidebarItemRef[] }
  | { type: "rename_folder"; folderId: string; name: string }
  | { type: "unhandled" };
