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
import type { NewConversationPlacement } from "./sidebar/tree";
import { focusBtw, focusPrompt, focusHistory, focusSidebar, modelSupportsImages, pushSystemMessage } from "./state";
import { resolveAction, sidebarTopShortcutIndex } from "./keybinds";
import { handleChatKey } from "./chat";
import { preserveViewportAcrossHistoryMutation, toggleSidebarPreservingViewport, toggleToolOutputPreservingViewport } from "./chatscroll";
import {
  focusConversationAt,
  focusConversationById,
  focusNextCompletedConversation,
  focusNextStreamingConversation,
  focusPreviousEnteredConversation,
  handleSidebarAction,
  handleSidebarActionMenuKey,
  handleSidebarKey,
  handleSidebarMark,
  handleSidebarPromptKey,
  handleSidebarMenuAction,
  handleSidebarViewportAction,
  moveSelection,
  openSelectedSidebarActionMenu,
  syncSelectedIndex,
  type SidebarActionMenuKeyResult,
} from "./sidebar";
import {
  handleSidebarSearchBarKey,
  jumpToSidebarSearchMatch,
  openSidebarCommandBar,
  openSidebarSearchBar,
} from "./sidebarsearch";
import { commitInsertSession, markInsertEntry, pushUndo } from "./undo";
import { applyHistoryAction, placeAtVisibleBottom } from "./historycursor";
import { imageAtHistoryCursor, openableTargetAtHistoryCursor } from "./historyopenable";
import { acceptAutocomplete, type PathCompletionProvider } from "./autocomplete";
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
import { handleBtwKey } from "./btw/keys";
import { omittedToolOutputIdsNearViewport } from "./events/tool-outputs";
import { hasElidedBlocks } from "./events/elided-blocks";
import { restoreHistoryAboveView } from "./events/history-trim";
import { activeHistorySurface, isAnyHistoryFocused } from "./historysurface";
import type { InlineImageTarget } from "./inlineimages";
import { saveTurnWorkPreference } from "./diagnostics";

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
  | { type: "load_tool_outputs"; toolCallIds: string[] }
  | { type: "delete_conversation"; convId: string }
  | { type: "delete_conversations"; convIds: string[] }
  | { type: "delete_folder"; folderId: string; mode: "recursive" | "unwrap" }
  | { type: "undo_delete" }
  | { type: "redo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "mute_conversation"; convId: string; muted: boolean }
  | { type: "rename_conversation"; convId: string; title: string }
  | { type: "pin_conversation"; convId: string; pinned: boolean }
  | { type: "pin_folder"; folderId: string; pinned: boolean }
  | { type: "mute_folder"; folderId: string; muted: boolean }
  | { type: "pin_sidebar_items"; pins: { item: SidebarItemRef; pinned: boolean }[] }
  | { type: "move_conversation"; convId: string; direction: "up" | "down" }
  | { type: "move_sidebar_item"; item: SidebarItemRef; direction: "up" | "down"; reqId?: string }
  | ({ type: "move_sidebar_items"; items: SidebarItemRef[]; parentId: string | null; before?: SidebarItemRef; reqId?: string } & MoveSidebarItemsOptions)
  | { type: "clone_conversation"; convId: string }
  | { type: "create_folder"; name: string; parentId: string | null; items: SidebarItemRef[] }
  | { type: "rename_folder"; folderId: string; name: string }
  | { type: "new_conversation"; placement?: NewConversationPlacement }
  | { type: "queue_confirm" }
  | { type: "queue_cancel" }
  | { type: "edit_message_confirm" }
  | { type: "edit_message_cancel" }
  | { type: "btw_close" }
  | { type: "open_target"; target: string }
  | { type: "open_image"; target: InlineImageTarget }
  | { type: "open_accounts" }
  | { type: "open_instructions" };

// ── Key routing ─────────────────────────────────────────────────────

function isPromptFocused(state: RenderState): boolean {
  return state.panelFocus === "chat" && state.chatFocus === "prompt";
}

function isPromptTyping(state: RenderState): boolean {
  return isPromptFocused(state) && state.vim.mode === "insert";
}

function ensureSidebarReady(state: RenderState): void {
  state.sidebarOpenChosen = true;
  if (!state.sidebar.open) {
    state.sidebar.open = true;
    if (state.convId) focusConversationById(state.sidebar, state.convId);
    else syncSelectedIndex(state.sidebar);
  }
  focusSidebar(state);
}

/** Ctrl+S: open the sidebar focused, or close it back to the chat. */
export function toggleSidebar(state: RenderState): void {
  state.sidebarOpenChosen = true;
  toggleSidebarPreservingViewport(state);
  if (state.sidebar.open) {
    ensureSidebarReady(state);
  } else {
    state.panelFocus = "chat";
  }
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

export function handleSidebarActionMenuResult(
  result: SidebarActionMenuKeyResult,
  state: RenderState,
): KeyResult {
  const menu = state.sidebar.actionMenu;
  if (!menu) return { type: "handled" };
  if (result.type === "close") {
    state.sidebar.actionMenu = null;
    return { type: "handled" };
  }
  if (result.type !== "action") return { type: "handled" };

  state.sidebar.actionMenu = null;
  const { item } = menu;
  if (result.action === "copy_id") {
    copyToClipboard(item.id);
    return { type: "handled" };
  }
  if (result.action === "edit_instructions") {
    return item.type === "folder" ? { type: "open_folder_instructions", folderId: item.id } : { type: "handled" };
  }
  // Rename types into the sidebar's bottom bar, which reads keys only while the sidebar has focus.
  if (result.action === "rename") focusSidebar(state);
  return mapSidebarResult(handleSidebarMenuAction(result.action, item, state.sidebar));
}

function handleSidebarActionMenuFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  const menu = state.sidebar.actionMenu;
  if (!menu) return { type: "handled" };
  return handleSidebarActionMenuResult(handleSidebarActionMenuKey(menu, key), state);
}

export function handleFocusedKey(
  key: KeyEvent,
  state: RenderState,
  onAsyncUiMutation?: AsyncUiMutationCallback,
  pathCompletionProvider?: PathCompletionProvider,
): KeyResult {
  // A fresh input supersedes any jump still waiting for an older page.
  if (key.event !== "release") state.pendingHistoryNavigation = null;
  // Ctrl-C is always quit, regardless of focused panel, prompt/modal, or vim state.
  if (key.type === "ctrl-c") return { type: "quit" };

  // Ctrl-A always asks the daemon to background the current tool call, even
  // when a prompt/search/modal has focus.
  if (key.type === "ctrl-a") return { type: "background_tool" };

  // Ctrl-Shift-R always requests a daemon restart, regardless of focused panel,
  // prompt/modal, or vim state.
  if (key.type === "ctrl-shift-r") return { type: "restart_daemon" };

  // ── Sidebar action menu — intercept all keys ──────────────────
  if (state.sidebar.actionMenu) {
    return handleSidebarActionMenuFocusedKey(key, state);
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

  const btwResult = handleBtwKey(key, state);
  if (btwResult) return btwResult;

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
    // Typing before a mid-insert paste is its own undo step, then the paste;
    // typing after it starts a new insert session (marked below).
    commitInsertSession(state.undo, state.inputBuffer);
    pushUndo(state.undo, state.inputBuffer, state.cursorPos);
    const buf = state.inputBuffer;
    const pos = graphemeBoundaryAtOrAfter(buf, state.cursorPos);
    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = pos + text.length;
    state.promptCurswant = null;
    state.autocomplete = null;
    // Ensure prompt is focused and in insert mode
    focusPrompt(state);
    markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
    return { type: "handled" };
  }

  // Without the kitty keyboard protocol Ctrl+I arrives as Tab, which the
  // history has no use for, so Tab there opens the detailed view.
  const action = resolveAction(key) ?? (key.type === "tab" && isAnyHistoryFocused(state) ? "toggle_tool_output" : null);
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

  // On the sidebar Ctrl+E moves the selection to the top of its folder
  // instead of scrolling the sidebar a line.
  if (key.type === "ctrl-e" && state.panelFocus === "sidebar" && state.sidebar.open) {
    return mapSidebarResult(handleSidebarAction("move_to_top", state.sidebar));
  }

  // Global actions — work regardless of focus and vim mode
  switch (action) {
    case "quit":
      return { type: "quit" };
    case "restart_daemon":
      return { type: "restart_daemon" };
    case "sidebar_toggle":
      toggleSidebar(state);
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
      return { type: "new_conversation", placement: "selected" };
    case "new_top_level_conversation":
      return { type: "new_conversation", placement: "top_level" };
    case "edit_message":
      openEditMessageModal(state);
      return { type: "handled" };
    case "focus_history":
      // Cycle through the two history surfaces when BTW is visible:
      // prompt/sidebar → BTW → chat history → prompt.
      if (state.panelFocus === "chat" && state.chatFocus === "btw") {
        focusHistory(state);
        state.historyCursor = placeAtVisibleBottom(state);
        state.historyCurswant = null;
      } else if (isAnyHistoryFocused(state)) {
        focusPrompt(state);
      } else if (state.btw) {
        focusBtw(state);
        const surface = activeHistorySurface(state);
        surface.setCursor(placeAtVisibleBottom(state));
        surface.setCurswant(null);
      } else {
        focusHistory(state);
        state.historyCursor = placeAtVisibleBottom(state);
        state.historyCurswant = null;
      }
      return { type: "handled" };
    case "sidebar_next":
    case "sidebar_prev": {
      // Don't intercept when typing in the prompt — these are regular chars.
      // In the history they move the cursor (vim keymap).
      if (isPromptTyping(state) || isAnyHistoryFocused(state)) break;
      // From the prompt in normal mode, Shift+K goes straight into the chat
      // history with the cursor already one Shift+K up from the bottom row;
      // Shift+J does nothing there. Only the sidebar's own J/K move its selection.
      if (isPromptFocused(state)) {
        if (action === "sidebar_prev") {
          focusHistory(state);
          state.historyCursor = placeAtVisibleBottom(state);
          state.historyCurswant = null;
          applyHistoryAction("history_half_up", state);
        }
        return { type: "handled" };
      }
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
    case "toggle_turn_work":
      // Ctrl+O flips between everything shown and everything folded. From the
      // detailed view it folds everything back in one press.
      state.showToolOutputAfterLoad = false;
      // Folded pages leave out the work's content: show it once that is in.
      // A second press while it loads stays folded.
      if (state.unfoldAfterElidedLoad !== null) {
        state.unfoldAfterElidedLoad = null;
        return { type: "handled" };
      }
      if (!state.showTurnWork && !state.showToolOutput && hasElidedBlocks(state)) {
        state.unfoldAfterElidedLoad = "turn_work";
        return { type: "handled" };
      }
      preserveViewportAcrossHistoryMutation(state, () => {
        state.showTurnWork = !state.showTurnWork && !state.showToolOutput;
        state.showToolOutput = false;
        // Folded again: the history the unfold dropped above the view comes back.
        restoreHistoryAboveView(state);
      });
      saveTurnWorkPreference(state.showTurnWork);
      return { type: "handled" };
    case "toggle_tool_output": {
      if (state.unfoldAfterElidedLoad !== null) {
        // Cancel an expansion still waiting for folded work's content.
        state.unfoldAfterElidedLoad = null;
        return { type: "handled" };
      }
      if (!state.showToolOutput && !state.showToolOutputAfterLoad && hasElidedBlocks(state)) {
        state.unfoldAfterElidedLoad = "tool_output";
        return { type: "handled" };
      }
      if (state.showToolOutput || state.showToolOutputAfterLoad) {
        // Collapse, or cancel an expansion still waiting for its bodies.
        state.showToolOutputAfterLoad = false;
        if (state.showToolOutput) {
          preserveViewportAcrossHistoryMutation(state, () => {
            state.showToolOutput = false;
            restoreHistoryAboveView(state);
          });
        }
        return { type: "handled" };
      }
      // Expand once the bodies around the viewport arrive so rows do not flash
      // empty; the rest load as they scroll into view.
      const toolCallIds = state.convId ? omittedToolOutputIdsNearViewport(state, { retry: true }) : [];
      if (toolCallIds.length === 0) {
        toggleToolOutputPreservingViewport(state);
        return { type: "handled" };
      }
      state.showToolOutputAfterLoad = true;
      return { type: "load_tool_outputs", toolCallIds };
    }
    case "paste_image": {
      if (!modelSupportsImages(state)) {
        log("warn", `tui: clipboard image paste failed: image inputs are not supported by ${state.provider}/${state.model}`);
        pushSystemMessage(state, `✗ Image inputs are not supported by ${state.provider}/${state.model}. Switch to a vision-capable model to paste images.`, theme.error);
        return { type: "handled" };
      }
      const img = readClipboardImage(message => pushSystemMessage(state, `✗ ${message}`, theme.error));
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

  if (action === "submit" && isAnyHistoryFocused(state)) {
    const image = imageAtHistoryCursor(state);
    if (image) return { type: "open_image", target: image };
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

  // ── Sidebar conversation and folder actions ───────────────────────
  // Like Record's server/item menu, semicolon opens a small menu beside
  // the currently hovered/selected sidebar row instead of repeating Vim find.
  if (state.panelFocus === "sidebar" && state.sidebar.open
      && state.vim.mode === "normal"
      && !vimHasPendingInput(state)
      && key.type === "char" && key.char === ";") {
    openSelectedSidebarActionMenu(state.sidebar);
    return { type: "handled" };
  }

  // ── Sidebar shortcuts that would otherwise be eaten by Vim commands ──
  if (state.panelFocus === "sidebar" && state.sidebar.open && state.vim.mode === "normal"
      && !vimHasPendingInput(state)
      && key.type === "char" && key.char && ["v", "V", "f", "F", "<", "r", "x", "M"].includes(key.char)) {
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
    return handleChatFocused(key, state, pathCompletionProvider);
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

function handleChatFocused(
  key: KeyEvent,
  state: RenderState,
  pathCompletionProvider?: PathCompletionProvider,
): KeyResult {
  const result = handleChatKey(key, state, pathCompletionProvider);

  switch (result.type) {
    case "submit":
      return { type: "submit" };
    case "handled":
      return { type: "handled" };
    case "unhandled":
      return { type: "handled" };
  }
}
