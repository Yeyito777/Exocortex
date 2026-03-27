/**
 * Autocomplete engine for the prompt line.
 *
 * Manages command, macro, and path completion with a popup UI.
 * Command completion activates live when input starts with "/".
 * Macro completion activates for slash tokens mid-message.
 * Path completion triggers on Tab for path-like tokens (~/, ./, ../, /).
 *
 * State lifecycle:
 *   - Typing activates/updates command/macro autocomplete (updateAutocomplete)
 *   - Tab/Shift+Tab cycles through matches (cycleAutocomplete)
 *   - Escape dismisses and restores original text (dismissAutocomplete)
 *   - Enter/newline dismisses without restoring (state.autocomplete = null)
 */

import type { RenderState } from "./state";
import { COMMAND_LIST, getCommandArgs, type CompletionItem } from "./commands";
import { MACRO_LIST, MACRO_ARGS } from "./macros";
import { readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { homedir } from "os";

// ── Types ───────────────────────────────────────────────────────────

export interface AutocompleteState {
  type: "command" | "macro" | "path";
  /** Index into matches: -1 = no selection, 0+ = selected item. */
  selection: number;
  /** Original typed text. Used for filtering while Tab-cycling, and for Escape restore. */
  prefix: string;
  /** Start offset of the token being completed in inputBuffer. */
  tokenStart: number;
  /** Filtered matches (cached — recomputed on each keystroke, stable during Tab cycling). */
  matches: CompletionItem[];
}

// ── Argument matching helper ─────────────────────────────────────

/** Escape a string for use in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Try to match argument completion against a registry.
 * If `raw` matches "/command arg…" for any entry in `registry`,
 * returns the filtered argument completions. Otherwise returns null.
 *
 * Entries are tried longest-key-first so deeper matches (e.g. "/tool install")
 * take priority over shallower ones (e.g. "/tool").
 */
function matchArgCompletion(
  raw: string,
  registry: Record<string, CompletionItem[]>,
): CompletionItem[] | null {
  const entries = Object.entries(registry).sort((a, b) => b[0].length - a[0].length);
  for (const [cmd, args] of entries) {
    const re = new RegExp(`^${escapeRegex(cmd)}\\s+(.*)$`, "i");
    const m = raw.match(re);
    if (m) return args.filter(a => a.name.toLowerCase().startsWith(m[1].toLowerCase()));
  }
  return null;
}

// ── Command + macro matching ──────────────────────────────────────

/**
 * Get matching commands and macros for a single-line input starting with "/".
 * Commands and macros are shown in a unified list.
 */
function getCommandMatches(state: RenderState, input: string): CompletionItem[] {
  const raw = input.trimStart();
  if (!raw.startsWith("/")) return [];

  // Argument completion against both command and macro registries
  const argMatch = matchArgCompletion(raw, getCommandArgs(state)) ?? matchArgCompletion(raw, MACRO_ARGS);
  if (argMatch) return argMatch;

  const prefix = raw.toLowerCase();
  const combined = [...COMMAND_LIST, ...MACRO_LIST];
  return combined.filter(c => c.name.startsWith(prefix));
}

/**
 * Get matching macros for a slash token mid-message.
 * Only macros are valid mid-message (not commands).
 */
function getMacroMatches(token: string): CompletionItem[] {
  const raw = token.trimStart();
  if (!raw.startsWith("/")) return [];

  const argMatch = matchArgCompletion(raw, MACRO_ARGS);
  if (argMatch) return argMatch;

  const prefix = raw.toLowerCase();
  return MACRO_LIST.filter(c => c.name.startsWith(prefix));
}

// ── Token scanning ────────────────────────────────────────────────

/** Check if a character is whitespace (space, newline, tab). */
function isWS(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

/**
 * Scan backwards from `pos` to find the start of the current token.
 * A token is delimited by whitespace (space, newline, tab) or input start.
 */
function tokenStart(input: string, pos: number): number {
  let start = pos;
  while (start > 0 && !isWS(input[start - 1])) start--;
  return start;
}

/** Check if `pos` is at a word boundary (start of input or preceded by whitespace). */
function atWordBoundary(input: string, pos: number): boolean {
  return pos === 0 || isWS(input[pos - 1]);
}

// ── Slash token extraction ────────────────────────────────────────

/**
 * Extract a slash-prefixed token at the cursor position.
 * Scans backwards across multiple words from the cursor to find a word
 * starting with "/" at a word boundary (start of input or after whitespace).
 *
 * Handles arbitrarily deep macro arguments: "/tool install discord"
 * is returned as a single token when the cursor is anywhere after "/tool".
 *
 * Returns the token text and its start offset, or null.
 */
function extractSlashToken(
  input: string,
  cursorPos: number,
): { token: string; start: number } | null {
  const wordStart = tokenStart(input, cursorPos);
  const currentWord = input.slice(wordStart, cursorPos);

  // If the current word starts with /, we found the token directly
  if (currentWord.startsWith("/") && atWordBoundary(input, wordStart)) {
    return { token: currentWord, start: wordStart };
  }

  // Walk backward through preceding words to find one starting with "/"
  let scanPos = wordStart;
  while (scanPos > 0 && input[scanPos - 1] === " ") {
    const prevStart = tokenStart(input, scanPos - 1);
    const prevWord = input.slice(prevStart, scanPos - 1);

    if (prevWord.startsWith("/") && atWordBoundary(input, prevStart)) {
      return { token: input.slice(prevStart, cursorPos), start: prevStart };
    }

    scanPos = prevStart;
  }

  return null;
}

// ── State management ───────────────────────────────────────────────

/**
 * Update autocomplete state after a keystroke (char, backspace, delete).
 * Activates command autocomplete when input starts with "/".
 * Activates macro autocomplete for slash tokens mid-message.
 * Dismisses when it no longer matches.
 */
export function updateAutocomplete(state: RenderState): void {
  // Path popup is dismissed on any typing — user must press Tab again
  if (state.autocomplete?.type === "path") {
    state.autocomplete = null;
  }

  // Command + macro autocomplete: single-line input starts with /
  const trimmed = state.inputBuffer.trimStart();
  if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
    const matches = getCommandMatches(state, state.inputBuffer);
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

  // Mid-message macro autocomplete: slash token at cursor position
  const slashToken = extractSlashToken(state.inputBuffer, state.cursorPos);
  if (slashToken) {
    const matches = getMacroMatches(slashToken.token);
    if (matches.length > 0) {
      state.autocomplete = {
        type: "macro",
        selection: -1,
        prefix: slashToken.token,
        tokenStart: slashToken.start,
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
 * For commands (tokenStart 0): replaces the full buffer (preserving leading whitespace + command prefix for args).
 * For macros / paths: replaces only the token portion.
 */
function fillAutocomplete(state: RenderState, name: string): void {
  const ac = state.autocomplete!;

  if (ac.type === "path" || ac.type === "macro") {
    const before = state.inputBuffer.slice(0, ac.tokenStart);
    const after = state.inputBuffer.slice(state.cursorPos);
    // For macro arg completion, preserve the "/command arg1 ..." prefix
    let fillText = name;
    if (ac.type === "macro") {
      const spaceIdx = ac.prefix.lastIndexOf(" ");
      if (spaceIdx >= 0) {
        fillText = ac.prefix.slice(0, spaceIdx + 1) + name;
      }
    }
    state.inputBuffer = before + fillText + after;
    state.cursorPos = before.length + fillText.length;
    return;
  }

  // Command: check if we're completing an argument ("/tool install disc" → "/tool install discord")
  if (!name.startsWith("/")) {
    // Completing an argument — preserve everything before the last word
    const lastSpace = ac.prefix.lastIndexOf(" ");
    if (lastSpace >= 0) {
      state.inputBuffer = ac.prefix.slice(0, lastSpace + 1) + name;
    } else {
      state.inputBuffer = name;
    }
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

  if (state.autocomplete.type === "macro" && state.autocomplete.selection >= 0) {
    // Restore just the token portion to the original prefix
    const ac = state.autocomplete;
    const before = state.inputBuffer.slice(0, ac.tokenStart);
    const after = state.inputBuffer.slice(state.cursorPos);
    state.inputBuffer = before + ac.prefix + after;
    state.cursorPos = ac.tokenStart + ac.prefix.length;
  }
  // Path: keep current text (common prefix already filled in, that's useful)

  state.autocomplete = null;
}

// ── Path completion ────────────────────────────────────────────────

/**
 * Try to tab-complete a path token at the cursor.
 * For /-prefixed tokens, also includes matching macros.
 * Single match: fills directly (no popup).
 * Multiple matches: fills the common prefix and shows a popup.
 * Returns true if a completion was attempted.
 */
export function tryPathComplete(state: RenderState): boolean {
  const extracted = extractPathToken(state.inputBuffer, state.cursorPos);
  if (!extracted) return false;

  const { token, start } = extracted;
  const fsMatches = getFilesystemMatches(token);

  // For /-prefixed tokens, also include macro matches
  let macroMatches: CompletionItem[] = [];
  if (token.startsWith("/")) {
    macroMatches = getMacroMatches(token);
  }

  const matches = [...fsMatches, ...macroMatches];
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
  const start = tokenStart(input, cursorPos);
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
      .filter(e => e.name.startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
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

