import type { KeyEvent } from "../input";
import type { RenderState } from "../state";

export type BtwKeyResult = { type: "handled" } | { type: "btw_close" };

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

function scrollBtw(state: RenderState, delta: number): BtwKeyResult {
  const btw = state.btw!;
  btw.scrollOffset = Math.max(0, Math.min(btw.maxScroll, btw.scrollOffset + delta));
  return { type: "handled" };
}

/** Handle only the foreground panel's borrowed prompt keys. */
export function handleBtwKey(key: KeyEvent, state: RenderState): BtwKeyResult | null {
  const promptFocused = state.panelFocus === "chat" && state.chatFocus === "prompt";
  const btwFocused = state.panelFocus === "chat" && state.chatFocus === "btw";

  // Ctrl-Q closes BTW from either prompt mode. Other focused panels retain its
  // normal conversation-abort behavior.
  if (state.btw && (promptFocused || btwFocused) && key.type === "ctrl-q") return { type: "btw_close" };

  const btw = state.btw;
  const btwUiAvailable = btw !== null
    && !state.sidebar.prompt
    && !state.sidebar.search?.barOpen
    && !state.search?.barOpen;
  if (!btwUiAvailable || (!promptFocused && !btwFocused)) return null;

  // Match the prompt's attachment stack: Backspace at the left edge removes
  // pending images first. Once none remain, the same gesture dismisses BTW
  // without altering any draft text to the right of the cursor.
  if (promptFocused && key.type === "backspace" && state.cursorPos === 0) {
    if (state.pendingImages.length > 0) return null;
    return { type: "btw_close" };
  }

  // Focused BTW uses the normal history Vim context. Keep only the panel-close
  // shortcut here and let every navigation/selection key reach that shared path.
  if (btwFocused) {
    if (state.vim.mode === "normal" && !vimHasPendingInput(state)
        && key.type === "char" && key.char === "q") return { type: "btw_close" };
    return null;
  }

  // Only standalone normal-mode prompt keys are borrowed by BTW. Visual mode and
  // pending Vim sequences keep their prompt bindings.
  if (state.vim.mode !== "normal" || vimHasPendingInput(state)) return null;
  if (key.type === "char" && key.char === "q") return { type: "btw_close" };
  if ((key.type === "char" && key.char === "k") || key.type === "up") return scrollBtw(state, 1);
  if ((key.type === "char" && key.char === "j") || key.type === "down") return scrollBtw(state, -1);
  return null;
}
