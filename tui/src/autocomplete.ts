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
import { COMMAND_LIST, COMMAND_ARGS, type CompletionItem } from "./commands";
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

// ── Command + macro matching ──────────────────────────────────────

/**
 * Get matching commands and macros for a single-line input starting with "/".
 * Commands and macros are shown in a unified list.
 */
function getCommandMatches(input: string): CompletionItem[] {
  const raw = input.trimStart();
  if (!raw.startsWith("/")) return [];

  // Command argument completion: "/model son", "/convo co", etc.
  for (const [cmd, args] of Object.entries(COMMAND_ARGS)) {
    const re = new RegExp(`^${cmd.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s+(.*)$`, "i");
    const m = raw.match(re);
    if (m) return args.filter(a => a.name.toLowerCase().startsWith(m[1].toLowerCase()));
  }

  // Macro argument completion: "/commit m" → match args for /commit
  for (const [cmd, args] of Object.entries(MACRO_ARGS)) {
    const re = new RegExp(`^${cmd.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s+(.*)$`, "i");
    const m = raw.match(re);
    if (m) return args.filter(a => a.name.toLowerCase().startsWith(m[1].toLowerCase()));
  }

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

  // Macro argument completion: "/commit m" → match args for /commit
  for (const [cmd, args] of Object.entries(MACRO_ARGS)) {
    const re = new RegExp(`^${cmd.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s+(.*)$`, "i");
    const m = raw.match(re);
    if (m) return args.filter(a => a.name.toLowerCase().startsWith(m[1].toLowerCase()));
  }

  const prefix = raw.toLowerCase();
  return MACRO_LIST.filter(c => c.name.startsWith(prefix));
}

// ── Slash token extraction ────────────────────────────────────────

/**
 * Extract a slash-prefixed token at the cursor position.
 * Scans backwards from cursor to find a "/" at a word boundary
 * (start of input or preceded by whitespace).
 *
 * Also handles macro arguments: if the word at cursor doesn't start
 * with "/", looks back one more word. If that word is a "/command",
 * returns the combined "/command arg" token so argument completion works.
 *
 * Returns the token text and its start offset, or null.
 */
function extractSlashToken(
  input: string,
  cursorPos: number,
): { token: string; start: number } | null {
  // Scan backwards from cursor to whitespace or start
  let start = cursorPos;
  while (start > 0 && input[start - 1] !== " " && input[start - 1] !== "\n" && input[start - 1] !== "\t") {
    start--;
  }
  const token = input.slice(start, cursorPos);

  if (token.length === 0) {
    // Cursor is right after whitespace — check if previous word is a /command.
    // This handles "text /commit |" → token="/commit " so arg completion activates.
    if (cursorPos > 0 && input[cursorPos - 1] === " ") {
      let cmdStart = cursorPos - 1;
      while (cmdStart > 0 && input[cmdStart - 1] !== " " && input[cmdStart - 1] !== "\n" && input[cmdStart - 1] !== "\t") {
        cmdStart--;
      }
      const prevWord = input.slice(cmdStart, cursorPos - 1);
      if (prevWord.startsWith("/")) {
        if (cmdStart > 0) {
          const prev = input[cmdStart - 1];
          if (prev !== " " && prev !== "\n" && prev !== "\t") return null;
        }
        return { token: input.slice(cmdStart, cursorPos), start: cmdStart };
      }
    }
    return null;
  }

  if (token.startsWith("/")) {
    // Must be at a word boundary (start of input or after whitespace)
    if (start > 0) {
      const prev = input[start - 1];
      if (prev !== " " && prev !== "\n" && prev !== "\t") return null;
    }
    return { token, start };
  }

  // Token doesn't start with / — look back one more word for "/command arg"
  if (start > 0 && input[start - 1] === " ") {
    let cmdStart = start - 1;
    while (cmdStart > 0 && input[cmdStart - 1] !== " " && input[cmdStart - 1] !== "\n" && input[cmdStart - 1] !== "\t") {
      cmdStart--;
    }
    const prevWord = input.slice(cmdStart, start - 1);
    if (prevWord.startsWith("/")) {
      // Word boundary check for the /command
      if (cmdStart > 0) {
        const prev = input[cmdStart - 1];
        if (prev !== " " && prev !== "\n" && prev !== "\t") return null;
      }
      return { token: input.slice(cmdStart, cursorPos), start: cmdStart };
    }
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
    // For macro arg completion, preserve the "/command " prefix
    let fillText = name;
    if (ac.type === "macro") {
      const spaceIdx = ac.prefix.indexOf(" ");
      if (spaceIdx >= 0) {
        fillText = ac.prefix.slice(0, spaceIdx + 1) + name;
      }
    }
    state.inputBuffer = before + fillText + after;
    state.cursorPos = before.length + fillText.length;
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
