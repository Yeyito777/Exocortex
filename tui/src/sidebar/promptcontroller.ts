import type { KeyEvent } from "../input";
import { findFolderDestination } from "./folders";
import { currentFolderRef, topLevelCurrentFolderRef } from "./folderactions";
import { cycleMovePromptAutocomplete, updateMovePromptAutocomplete } from "./moveautocomplete";
import type { SidebarState } from "./state";
import type { SidebarKeyResult } from "./types";
import { graphemeBoundaryAtOrAfter, nextGraphemeEnd, previousGraphemeStart } from "../graphemes";

export function handleSidebarPromptKey(sidebar: SidebarState, key: KeyEvent): SidebarKeyResult {
  const prompt = sidebar.prompt;
  if (!prompt) return { type: "handled" };
  if (key.type === "escape" || key.type === "ctrl-c") {
    sidebar.prompt = null;
    return { type: "handled" };
  }
  if (key.type === "tab" || key.type === "backtab") {
    cycleMovePromptAutocomplete(sidebar, key.type === "tab" ? 1 : -1);
    return { type: "handled" };
  }
  if (key.type === "enter") {
    const input = prompt.input.trim();
    sidebar.prompt = null;
    sidebar.visualAnchor = null;
    if (prompt.purpose === "create_folder") {
      if (!input) return { type: "handled" };
      sidebar.pendingFocusFolder = { name: input, parentId: sidebar.currentFolderId };
      return { type: "create_folder", name: input, parentId: sidebar.currentFolderId, items: prompt.items };
    }
    if (prompt.purpose === "move_items") {
      const raw = input.trim();
      const destinationFolder = findFolderDestination(sidebar, raw);
      const destination = destinationFolder === undefined ? undefined : destinationFolder?.id ?? null;
      const before = raw === ".."
        ? currentFolderRef(sidebar)
        : (!raw || raw === "/")
          ? topLevelCurrentFolderRef(sidebar)
          : undefined;
      if (destinationFolder && (destinationFolder.parentId ?? null) === sidebar.currentFolderId) {
        // The moved item disappears from this view; keep the cursor on the
        // destination folder rather than falling back to the top.
        sidebar.pendingFocusItem = { type: "folder", id: destinationFolder.id };
      }
      return destination !== undefined
        ? { type: "move_sidebar_items", items: prompt.items, parentId: destination, before }
        : { type: "handled" };
    }
    if (prompt.purpose === "rename_folder" && prompt.folderId) {
      return input ? { type: "rename_folder", folderId: prompt.folderId, name: input } : { type: "handled" };
    }
    return { type: "handled" };
  }
  if (key.type === "backspace") {
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    if (pos > 0) {
      const start = previousGraphemeStart(prompt.input, pos);
      prompt.input = prompt.input.slice(0, start) + prompt.input.slice(pos);
      prompt.cursorPos = start;
      updateMovePromptAutocomplete(sidebar);
    } else if (prompt.input.length === 0) {
      sidebar.prompt = null;
    }
    return { type: "handled" };
  }
  if (key.type === "delete") {
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    if (pos < prompt.input.length) {
      prompt.input = prompt.input.slice(0, pos) + prompt.input.slice(nextGraphemeEnd(prompt.input, pos));
      prompt.cursorPos = pos;
      updateMovePromptAutocomplete(sidebar);
    }
    return { type: "handled" };
  }
  if (key.type === "left") { prompt.cursorPos = previousGraphemeStart(prompt.input, prompt.cursorPos); return { type: "handled" }; }
  if (key.type === "right") { prompt.cursorPos = nextGraphemeEnd(prompt.input, prompt.cursorPos); return { type: "handled" }; }
  if (key.type === "home") { prompt.cursorPos = 0; return { type: "handled" }; }
  if (key.type === "end") { prompt.cursorPos = prompt.input.length; return { type: "handled" }; }
  if (key.type === "paste" && key.text) {
    const text = key.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    prompt.input = prompt.input.slice(0, pos) + text + prompt.input.slice(pos);
    prompt.cursorPos = pos + text.length;
    updateMovePromptAutocomplete(sidebar);
    return { type: "handled" };
  }
  if (key.type === "char" && key.char) {
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    prompt.input = prompt.input.slice(0, pos) + key.char + prompt.input.slice(pos);
    prompt.cursorPos = pos + key.char.length;
    updateMovePromptAutocomplete(sidebar);
  }
  return { type: "handled" };
}
