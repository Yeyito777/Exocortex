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
import type { RenderState } from "./state";
import { focusPrompt, focusHistory, focusSidebar, modelSupportsImages, pushSystemMessage } from "./state";
import { resolveAction, sidebarTopShortcutIndex } from "./keybinds";
import { handleChatKey } from "./chat";
import { toggleToolOutputPreservingViewport } from "./chatscroll";
import {
  focusConversationAt,
  focusConversationById,
  focusPreviousEnteredConversation,
  handleSidebarKey,
  handleSidebarMark,
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
import { dismissAutocomplete } from "./autocomplete";
import { handleQueuePromptKey } from "./queue";
import { handleEditMessageKey, openEditMessageModal } from "./editmessage";
import { readClipboardImage } from "./clipboard";
import { processVimKey, handleScrollAction, mapSidebarResult } from "./vimhandler";
import { handleSearchBarKey, jumpToSearchMatch, openCommandBar, openSearchBar } from "./search";
import { theme } from "./theme";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "load_conversation"; convId: string }
  | { type: "load_tool_outputs"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "undo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "rename_conversation"; convId: string; title: string }
  | { type: "pin_conversation"; convId: string; pinned: boolean }
  | { type: "move_conversation"; convId: string; direction: "up" | "down" }
  | { type: "clone_conversation"; convId: string }
  | { type: "new_conversation" }
  | { type: "queue_confirm" }
  | { type: "queue_cancel" }
  | { type: "edit_message_confirm" }
  | { type: "edit_message_cancel" }
  | { type: "open_target"; target: string };

// ── Key routing ─────────────────────────────────────────────────────

function isPromptTyping(state: RenderState): boolean {
  return state.panelFocus === "chat" && state.chatFocus === "prompt"
    && state.vim.mode === "insert";
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

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
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
    // Normalize line endings: \r\n → \n, stray \r → \n
    const text = key.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    pushUndo(state.undo, state.inputBuffer, state.cursorPos);
    const buf = state.inputBuffer;
    const pos = state.cursorPos;
    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = pos + text.length;
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

  // Global actions — work regardless of focus and vim mode
  switch (action) {
    case "quit":
      return { type: "quit" };
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
      openEditMessageModal(state);
      return { type: "handled" };
    case "focus_history":
      // Toggle: if already in history → back to prompt, otherwise → history
      if (state.panelFocus === "chat" && state.chatFocus === "history") {
        focusPrompt(state);
      } else {
        focusHistory(state);
        state.historyCursor = placeAtVisibleBottom(state);
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
  }

  if (action === "submit" && state.panelFocus === "chat" && state.chatFocus === "history") {
    const target = openableTargetAtHistoryCursor(state);
    return target ? { type: "open_target", target } : { type: "handled" };
  }

  // ── Abort (Ctrl+Q) — always fires, regardless of focus or vim mode ─
  if (action === "abort") {
    return { type: "abort" };
  }

  // ── Sidebar pending delete cancel (before vim) ──────────────────
  if (key.type === "escape" && state.panelFocus === "sidebar" && state.sidebar.pendingDeleteId) {
    state.sidebar.pendingDeleteId = null;
    // Also normalize vim to normal mode so we don't eat the next Escape
    if (state.vim.mode === "insert") {
      state.vim.mode = "normal";
    }
    return { type: "handled" };
  }

  // ── Autocomplete dismiss on Escape ─────────────────────────────
  // Must happen before vim so the buffer is restored before vim
  // computes the normal-mode cursor position.
  if (key.type === "escape" && state.autocomplete) {
    dismissAutocomplete(state);
  }

  // ── Sidebar marks (digit keys) — intercept before vim count prefix ──
  // Digits 1-9 would be consumed as vim count prefixes, so we handle
  // them here for the sidebar where they toggle emoji marks on titles.
  if (state.panelFocus === "sidebar" && state.sidebar.open
      && state.vim.mode === "normal"
      && key.type === "char" && key.char && /^[0-9]$/.test(key.char)) {
    return mapSidebarResult(handleSidebarMark(state.sidebar, parseInt(key.char, 10)));
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
  const vimResult = processVimKey(key, state);
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

