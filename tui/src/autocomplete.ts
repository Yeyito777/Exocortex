/**
 * Autocomplete engine for the prompt line.
 *
 * Manages command and path completion with a popup UI.
 * Command completion activates live when input starts with "/".
 * Path completion triggers on Tab for path-like tokens (~/, ./, ../, /).
 *
 * State lifecycle:
 *   - Typing activates/updates command autocomplete (updateAutocomplete)
 *   - Tab/Shift+Tab cycles through matches (cycleAutocomplete)
 *   - Escape dismisses and restores original text (dismissAutocomplete)
 *   - Enter/newline dismisses without restoring (state.autocomplete = null)
 */

import type { RenderState } from "./state";
import { COMMAND_LIST, MODEL_ARGS, type CompletionItem } from "./commands";
import { readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { homedir } from "os";

// ── Types ───────────────────────────────────────────────────────────

export interface AutocompleteState {
  type: "command" | "path";
  /** Index into matches: -1 = no selection, 0+ = selected item. */
  selection: number;
  /** Original typed text. Used for filtering while Tab-cycling, and for Escape restore. */
  prefix: string;
  /** Start offset of the token being completed in inputBuffer. */
  tokenStart: number;
  /** Filtered matches (cached — recomputed on each keystroke, stable during Tab cycling). */
  matches: CompletionItem[];
}

// ── Command matching ───────────────────────────────────────────────

/** Get matching commands/arguments for the current input. */
function getCommandMatches(input: string): CompletionItem[] {
  const raw = input.trimStart();
  if (!raw.startsWith("/")) return [];

  // Argument completion: "/model " followed by optional partial arg
  const modelArgMatch = raw.match(/^\/model\s+(.*)/i);
  if (modelArgMatch) {
    const argPrefix = modelArgMatch[1].toLowerCase();
    return MODEL_ARGS.filter(a => a.name.startsWith(argPrefix));
  }

  const prefix = raw.toLowerCase();
  return COMMAND_LIST.filter(c => c.name.startsWith(prefix));
}

// ── State management ───────────────────────────────────────────────

/**
 * Update autocomplete state after a keystroke (char, backspace, delete).
 * Activates command autocomplete when input starts with "/",
 * dismisses when it no longer matches.
 */
export function updateAutocomplete(state: RenderState): void {
  // Path popup is dismissed on any typing — user must press Tab again
  if (state.autocomplete?.type === "path") {
    state.autocomplete = null;
  }

  // Command autocomplete: input starts with / and has no newlines
  const trimmed = state.inputBuffer.trimStart();
  if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
    const matches = getCommandMatches(state.inputBuffer);
    if (matches.length > 0) {
      state.autocomplete = {
        type: "command",
        selection: -1,
        prefix: state.inputBuffer,
        tokenStart: 0,
        matches,
      };
      return;
    }
  }

  state.autocomplete = null;
}

/**
 * Cycle through autocomplete matches.
 * direction: 1 = forward (Tab), -1 = backward (Shift+Tab).
 */
export function cycleAutocomplete(state: RenderState, direction: 1 | -1): void {
  const ac = state.autocomplete;
  if (!ac || ac.matches.length === 0) return;

  if (direction === 1) {
    ac.selection = ac.selection < 0 ? 0 : (ac.selection + 1) % ac.matches.length;
  } else {
    ac.selection = ac.selection <= 0 ? ac.matches.length - 1 : ac.selection - 1;
  }

  fillAutocomplete(state, ac.matches[ac.selection].name);
}

/**
 * Fill a match name into the input buffer.
 * For commands: replaces the full buffer (preserving leading whitespace + command prefix for args).
 * For paths: replaces only the token portion.
 */
function fillAutocomplete(state: RenderState, name: string): void {
  const ac = state.autocomplete!;

  if (ac.type === "path") {
    const before = state.inputBuffer.slice(0, ac.tokenStart);
    const after = state.inputBuffer.slice(state.cursorPos);
    state.inputBuffer = before + name + after;
    state.cursorPos = before.length + name.length;
    return;
  }

  // Command: check if we're completing an argument ("/model son")
  const prefix = ac.prefix.trimStart();
  const cmdPart = prefix.match(/^(\/[\w-]+\s+)/i)?.[1];
  if (cmdPart && !name.startsWith("/")) {
    const leading = (ac.prefix.match(/^(\s*)/)?.[1]) ?? "";
    state.inputBuffer = leading + cmdPart + name;
  } else {
    state.inputBuffer = name;
  }
  state.cursorPos = state.inputBuffer.length;
}

/**
 * Dismiss autocomplete, restoring original text if the user was Tab-cycling.
 * Called on Escape (before vim enters normal mode).
 */
export function dismissAutocomplete(state: RenderState): void {
  if (!state.autocomplete) return;

  if (state.autocomplete.type === "command" && state.autocomplete.selection >= 0) {
    // Restore the original typed text
    state.inputBuffer = state.autocomplete.prefix;
    state.cursorPos = state.inputBuffer.length;
  }
  // Path: keep current text (common prefix already filled in, that's useful)

  state.autocomplete = null;
}

// ── Path completion ────────────────────────────────────────────────

/**
 * Try to tab-complete a path token at the cursor.
 * Single match: fills directly (no popup).
 * Multiple matches: fills the common prefix and shows a popup.
 * Returns true if a completion was attempted.
 */
export function tryPathComplete(state: RenderState): boolean {
  const extracted = extractPathToken(state.inputBuffer, state.cursorPos);
  if (!extracted) return false;

  const { token, start } = extracted;
  const matches = getFilesystemMatches(token);
  if (matches.length === 0) return false;

  if (matches.length === 1) {
    // Single match: fill directly, no popup
    const before = state.inputBuffer.slice(0, start);
    const after = state.inputBuffer.slice(state.cursorPos);
    state.inputBuffer = before + matches[0].name + after;
    state.cursorPos = before.length + matches[0].name.length;
    state.autocomplete = null;
    return true;
  }

  // Multiple matches: show popup with first item selected
  const before = state.inputBuffer.slice(0, start);
  const after = state.inputBuffer.slice(state.cursorPos);
  state.inputBuffer = before + matches[0].name + after;
  state.cursorPos = before.length + matches[0].name.length;

  state.autocomplete = {
    type: "path",
    selection: 0,
    prefix: before + token + after,
    tokenStart: start,
    matches,
  };
  return true;
}

// ── Path helpers ───────────────────────────────────────────────────

/**
 * Extract the path token at the cursor position.
 * Scans backwards from cursor to whitespace or start.
 * Returns null if the token doesn't look like a path.
 */
function extractPathToken(
  input: string,
  cursorPos: number,
): { token: string; start: number } | null {
  let start = cursorPos;
  while (start > 0 && input[start - 1] !== " " && input[start - 1] !== "\n" && input[start - 1] !== "\t") {
    start--;
  }
  const token = input.slice(start, cursorPos);
  if (token.length === 0) return null;

  // Must look like a path: ~/..., ./..., ../..., or /... (not bare /)
  if (
    token.startsWith("~/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token === "~" ||
    (token.startsWith("/") && token.length > 1)
  ) {
    return { token, start };
  }

  return null;
}

/** Get filesystem matches for a path prefix. */
function getFilesystemMatches(pathToken: string): CompletionItem[] {
  if (pathToken === "~") {
    return [{ name: "~/", desc: "dir" }];
  }

  const home = homedir();
  let expanded = pathToken;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = home + expanded.slice(1);
  }

  let dir: string;
  let prefix: string;

  if (expanded.endsWith("/")) {
    dir = resolve(expanded);
    prefix = "";
  } else {
    dir = dirname(resolve(expanded));
    prefix = basename(expanded);
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const filtered = entries
      .filter(e => e.name.startsWith(prefix) && !e.name.startsWith("."))
      .sort((a, b) => {
        // Directories first, then alphabetical
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name);
      });

    const tokenDir = pathToken.endsWith("/")
      ? pathToken
      : pathToken.slice(0, pathToken.length - prefix.length);

    return filtered.map(e => {
      const isDir = e.isDirectory();
      return { name: tokenDir + e.name + (isDir ? "/" : ""), desc: isDir ? "dir" : "file" };
    });
  } catch {
    return [];
  }
}

/** Find the longest common prefix among an array of strings. */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}
