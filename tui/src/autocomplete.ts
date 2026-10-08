/**
 * Autocomplete engine for the prompt line.
 *
 * Manages command, macro, inline-command, and path completion with a popup UI.
 * Command completion activates live when input starts with "/". Slash words
 * are exact substrings matched anywhere in a name, and later words search
 * nested arguments ("/model opus" → "/model anthropic claude-opus-5-5").
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
import { COMMAND_LIST, getCommandArgs, type CompletionItem } from "./commands";
import { MACRO_LIST, getMacroArgs, macroEnvironmentForState } from "./macros";
import { INLINE_COMMANDS, getInlineCommandArgs } from "./inlineeffort";
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
  matches: CompletionItem[];
}

/**
 * Optional non-local filesystem source. A null result is a cache miss; the
 * provider calls `onReady` after hydrating it so the original Tab can finish.
 */
export interface PathCompletionProvider {
  getFilesystemMatches(pathToken: string): CompletionItem[] | null;
  requestFilesystemMatches(pathToken: string, onReady?: () => void): void;
}

// ── Slash completion search ───────────────────────────────────────

/** Nested argument completions available below a slash root, keyed by "/root arg …". */
type ArgRegistryFor = (rootName: string) => Record<string, CompletionItem[]>;

interface SlashQuery {
  /** Lowercased whitespace-separated words. */
  words: string[];
  /** The query ends in whitespace, so its final word must be followed by a space. */
  trailingSpace: boolean;
}

function completionInsertText(item: CompletionItem): string {
  return item.insertText ?? item.name;
}

function hasArgumentPrefix(raw: string): boolean {
  return /\s/.test(raw);
}

function slashBase(raw: string): string {
  return raw.split(/\s+/, 1)[0] ?? raw;
}

function parseSlashQuery(text: string): SlashQuery {
  return {
    words: text.toLowerCase().split(/\s+/).filter(Boolean),
    trailingSpace: /\s$/.test(text),
  };
}

/** Lowercased strings a segment can match: its name, insert text, and aliases. */
function segmentForms(item: CompletionItem, isRoot: boolean): string[] {
  const forms = [item.name, ...(item.insertText ? [item.insertText] : []), ...(item.aliases ?? [])];
  // Root names match without their slash so "/del" can find "/model".
  return forms.map(form => (isRoot ? form.replace(/^\//, "") : form).toLowerCase());
}

/** 0 = starts a segment, 1 = starts after punctuation or a space, 2 = mid-word. */
function wordMatchQuality(text: string, at: number, segmentStart: number): number {
  if (at === segmentStart) return 0;
  return /[\p{L}\p{N}]/u.test(text[at - 1]) ? 2 : 1;
}

/**
 * Score a completion path (lowercased segments) against query words; lower is
 * better and null means no match.
 *
 * Each word is an exact substring. A later word either continues the previous
 * one after a single space (multi-word names such as conversation titles) or
 * starts in a later segment, so "opus" can skip the provider segment and land
 * in "claude-opus-5-5". The final word must land in the final segment, or with
 * a trailing space be followed by a space that leads into it.
 */
function scoreCompletionPath(segments: readonly string[], query: SlashQuery, firstWordSegment?: number): number | null {
  const { words, trailingSpace } = query;
  if (words.length === 0) return null;

  const text = segments.join(" ");
  const starts: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    starts.push(offset);
    offset += segment.length + 1;
  }
  const segmentAt = (index: number): number => {
    let segment = 0;
    while (segment + 1 < starts.length && starts[segment + 1] <= index) segment++;
    return segment;
  };
  const lastSegment = segments.length - 1;

  const search = (wordIndex: number, prevEnd: number, prevSegment: number): number | null => {
    const word = words[wordIndex];
    for (let at = text.indexOf(word, prevEnd); at >= 0; at = text.indexOf(word, at + 1)) {
      const segment = segmentAt(at);
      if (wordIndex === 0) {
        if (firstWordSegment !== undefined && segment !== firstWordSegment) continue;
      } else if (segment <= prevSegment && !(at === prevEnd + 1 && text[prevEnd] === " ")) {
        continue;
      }

      const end = at + word.length;
      const quality = wordMatchQuality(text, at, starts[segment]);
      if (wordIndex === words.length - 1) {
        const landsInLast = trailingSpace
          ? text[end] === " " && end + 1 < text.length && segmentAt(end + 1) === lastSegment
          : segment === lastSegment;
        if (landsInLast) return quality;
        continue;
      }

      const rest = search(wordIndex + 1, end, segment);
      if (rest !== null) return quality + rest;
    }
    return null;
  };

  return search(0, 0, 0);
}

/** Best score across the final segment's names/aliases. */
function scorePath(path: readonly CompletionItem[], query: SlashQuery, includesRoot: boolean): number | null {
  const lastWord = query.words[query.words.length - 1];
  const lastForms = segmentForms(path[path.length - 1], includesRoot && path.length === 1);
  // Cheap reject: without a trailing space the final word must sit inside the final segment.
  const forms = query.trailingSpace ? lastForms : lastForms.filter(form => form.includes(lastWord));
  if (forms.length === 0) return null;

  const parents = path.slice(0, -1).map((item, i) => segmentForms(item, includesRoot && i === 0)[0]);
  let best: number | null = null;
  for (const form of forms) {
    const score = scoreCompletionPath([...parents, form], query, includesRoot ? 0 : undefined);
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

/** Depth-first walk of every completion path below `key`. */
function* completionPaths(
  registry: Record<string, CompletionItem[]>,
  key: string,
  parents: readonly CompletionItem[],
): Generator<CompletionItem[]> {
  for (const item of registry[key] ?? []) {
    const path = [...parents, item];
    yield path;
    yield* completionPaths(registry, `${key} ${item.name}`, path);
  }
}

/** One popup row for a path; the insert text always spells out the full slash input. */
function pathCompletion(path: readonly CompletionItem[], typedPrefix = ""): CompletionItem {
  const last = path[path.length - 1];
  if (path.length === 1 && !typedPrefix) return last;
  return {
    name: path.map(item => item.name).join(" "),
    desc: last.desc,
    ...(last.colorSwatches ? { colorSwatches: last.colorSwatches } : {}),
    insertText: typedPrefix + path.map(completionInsertText).join(" "),
  };
}

/** Shallow paths first, then stronger matches; ties keep registry order. */
function rankPaths(
  paths: Iterable<readonly CompletionItem[]>,
  query: SlashQuery,
  includesRoot: boolean,
  typedPrefix?: string,
): CompletionItem[] {
  const ranked: { path: readonly CompletionItem[]; score: number }[] = [];
  for (const path of paths) {
    const score = scorePath(path, query, includesRoot);
    if (score !== null) ranked.push({ path, score });
  }
  ranked.sort((a, b) => a.path.length - b.path.length || a.score - b.score);
  return ranked.map(({ path }) => pathCompletion(path, typedPrefix));
}

/**
 * Search below the deepest registry key the input spells out exactly, e.g.
 * "/model " or "/model openai ". Returns null when no key is spelled out.
 */
function searchAnchoredArgs(raw: string, registry: Record<string, CompletionItem[]>): CompletionItem[] | null {
  const keys = Object.keys(registry).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (raw.slice(0, key.length).toLowerCase() !== key.toLowerCase() || !/\s/.test(raw[key.length] ?? "")) continue;
    const rest = raw.slice(key.length).trimStart();
    const typedPrefix = raw.slice(0, raw.length - rest.length);
    const query = parseSlashQuery(rest);
    if (query.words.length === 0) {
      return (registry[key] ?? []).map(item => pathCompletion([item], typedPrefix));
    }
    return rankPaths(completionPaths(registry, key, []), query, false, typedPrefix);
  }
  return null;
}

/**
 * Search slash roots by substring. The first word must match the root name;
 * any further words search that root's nested arguments.
 */
function searchRoots(raw: string, roots: readonly CompletionItem[], argsFor: ArgRegistryFor): CompletionItem[] {
  const body = raw.slice(1);
  if (body === "") return [...roots];
  if (/^\s/.test(body)) return [];

  const query = parseSlashQuery(body);
  const [rootWord] = query.words;
  const searchArgs = query.words.length > 1 || query.trailingSpace;
  const paths: CompletionItem[][] = [];
  for (const root of roots) {
    if (!segmentForms(root, true)[0].includes(rootWord)) continue;
    paths.push([root]);
    if (searchArgs) paths.push(...completionPaths(argsFor(root.name), root.name, [root]));
  }
  return rankPaths(paths, query, true);
}

/**
 * Exact-substring slash completion across roots and their nested arguments.
 * A fully typed command path anchors the search; otherwise roots are searched
 * by substring, so "/model opus" finds "/model anthropic claude-opus-5-5".
 */
function searchSlashCompletions(raw: string, roots: readonly CompletionItem[], argsFor: ArgRegistryFor): CompletionItem[] {
  if (!raw.startsWith("/")) return [];
  if (hasArgumentPrefix(raw)) {
    const anchored = searchAnchoredArgs(raw, argsFor(slashBase(raw)));
    if (anchored) return anchored;
  }
  return searchRoots(raw, roots, argsFor);
}

/** Merge macro arguments with one command registry; macros are discovered at most once per search. */
function slashArgRegistry(
  state: RenderState,
  commandArgs: (state: RenderState, commandName: string) => Record<string, CompletionItem[]>,
): ArgRegistryFor {
  let macroArgs: Record<string, CompletionItem[]> | undefined;
  return (rootName) => {
    macroArgs ??= getMacroArgs(undefined, macroEnvironmentForState(state));
    return { ...macroArgs, ...commandArgs(state, rootName) };
  };
}

// ── Command + macro matching ──────────────────────────────────────

/**
 * Get matching commands and macros for a single-line input starting with "/".
 * Commands and macros are shown in a unified list.
 */
function getCommandMatches(state: RenderState, input: string): CompletionItem[] {
  return searchSlashCompletions(input.trimStart(), [...COMMAND_LIST, ...MACRO_LIST], slashArgRegistry(state, getCommandArgs));
}

/**
 * Get matching inline slash completions for a token mid-message.
 * Only macros and explicitly registered inline commands are valid here; no other
 * commands should be offered or treated as macro-like mid-prompt commands.
 */
function getInlineSlashMatches(state: RenderState, token: string): CompletionItem[] {
  return searchSlashCompletions(token.trimStart(), [...MACRO_LIST, ...INLINE_COMMANDS], slashArgRegistry(state, getInlineCommandArgs));
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
    const matches = getCommandMatches(state, state.inputBuffer);
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
    const matches = getInlineSlashMatches(state, slashToken.token);
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
    macroMatches = getInlineSlashMatches(state, token);
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
