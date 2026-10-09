/**
 * Autocomplete engine for the prompt line.
 *
 * Manages command, macro, inline-command, and path completion with a popup UI.
 * Command completion activates live when input starts with "/"; matching is
 * the substring/nested-argument search in slashsearch.ts.
 * Macro completion activates for slash tokens mid-message; only explicitly
 * registered inline commands participate in this mid-message path.
 * Path completion triggers on Tab for path-like tokens (~/, ./, ../, /).
 *
 * State lifecycle:
 *   - Typing activates/updates command/macro autocomplete (updateAutocomplete)
 *   - Tab/Shift+Tab cycles through matches (cycleAutocomplete)
 *   - Escape from insert mode accepts the current completion and closes the popup
 *   - Explicit cancellation can restore original text (dismissAutocomplete)
 *   - Enter/newline dismisses without restoring (state.autocomplete = null)
 */

import type { RenderState } from "./state";
import type { CompletionItem } from "./commands";
import { commandCompletions, completionInsertText, inlineSlashCompletions, type SlashCompletion } from "./slashsearch";
import { readdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { PathDirectoryEntry } from "./protocol";

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
  matches: SlashCompletion[];
}

/**
 * Optional non-local filesystem source. A null result is a cache miss; the
 * provider calls `onReady` after hydrating it so the original Tab can finish.
 */
export interface PathCompletionProvider {
  getFilesystemMatches(pathToken: string): CompletionItem[] | null;
  requestFilesystemMatches(pathToken: string, onReady?: () => void): void;
}

// ── Token scanning ────────────────────────────────────────────────

/** Check if a character is whitespace (space, newline, tab). */
function isWS(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

function firstNonWhitespaceIndex(input: string): number {
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    if (char.trimStart() !== "") break;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return i;
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
  const safeCursor = Math.max(0, Math.min(cursorPos, input.length));
  if (safeCursor <= 0) return null;

  const searchFrom = safeCursor - 1;
  const lastNewline = input.lastIndexOf("\n", searchFrom);
  const lastTab = input.lastIndexOf("\t", searchFrom);
  const segmentStart = Math.max(lastNewline, lastTab) + 1;

  // Find the nearest slash-prefixed word in the current space-separated segment.
  // This preserves multi-word macro args while avoiding an O(words-before-cursor)
  // backwards scan on every keystroke in long ordinary prompts.
  let slash = input.lastIndexOf("/", searchFrom);
  while (slash >= segmentStart) {
    if (atWordBoundary(input, slash)) {
      return { token: input.slice(slash, safeCursor), start: slash };
    }
    slash = input.lastIndexOf("/", slash - 1);
  }
  return null;
}

// ── State management ───────────────────────────────────────────────

/**
 * Update autocomplete state after a keystroke (char, backspace, delete).
 * Activates command autocomplete when input starts with "/".
 * Activates macro autocomplete for slash tokens mid-message, plus explicitly
 * registered inline commands.
 * Dismisses when it no longer matches.
 */
export function updateAutocomplete(state: RenderState): void {
  // Path popup is dismissed on any typing — user must press Tab again
  if (state.autocomplete?.type === "path") {
    state.autocomplete = null;
  }

  // Command + macro autocomplete: single-line input starts with /
  const firstNonWs = firstNonWhitespaceIndex(state.inputBuffer);
  if (state.inputBuffer[firstNonWs] === "/" && state.inputBuffer.indexOf("\n", firstNonWs) === -1) {
    const matches = commandCompletions(state, state.inputBuffer);
    if (matches.length > 0) {
      state.autocomplete = {
        type: "command",
        selection: -1,
        prefix: state.inputBuffer,
        tokenStart: firstNonWs,
        matches,
      };
      return;
    }
  }

  // Mid-message slash autocomplete: macros plus explicitly registered inline commands
  const slashToken = extractSlashToken(state.inputBuffer, state.cursorPos);
  if (slashToken) {
    const matches = inlineSlashCompletions(state, slashToken.token);
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

  fillAutocomplete(state, ac.matches[ac.selection]);
}

/**
 * Fill a match into the input buffer. Slash completions carry the full slash
 * input as insert text, so every type replaces only its token: the whole
 * single-line prompt (after leading whitespace) for commands, or the token
 * before the cursor for macros / paths.
 */
function fillAutocomplete(state: RenderState, item: CompletionItem): void {
  const ac = state.autocomplete!;
  const before = state.inputBuffer.slice(0, ac.tokenStart);
  const after = ac.type === "command" ? "" : state.inputBuffer.slice(state.cursorPos);
  const fillText = completionInsertText(item);
  state.inputBuffer = before + fillText + after;
  state.cursorPos = before.length + fillText.length;
}

/**
 * Dismiss autocomplete, restoring original text if the user was Tab-cycling.
 * This is for explicit cancellation; vim Escape uses acceptAutocomplete so
 * leaving insert mode does not undo the selected completion.
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

/**
 * Accept the currently displayed completion text and close the popup.
 * Used when Escape is also leaving insert mode: vim's Escape should not
 * undo a completion the user already cycled to with Tab.
 */
export function acceptAutocomplete(state: RenderState): void {
  state.autocomplete = null;
}

// ── Path completion ────────────────────────────────────────────────

/**
 * Try to tab-complete a path token at the cursor.
 * For /-prefixed tokens, also includes matching macros and inline commands.
 * Single match: fills directly (no popup).
 * Multiple matches: fills the common prefix and shows a popup.
 * Returns true if a completion was attempted.
 */
export function tryPathComplete(
  state: RenderState,
  provider?: PathCompletionProvider,
): boolean {
  const extracted = extractPathToken(state.inputBuffer, state.cursorPos);
  if (!extracted) return false;

  const { token, start } = extracted;
  const fsMatches = provider
    ? provider.getFilesystemMatches(token)
    : getFilesystemMatches(token);

  if (fsMatches === null) {
    // Never fall back to the TUI host while routed through SSH. Finish this Tab
    // asynchronously only if the prompt is still exactly where the user left it.
    const expectedBuffer = state.inputBuffer;
    const expectedCursorPos = state.cursorPos;
    provider!.requestFilesystemMatches(token, () => {
      if (state.inputBuffer !== expectedBuffer
          || state.cursorPos !== expectedCursorPos
          || state.autocomplete !== null) return;
      tryPathComplete(state, provider);
    });
    return true;
  }

  // For /-prefixed tokens, also include macro and inline-command matches
  let macroMatches: CompletionItem[] = [];
  if (token.startsWith("/")) {
    macroMatches = inlineSlashCompletions(state, token);
  }

  const matches = [...fsMatches, ...macroMatches];
  if (matches.length === 0) return false;

  if (matches.length === 1) {
    // Single match: fill directly, no popup
    const before = state.inputBuffer.slice(0, start);
    const after = state.inputBuffer.slice(state.cursorPos);
    const fillText = completionInsertText(matches[0]);
    state.inputBuffer = before + fillText + after;
    state.cursorPos = before.length + fillText.length;
    state.autocomplete = null;
    return true;
  }

  // Multiple matches: show popup with first item selected
  const before = state.inputBuffer.slice(0, start);
  const after = state.inputBuffer.slice(state.cursorPos);
  const fillText = completionInsertText(matches[0]);
  state.inputBuffer = before + fillText + after;
  state.cursorPos = before.length + fillText.length;

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
export function extractPathToken(
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

export interface PathTokenParts {
  directory: string;
  prefix: string;
}

/** Split a supported path token into its prompt-spelled directory and basename. */
export function pathTokenParts(pathToken: string): PathTokenParts | null {
  if (pathToken === "~") return { directory: "~/", prefix: "" };
  const slash = pathToken.lastIndexOf("/");
  if (slash < 0) return null;
  return {
    directory: pathToken.slice(0, slash + 1),
    prefix: pathToken.slice(slash + 1),
  };
}

/** Convert a cacheable directory listing into prompt insertion candidates. */
export function filesystemMatchesFromEntries(
  pathToken: string,
  entries: readonly PathDirectoryEntry[],
): CompletionItem[] {
  const parts = pathTokenParts(pathToken);
  if (!parts) return [];
  const { directory, prefix } = parts;
  return entries
    .filter(entry => entry.name.startsWith(prefix) && (prefix.startsWith(".") || !entry.name.startsWith(".")))
    .sort((a, b) => {
      const aDir = a.type === "dir" ? 0 : 1;
      const bDir = b.type === "dir" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    })
    .map(entry => ({
      name: `${directory}${entry.name}${entry.type === "dir" ? "/" : ""}`,
      desc: entry.type,
    }));
}

/** Get filesystem matches for a path prefix on the TUI's local host. */
export function getFilesystemMatches(pathToken: string): CompletionItem[] {
  if (pathToken === "~") {
    return [{ name: "~/", desc: "dir" }];
  }

  const parts = pathTokenParts(pathToken);
  if (!parts) return [];

  const home = homedir();
  let expandedDirectory = parts.directory;
  if (expandedDirectory.startsWith("~/")) {
    expandedDirectory = home + expandedDirectory.slice(1);
  }

  try {
    const entries = readdirSync(resolve(expandedDirectory), { withFileTypes: true })
      .map<PathDirectoryEntry>(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
      }));
    return filesystemMatchesFromEntries(pathToken, entries);
  } catch {
    return [];
  }
}
