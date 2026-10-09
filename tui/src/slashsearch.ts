/**
 * Slash command search shared by the autocomplete popup, prompt highlighting,
 * and submission.
 *
 * Words are case-insensitive exact substrings matched anywhere in a command or
 * argument name, and later words search nested arguments, so "/model opus"
 * finds "/model anthropic claude-opus-5-5". Submission expands such shorthands
 * to the first ranked completion, the popup's first row (findSlashShorthands).
 */

import type { RenderState } from "./state";
import { COMMAND_LIST, getCommandArgs, type CompletionItem } from "./commands";
import { MACRO_LIST, getMacroArgs, macroEnvironmentForState } from "./macros";
import { INLINE_COMMANDS, getInlineCommandArgs } from "./inlineeffort";

// ── Types ───────────────────────────────────────────────────────────

/** Half-open character range into a completion's display name. */
export interface MatchRange {
  start: number;
  end: number;
}

/** A ranked slash completion; `matchRanges` mark the matched text in `name`. */
export interface SlashCompletion extends CompletionItem {
  matchRanges?: readonly MatchRange[];
}

/** A typed shorthand that submission expands, e.g. "/model opus". */
export interface SlashShorthand {
  start: number;
  end: number;
  replacement: string;
}

type ArgRegistry = Record<string, CompletionItem[]>;

/** Nested argument completions available below a slash root, keyed by "/root arg …". */
type ArgRegistryFor = (rootName: string) => ArgRegistry;

interface SlashQuery {
  /** Lowercased whitespace-separated words. */
  words: string[];
  /** The query ends in whitespace, so its final word must be followed by a space. */
  trailingSpace: boolean;
}

interface PathMatch {
  /** Sum of word match qualities; lower is better. */
  score: number;
  /** Matched word ranges in the space-joined segment text. */
  ranges: MatchRange[];
}

interface RankedCompletion {
  completion: SlashCompletion;
  depth: number;
  score: number;
}

// ── Query parsing ───────────────────────────────────────────────────

export function completionInsertText(item: CompletionItem): string {
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

// ── Path matching ───────────────────────────────────────────────────

/** Lowercased strings a segment can match: its name, insert text, and aliases. */
function segmentForms(item: CompletionItem, isRoot: boolean): string[] {
  // Root names match without their slash so "/del" can find "/model".
  const normalize = (form: string) => (isRoot ? form.slice(1) : form).toLowerCase();
  if (!item.insertText && !item.aliases?.length) return [normalize(item.name)];
  return [item.name, ...(item.insertText ? [item.insertText] : []), ...(item.aliases ?? [])].map(normalize);
}

/** 0 = the whole segment, 1 = starts the segment, 2 = starts after punctuation or a space, 3 = mid-word. */
function wordMatchQuality(text: string, at: number, end: number, segmentStart: number, segmentEnd: number): number {
  if (at === segmentStart) return end === segmentEnd ? 0 : 1;
  return /[\p{L}\p{N}]/u.test(text[at - 1]) ? 3 : 2;
}

/**
 * Match query words against a completion path (lowercased segments).
 *
 * Each word is an exact substring. A later word either continues the previous
 * one after a single space (multi-word names such as conversation titles) or
 * starts in a later segment, so "opus" can skip the provider segment and land
 * in "claude-opus-5-5". The final word must land in the final segment, or with
 * a trailing space be followed by a space that leads into it.
 */
function matchCompletionPath(
  segments: readonly string[],
  query: SlashQuery,
  firstWordSegment?: number,
): PathMatch | null {
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
  const ranges: MatchRange[] = [];

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
      const quality = wordMatchQuality(text, at, end, starts[segment], starts[segment] + segments[segment].length);

      if (wordIndex === words.length - 1) {
        const landsInLast = trailingSpace
          ? text[end] === " " && end + 1 < text.length && segmentAt(end + 1) === lastSegment
          : segment === lastSegment;
        if (!landsInLast) continue;
        ranges[wordIndex] = { start: at, end };
        return quality;
      }

      const rest = search(wordIndex + 1, end, segment);
      if (rest !== null) {
        ranges[wordIndex] = { start: at, end };
        return quality + rest;
      }
    }
    return null;
  };

  const score = search(0, 0, 0);
  return score === null ? null : { score, ranges };
}

/** Best match across the final segment's name, insert text, and aliases; ranges always come from the name. */
function matchPath(
  path: readonly CompletionItem[],
  query: SlashQuery,
  includesRoot: boolean,
): PathMatch | null {
  const lastWord = query.words[query.words.length - 1];
  const lastForms = segmentForms(path[path.length - 1], includesRoot && path.length === 1);
  // Cheap reject: without a trailing space the final word must sit inside the final segment.
  if (!query.trailingSpace && !lastForms.some(form => form.includes(lastWord))) return null;
  const parents = path.slice(0, -1).map((item, i) => segmentForms(item, includesRoot && i === 0)[0]);

  let best: PathMatch | null = null;
  let nameRanges: MatchRange[] = [];
  for (let i = 0; i < lastForms.length; i++) {
    if (!query.trailingSpace && !lastForms[i].includes(lastWord)) continue;
    const match = matchCompletionPath([...parents, lastForms[i]], query, includesRoot ? 0 : undefined);
    if (!match) continue;
    if (i === 0) nameRanges = match.ranges;
    if (!best || match.score < best.score) best = match;
  }
  return best && { score: best.score, ranges: nameRanges };
}

// ── Ranked search ───────────────────────────────────────────────────

/** Depth-first walk of every completion path below `key`. */
function* completionPaths(
  registry: ArgRegistry,
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
function pathCompletion(
  path: readonly CompletionItem[],
  typedPrefix = "",
  textRanges: readonly MatchRange[] = [],
): SlashCompletion {
  const last = path[path.length - 1];
  const name = path.map(item => item.name).join(" ");
  // Root segments match without their slash; skip ranges if lowercasing changed lengths.
  const offset = name.startsWith("/") ? 1 : 0;
  const matchRanges = textRanges.length > 0 && name.toLowerCase().length === name.length
    ? textRanges.map(range => ({ start: range.start + offset, end: range.end + offset }))
    : [];
  const highlight = matchRanges.length > 0 ? { matchRanges } : {};

  if (path.length === 1 && !typedPrefix) return { ...last, ...highlight };
  return {
    name,
    desc: last.desc,
    ...(last.colorSwatches ? { colorSwatches: last.colorSwatches } : {}),
    insertText: typedPrefix + path.map(completionInsertText).join(" "),
    ...highlight,
  };
}

/** Shallow paths first, then stronger matches; ties keep registry order. */
function rankPaths(
  paths: Iterable<readonly CompletionItem[]>,
  query: SlashQuery,
  includesRoot: boolean,
  typedPrefix?: string,
): RankedCompletion[] {
  const ranked: RankedCompletion[] = [];
  for (const path of paths) {
    const match = matchPath(path, query, includesRoot);
    if (match) {
      ranked.push({ completion: pathCompletion(path, typedPrefix, match.ranges), depth: path.length, score: match.score });
    }
  }
  return ranked.sort((a, b) => a.depth - b.depth || a.score - b.score);
}

/**
 * Search below the deepest registry key the input spells out exactly, e.g.
 * "/model " or "/model openai ". Returns null when no key is spelled out.
 */
function searchAnchoredArgs(raw: string, registry: ArgRegistry): RankedCompletion[] | null {
  const keys = Object.keys(registry).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (raw.slice(0, key.length).toLowerCase() !== key.toLowerCase() || !/\s/.test(raw[key.length] ?? "")) continue;
    const rest = raw.slice(key.length).trimStart();
    const typedPrefix = raw.slice(0, raw.length - rest.length);
    const query = parseSlashQuery(rest);
    if (query.words.length === 0) {
      return (registry[key] ?? []).map(item => ({ completion: pathCompletion([item], typedPrefix), depth: 1, score: 0 }));
    }
    return rankPaths(completionPaths(registry, key, []), query, false, typedPrefix);
  }
  return null;
}

/**
 * Search slash roots by substring. The first word must match the root name;
 * any further words search that root's nested arguments.
 */
function searchRoots(raw: string, roots: readonly CompletionItem[], argsFor: ArgRegistryFor): SlashCompletion[] {
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
  return rankPaths(paths, query, true).map(ranked => ranked.completion);
}

/** A fully typed command path anchors the search; otherwise roots are searched by substring. */
function searchSlashCompletions(raw: string, roots: readonly CompletionItem[], argsFor: ArgRegistryFor): SlashCompletion[] {
  if (!raw.startsWith("/")) return [];
  if (hasArgumentPrefix(raw)) {
    const anchored = searchAnchoredArgs(raw, argsFor(slashBase(raw)));
    if (anchored) return anchored.map(ranked => ranked.completion);
  }
  return searchRoots(raw, roots, argsFor);
}

/** Merge macro arguments with one command registry; macros are discovered at most once per search. */
function slashArgRegistry(
  state: RenderState,
  commandArgs: (state: RenderState, commandName: string) => ArgRegistry,
): ArgRegistryFor {
  let macroArgs: ArgRegistry | undefined;
  return (rootName) => {
    macroArgs ??= getMacroArgs(undefined, macroEnvironmentForState(state));
    return { ...macroArgs, ...commandArgs(state, rootName) };
  };
}

// ── Popup completions ───────────────────────────────────────────────

/**
 * Completions for a single-line input starting with "/".
 * Commands and macros are shown in a unified list.
 */
export function commandCompletions(state: RenderState, input: string): SlashCompletion[] {
  return searchSlashCompletions(input.trimStart(), [...COMMAND_LIST, ...MACRO_LIST], slashArgRegistry(state, getCommandArgs));
}

/**
 * Completions for a slash token mid-message. Only macros and explicitly
 * registered inline commands are valid here.
 */
export function inlineSlashCompletions(state: RenderState, token: string): SlashCompletion[] {
  return searchSlashCompletions(token.trimStart(), [...MACRO_LIST, ...INLINE_COMMANDS], slashArgRegistry(state, getInlineCommandArgs));
}

// ── Shorthand resolution ────────────────────────────────────────────

/** Inline modifiers resolve words up to the prose that follows them. */
const INLINE_ROOT_NAMES = new Set(INLINE_COMMANDS.map(item => item.name).filter(name => name !== "/queue"));

/** A /queue target is followed by free message text that a substring match could swallow. */
function rewritesQueueTarget(replacement: string): boolean {
  return /^\/queue\s/i.test(replacement);
}

interface WordPosition {
  word: string;
  start: number;
  end: number;
}

function wordsIn(text: string): WordPosition[] {
  return [...text.matchAll(/\S+/g)].map(match => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
}

function normalizedCommandKey(text: string): string {
  return text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** A single-line prompt starting with "/" sends the popup's first option for the same text. */
function promptCommandShorthand(state: RenderState, text: string, first: WordPosition): SlashShorthand | null {
  const line = text.slice(first.start).trimEnd();
  if (line.includes("\n")) return null;
  const [best] = commandCompletions(state, line);
  if (!best) return null;
  const replacement = completionInsertText(best);
  return rewritesQueueTarget(replacement) ? null : { start: first.start, end: first.start + line.length, replacement };
}

/**
 * Resolve the longest run of words after an inline modifier to its first
 * complete argument. Prose follows, so "please /model op fix" names a model
 * rather than stopping at the "openai" provider and reading "fix" as a model id.
 */
function inlineCommandShorthand(text: string, words: readonly WordPosition[], rootIndex: number, registry: ArgRegistry): SlashShorthand | null {
  const root = words[rootIndex];
  const parentKeys = new Set(Object.keys(registry).filter(key => registry[key].length > 0).map(normalizedCommandKey));
  let shorthand: SlashShorthand | null = null;
  for (let j = rootIndex + 1; j < words.length; j++) {
    if (words[j].word.startsWith("/") || text.slice(words[j - 1].end, words[j].start).includes("\n")) break;
    const ranked = searchAnchoredArgs(text.slice(root.start, words[j].end), registry);
    // Matches only shrink as words are added, so the first miss ends the run.
    if (!ranked?.length) break;
    const best = ranked.find(({ completion }) => !parentKeys.has(normalizedCommandKey(completionInsertText(completion))));
    if (best) shorthand = { start: root.start, end: words[j].end, replacement: completionInsertText(best.completion) };
  }
  return shorthand;
}

/**
 * Find slash shorthands that submission expands. A single-line prompt starting
 * with "/" resolves to the autocomplete popup's first option ("/mod opus" →
 * "/model anthropic claude-opus-5-5"); input that matches nothing, such as
 * "/goal <objective>", is left alone. Otherwise inline modifiers resolve their
 * arguments and leave any prose after them. /queue targets are never rewritten.
 */
export function findSlashShorthands(state: RenderState, text: string): SlashShorthand[] {
  if (!text.includes("/")) return [];
  const words = wordsIn(text);
  if (words.length === 0) return [];
  const promptCommand = promptCommandShorthand(state, text, words[0]);
  if (promptCommand) return [promptCommand];

  const inlineArgs = slashArgRegistry(state, getInlineCommandArgs);
  const shorthands: SlashShorthand[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!INLINE_ROOT_NAMES.has(words[i].word)) continue;
    const shorthand = inlineCommandShorthand(text, words, i, inlineArgs(words[i].word));
    if (!shorthand) continue;
    shorthands.push(shorthand);
    while (i + 1 < words.length && words[i + 1].start < shorthand.end) i++;
  }
  return shorthands;
}

/** Expand every slash shorthand in submitted text, e.g. "/model opus" → "/model anthropic claude-opus-5-5". */
export function resolveSlashShorthands(state: RenderState, text: string): string {
  let resolved = text;
  for (const { start, end, replacement } of findSlashShorthands(state, text).reverse()) {
    resolved = resolved.slice(0, start) + replacement + resolved.slice(end);
  }
  return resolved;
}
