/**
 * Panel-level focus routing.
 *
 * Routes key events based on which panel has focus (sidebar or chat).
 * When vim is enabled, keys pass through the vim engine first.
 * Chat manages its own inner focus (prompt/history) via chat.ts.
 * Sidebar manages its own keys via sidebar.ts.
 * Mouse events are handled separately in mouse.ts.
 *
 * This is the top-level key routing — the only file main.ts calls
 * for key handling.
 */

import type { KeyEvent } from "./input";
import type { MoveSidebarItemsOptions, SidebarItemRef } from "./protocol";
import type { RenderState } from "./state";
import { EDIT_INDEX_INSTRUCTIONS, focusPrompt, focusHistory, focusSidebar, modelSupportsImages, pushSystemMessage } from "./state";
import { resolveAction, sidebarTopShortcutIndex } from "./keybinds";
import { handleChatKey } from "./chat";
import { toggleToolOutputPreservingViewport } from "./chatscroll";
import {
  focusConversationAt,
  focusConversationById,
  focusNextCompletedConversation,
  focusNextStreamingConversation,
  focusPreviousEnteredConversation,
  createConversationActionMenu,
  handleConversationActionMenuKey,
  handleSidebarConversationAction,
  handleSidebarKey,
  handleSidebarMark,
  handleSidebarPromptKey,
  handleSidebarViewportAction,
  moveSelection,
  syncSelectedIndex,
} from "./sidebar";
import {
  handleSidebarSearchBarKey,
  jumpToSidebarSearchMatch,
  openSidebarCommandBar,
  openSidebarSearchBar,
} from "./sidebarsearch";
import { pushUndo } from "./undo";
import { placeAtVisibleBottom } from "./historycursor";
import { openableTargetAtHistoryCursor } from "./historyopenable";
import { acceptAutocomplete } from "./autocomplete";
import { handleQueuePromptKey } from "./queue";
import { handleEditMessageKey, openEditMessageModal } from "./editmessage";
import { readClipboardImage } from "./clipboard";
import { processVimKey, handleScrollAction, mapSidebarResult, type AsyncUiMutationCallback } from "./vimhandler";
import { handleSearchBarKey, jumpToSearchMatch, openCommandBar, openSearchBar } from "./search";
import { theme } from "./theme";
import { graphemeBoundaryAtOrAfter } from "./graphemes";
import { sanitizePromptTextForInsertion } from "./prompttext";
import { log } from "./log";
import { copyToClipboard } from "./vim/clipboard";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "background_tool" }
  | { type: "restart_daemon" }
  | { type: "load_conversation"; convId: string }
  | { type: "open_folder_instructions"; folderId: string }
  | { type: "load_tool_outputs"; convId: string }
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
  | { type: "new_conversation" }
  | { type: "queue_confirm" }
  | { type: "queue_cancel" }
  | { type: "edit_message_confirm" }
  | { type: "edit_message_cancel" }
  | { type: "btw_close" }
  | { type: "open_target"; target: string };

// ── Key routing ─────────────────────────────────────────────────────

function isPromptFocused(state: RenderState): boolean {
  return state.panelFocus === "chat" && state.chatFocus === "prompt";
}

function isPromptTyping(state: RenderState): boolean {
  return isPromptFocused(state) && state.vim.mode === "insert";
}

function ensureSidebarReady(state: RenderState): void {
  if (!state.sidebar.open) {
    state.sidebar.open = true;
    if (state.convId) focusConversationById(state.sidebar, state.convId);
    else syncSelectedIndex(state.sidebar);
  }
  focusSidebar(state);
}

function vimHasPendingInput(state: RenderState): boolean {
  return !!(
    state.vim.pendingOperator
    || state.vim.pendingOperatorKey
    || state.vim.pendingTextObjectModifier
    || state.vim.pendingKeys
    || state.vim.count !== null
    || state.vim.pendingFind
    || state.vim.pendingReplace
  );
}

function loadSelectedConversation(state: RenderState): KeyResult {
  const convId = state.sidebar.selectedId;
  return convId && convId !== state.convId
    ? { type: "load_conversation", convId }
    : { type: "handled" };
}

function focusSidebarShortcutTarget(state: RenderState, focus: () => boolean): KeyResult {
  ensureSidebarReady(state);
  return focus() ? loadSelectedConversation(state) : { type: "handled" };
}

function loadActivityConversation(
  state: RenderState,
  status: "completed" | "streaming",
): KeyResult {
  const focused = status === "completed"
    ? focusNextCompletedConversation(state.sidebar, state.convId)
    : focusNextStreamingConversation(state.sidebar, state.convId);
  return focused
    ? loadSelectedConversation(state)
    : { type: "handled" };
}

function openSelectedConversationActionMenu(state: RenderState): void {
  const item = state.sidebar.selectedItem;
  if (item?.type !== "conversation") return;
  const conv = state.sidebar.conversations.find(candidate => candidate.id === item.id);
  if (!conv) return;

  state.sidebar.visualAnchor = null;
  state.sidebar.pendingDeleteId = null;
  state.sidebar.pendingDeleteItem = null;
  state.sidebar.conversationActionMenu = createConversationActionMenu(conv.id, conv.marked, conv.pinned);
}

function handleConversationActionMenuFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  const menu = state.sidebar.conversationActionMenu;
  if (!menu) return { type: "handled" };
  const result = handleConversationActionMenuKey(menu, key);
  if (result.type === "close") {
    state.sidebar.conversationActionMenu = null;
    return { type: "handled" };
  }
  if (result.type !== "action") return { type: "handled" };

  state.sidebar.conversationActionMenu = null;
  if (result.action === "copy_id") {
    copyToClipboard(menu.convId);
    return { type: "handled" };
  }
  return mapSidebarResult(handleSidebarConversationAction(result.action, menu.convId, state.sidebar));
}

export function handleFocusedKey(
  key: KeyEvent,
  state: RenderState,
  onAsyncUiMutation?: AsyncUiMutationCallback,
): KeyResult {
  // Ctrl-C is always quit, regardless of focused panel, prompt/modal, or vim state.
  if (key.type === "ctrl-c") return { type: "quit" };

  // Ctrl-A always asks the daemon to background the current tool call, even
  // when a prompt/search/modal has focus.
  if (key.type === "ctrl-a") return { type: "background_tool" };

  // Ctrl-Shift-R always requests a daemon restart, regardless of focused panel,
  // prompt/modal, or vim state.
  if (key.type === "ctrl-shift-r") return { type: "restart_daemon" };

  // ── Sidebar conversation action menu — intercept all keys ──────
  if (state.sidebar.conversationActionMenu) {
    return handleConversationActionMenuFocusedKey(key, state);
  }

  // ── Queue prompt modal — intercept all keys when showing ──────
  if (state.queuePrompt) {
    const qr = handleQueuePromptKey(key, state);
    if (qr.type === "confirm") return { type: "queue_confirm" };
    if (qr.type === "cancel")  return { type: "queue_cancel" };
    return { type: "handled" };
  }

  // ── Edit message modal — intercept all keys when showing ─────
  if (state.editMessagePrompt) {
    const er = handleEditMessageKey(key, state);
    if (er.type === "confirm") return { type: "edit_message_confirm" };
    if (er.type === "cancel")  return { type: "edit_message_cancel" };
    return { type: "handled" };
  }

  // Ctrl-Q is the always-available BTW interrupt/close key, including while the
  // main prompt remains in insert mode. With no BTW panel it retains its normal
  // conversation-abort behavior below.
  if (state.btw && key.type === "ctrl-q") return { type: "btw_close" };

  // Ctrl scrolling targets BTW even while the prompt is in insert mode. Other
  // focused panels retain their own scrolling bindings.
  const promptFocused = isPromptFocused(state);
  const btw = state.btw;
  const btwUiAvailable = btw !== null
    && !state.sidebar.prompt
    && !state.sidebar.search?.barOpen
    && !state.search?.barOpen;
  if (btwUiAvailable && promptFocused) {
    const page = Math.max(1, btw.viewportRows - 1);
    const halfPage = Math.max(1, Math.floor(btw.viewportRows / 2));
    let delta = 0;
    if (key.type === "ctrl-y") delta = 1;
    else if (key.type === "ctrl-e") delta = -1;
    else if (key.type === "ctrl-u") delta = halfPage;
    else if (key.type === "ctrl-d") delta = -halfPage;
    else if (key.type === "ctrl-b") delta = page;
    else if (key.type === "ctrl-f") delta = -page;
    if (delta !== 0) {
      btw.scrollOffset = Math.max(0, Math.min(btw.maxScroll, btw.scrollOffset + delta));
      return { type: "handled" };
    }
  }

  // Only standalone normal-mode prompt keys are borrowed by BTW. Sidebar,
  // history, visual mode, and pending Vim sequences keep their own bindings.
  if (btwUiAvailable
      && promptFocused
      && state.vim.mode === "normal"
      && !vimHasPendingInput(state)) {
    if (key.type === "char" && key.char === "q") return { type: "btw_close" };
    let delta = 0;
    if (key.type === "char" && key.char === "k") delta = 1;
    else if (key.type === "char" && key.char === "j") delta = -1;
    else if (key.type === "up") delta = 1;
    else if (key.type === "down") delta = -1;
    if (delta !== 0) {
      btw.scrollOffset = Math.max(0, Math.min(btw.maxScroll, btw.scrollOffset + delta));
      return { type: "handled" };
    }
  }

  // ── Sidebar folder prompt — intercept all keys while open ─────
  if (state.panelFocus === "sidebar" && state.sidebar.prompt) {
    return mapSidebarResult(handleSidebarPromptKey(state.sidebar, key));
  }

  // ── Sidebar search bar — intercept all keys while open ───────
  if (state.panelFocus === "sidebar" && state.sidebar.search?.barOpen) {
    const sr = handleSidebarSearchBarKey(state.sidebar, key);
    if (sr.type === "abort") return { type: "abort" };
    return { type: "handled" };
  }

  // ── Search bar — intercept all keys while open ────────────────
  if (state.search?.barOpen) {
    const sr = handleSearchBarKey(state, key);
    if (sr.type === "abort") return { type: "abort" };
    return { type: "handled" };
  }

  // Bracketed paste — insert directly into prompt buffer, newlines preserved
  if (key.type === "paste" && key.text) {
    const text = sanitizePromptTextForInsertion(key.text);
    if (!text) return { type: "handled" };
    pushUndo(state.undo, state.inputBuffer, state.cursorPos);
    const buf = state.inputBuffer;
    const pos = graphemeBoundaryAtOrAfter(buf, state.cursorPos);
    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = pos + text.length;
    state.promptCurswant = null;
    state.autocomplete = null;
    // Ensure prompt is focused and in insert mode
    focusPrompt(state);
    return { type: "handled" };
  }

  const action = resolveAction(key);
  const topIndex = sidebarTopShortcutIndex(action);

  if (!isPromptTyping(state)) {
    if (topIndex !== null) {
      return focusSidebarShortcutTarget(state, () => {
        const targetIndex = topIndex - 1;
        if (targetIndex >= state.sidebar.conversations.length) return false;
        focusConversationAt(state.sidebar, targetIndex);
        return true;
      });
    }
    if (action === "sidebar_focus_previous") {
      return focusSidebarShortcutTarget(state, () => focusPreviousEnteredConversation(state.sidebar));
    }
  }

  // Standalone normal-mode activity shortcuts. Preserve pending Vim sequences
  // so t/T can still be used as the character following an operator or find.
  if (state.vim.mode === "normal" && !vimHasPendingInput(state)) {
    if (action === "sidebar_focus_next_completed") {
      return loadActivityConversation(state, "completed");
    }
    if (action === "sidebar_focus_next_streaming") {
      return loadActivityConversation(state, "streaming");
    }
  }

  // Global actions — work regardless of focus and vim mode
  switch (action) {
    case "quit":
      return { type: "quit" };
    case "restart_daemon":
      return { type: "restart_daemon" };
    case "sidebar_toggle":
      state.sidebar.open = !state.sidebar.open;
      if (state.sidebar.open) {
        ensureSidebarReady(state);
      } else {
        state.panelFocus = "chat";
      }
      return { type: "handled" };
    case "focus_cycle":
      if (state.sidebar.open) {
        if (state.panelFocus === "sidebar") {
          state.panelFocus = "chat";
        } else {
          focusSidebar(state);
        }
      }
      return { type: "handled" };
    case "new_conversation":
      return { type: "new_conversation" };
    case "edit_message":
      if (state.folderInstructionsDoc) {
        const text = state.folderInstructionsDoc.savedText || state.folderInstructionsDoc.text;
        if (!text.trim()) return { type: "handled" };
        state.editMessagePrompt = {
          items: [{ userMessageIndex: EDIT_INDEX_INSTRUCTIONS, text, isQueued: false }],
          selection: 0,
          scrollOffset: 0,
        };
        return { type: "handled" };
      }
      openEditMessageModal(state);
      return { type: "handled" };
    case "focus_history":
      // Toggle: if already in history → back to prompt, otherwise → history
      if (state.panelFocus === "chat" && state.chatFocus === "history") {
        focusPrompt(state);
      } else {
        focusHistory(state);
        state.historyCursor = placeAtVisibleBottom(state);
        state.historyCurswant = null;
      }
      return { type: "handled" };
    case "sidebar_next":
    case "sidebar_prev": {
      // Don't intercept when typing in the prompt — these are regular chars
      if (isPromptTyping(state)) break;
      ensureSidebarReady(state);
      moveSelection(state.sidebar, action === "sidebar_next" ? 1 : -1);
      return { type: "handled" };
    }
    case "scroll_line_up":
    case "scroll_line_down":
    case "scroll_half_up":
    case "scroll_half_down":
    case "scroll_page_up":
    case "scroll_page_down":
    case "scroll_top":
    case "scroll_bottom":
      handleScrollAction(action, state);
      return { type: "handled" };
    case "toggle_tool_output":
      if (state.showToolOutput) {
        state.showToolOutputAfterLoad = false;
        toggleToolOutputPreservingViewport(state);
        return { type: "handled" };
      }
      if (state.toolOutputsLoaded) {
        toggleToolOutputPreservingViewport(state);
        return { type: "handled" };
      }
      if (!state.convId || state.toolOutputsLoading) return { type: "handled" };
      state.toolOutputsLoading = true;
      state.showToolOutputAfterLoad = true;
      return { type: "load_tool_outputs", convId: state.convId };
    case "paste_image": {
      if (!modelSupportsImages(state)) {
        log("warn", `tui: clipboard image paste failed: image inputs are not supported by ${state.provider}/${state.model}`);
        pushSystemMessage(state, `✗ Image inputs are not supported by ${state.provider}/${state.model}. Switch to a vision-capable model to paste images.`, theme.error);
        return { type: "handled" };
      }
      const img = readClipboardImage();
      if (img) {
        state.pendingImages.push(img);
        // Force focus to prompt in insert mode so user can type a caption
        focusPrompt(state);
      }
      return { type: "handled" };
    }
    case "redo_delete":
      if (state.panelFocus === "sidebar" && state.sidebar.open) return { type: "redo_delete" };
      break;
  }

  if (action === "submit" && state.panelFocus === "chat" && state.chatFocus === "history") {
    const target = openableTargetAtHistoryCursor(state);
    return target ? { type: "open_target", target } : { type: "handled" };
  }

  // ── Abort (Ctrl+Q) — always fires, regardless of focus or vim mode ─
  if (action === "abort") {
    return { type: "abort" };
  }

  // ── Background current tool (Ctrl+A) — always fires globally ────────
  if (action === "background_tool") {
    return { type: "background_tool" };
  }

  // ── Sidebar pending delete cancel (before vim) ──────────────────
  if (key.type === "escape" && state.panelFocus === "sidebar" && (state.sidebar.pendingDeleteId || state.sidebar.pendingDeleteItem || state.sidebar.visualAnchor)) {
    state.sidebar.pendingDeleteId = null;
    state.sidebar.pendingDeleteItem = null;
    state.sidebar.visualAnchor = null;
    // Also normalize vim to normal mode so we don't eat the next Escape
    if (state.vim.mode === "insert") {
      state.vim.mode = "normal";
    }
    return { type: "handled" };
  }

  // ── Autocomplete accept on Escape ──────────────────────────────
  // Esc in insert mode should still enter normal mode, but it must not
  // undo a completion the user already chose with Tab. Close the popup
  // before vim computes the normal-mode cursor position from the buffer.
  if (key.type === "escape" && state.autocomplete) {
    acceptAutocomplete(state);
  }

  // ── Sidebar marks (digit keys) — intercept before vim count prefix ──
  // Digits 1-9 would be consumed as vim count prefixes, so we handle
  // them here for the sidebar where they toggle emoji marks on titles.
  if (state.panelFocus === "sidebar" && state.sidebar.open
      && state.vim.mode === "normal"
      && key.type === "char" && key.char && /^[0-9]$/.test(key.char)) {
    return mapSidebarResult(handleSidebarMark(state.sidebar, parseInt(key.char, 10)));
  }

  // ── Sidebar conversation actions ────────────────────────────────
  // Like Record's server/item menu, semicolon opens a small menu beside
  // the currently hovered/selected sidebar row instead of repeating Vim find.
  if (state.panelFocus === "sidebar" && state.sidebar.open
      && state.vim.mode === "normal"
      && !vimHasPendingInput(state)
      && key.type === "char" && key.char === ";") {
    openSelectedConversationActionMenu(state);
    return { type: "handled" };
  }

  // ── Sidebar folder shortcuts that would otherwise be eaten by vim find/replace ──
  if (state.panelFocus === "sidebar" && state.sidebar.open && state.vim.mode === "normal"
      && !vimHasPendingInput(state)
      && key.type === "char" && key.char && ["v", "V", "f", "F", "<", "r", "x"].includes(key.char)) {
    return mapSidebarResult(handleSidebarKey(key, state.sidebar));
  }

  // ── Vim-style sidebar search (/ ? n N) ─────────────────────────
  if (state.panelFocus === "sidebar" && state.sidebar.open && state.vim.mode === "normal"
      && !vimHasPendingInput(state)
      && key.type === "char" && key.char) {
    if (key.char === "/" || key.char === "?") {
      openSidebarSearchBar(state.sidebar, key.char === "/" ? "forward" : "backward");
      return { type: "handled" };
    }
    if (key.char === ":") {
      openSidebarCommandBar(state.sidebar);
      return { type: "handled" };
    }
    if (key.char === "n" && state.sidebar.search?.query) {
      jumpToSidebarSearchMatch(state.sidebar, state.sidebar.search.direction);
      return { type: "handled" };
    }
    if (key.char === "N" && state.sidebar.search?.query) {
      jumpToSidebarSearchMatch(
        state.sidebar,
        state.sidebar.search.direction === "forward" ? "backward" : "forward",
      );
      return { type: "handled" };
    }
  }

  // ── Vim-style chat history search (/ ? n N) ────────────────────
  if (state.panelFocus === "chat" && state.vim.mode === "normal"
      && !vimHasPendingInput(state)
      && key.type === "char" && key.char) {
    if (key.char === "/" || key.char === "?") {
      openSearchBar(state, key.char === "/" ? "forward" : "backward");
      return { type: "handled" };
    }
    if (key.char === ":") {
      openCommandBar(state);
      return { type: "handled" };
    }
    if (key.char === "n" && state.search?.query) {
      jumpToSearchMatch(state, state.search.direction);
      return { type: "handled" };
    }
    if (key.char === "N" && state.search?.query) {
      jumpToSearchMatch(state, state.search.direction === "forward" ? "backward" : "forward");
      return { type: "handled" };
    }
  }

  // ── Vim processing ─────────────────────────────────────────────
  const vimResult = processVimKey(key, state, onAsyncUiMutation);
  if (vimResult) return vimResult;

  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    return handleSidebarFocused(key, state);
  } else {
    return handleChatFocused(key, state);
  }
}

// ── Sidebar panel (non-vim path) ───────────────────────────────────

function handleSidebarFocused(key: KeyEvent, state: RenderState): KeyResult {
  const action = resolveAction(key, "navigation");
  if (handleSidebarViewportAction(action, state.sidebar, state.rows)) {
    return { type: "handled" };
  }

  const result = handleSidebarKey(key, state.sidebar);

  if (result.type === "unhandled") {
    // focus_prompt comes back as unhandled from sidebar (i/a)
    state.panelFocus = "chat";
    return { type: "handled" };
  }

  return mapSidebarResult(result);
}

// ── Chat panel (non-vim path) ──────────────────────────────────────

function handleChatFocused(key: KeyEvent, state: RenderState): KeyResult {
  const result = handleChatKey(key, state);

  switch (result.type) {
    case "submit":
      return { type: "submit" };
    case "handled":
      return { type: "handled" };
    case "unhandled":
      return { type: "handled" };
  }
}
