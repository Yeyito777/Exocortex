import type { RenderState } from "./state";
import type { EffortLevel } from "./messages";
import { pushSystemMessage } from "./state";
import { effortItems, supportedEfforts } from "./commands/shared";
import type { CompletionItem } from "./commands";

export const INLINE_EFFORT_COMMAND: CompletionItem = {
  name: "/effort",
  desc: "Set reasoning effort level",
};

export interface InlineEffortApplication {
  text: string;
  efforts: EffortLevel[];
}

interface WordPosition {
  word: string;
  start: number;
  end: number;
}

export function getInlineEffortArgs(state: RenderState): Record<string, CompletionItem[]> {
  return { "/effort": effortItems(state) };
}

function wordsIn(text: string): WordPosition[] {
  const words: WordPosition[] = [];
  const wordRe = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(text)) !== null) {
    words.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return words;
}

function removeSpanPreservingBoundary(text: string, start: number, end: number): string {
  let removeStart = start;
  let removeEnd = end;

  // Eat surrounding horizontal space so removing an inline command does not
  // leave doubled spaces.  Newlines are kept as structural boundaries below.
  while (removeStart > 0 && /[ \t]/.test(text[removeStart - 1])) removeStart--;
  while (removeEnd < text.length && /[ \t]/.test(text[removeEnd])) removeEnd++;

  const before = text.slice(0, removeStart);
  const after = text.slice(removeEnd);
  if (!/\S/.test(before) || !/\S/.test(after)) return before + after;

  const beforeLast = before[before.length - 1];
  const afterFirst = after[0];
  if (beforeLast === "\n" && afterFirst === "\n") return before + after.slice(1);
  if (beforeLast === "\n" || afterFirst === "\n") return before + after;
  return `${before} ${after}`;
}

/**
 * Execute supported `/effort <level>` occurrences anywhere in prompt text and
 * return the prompt with those command tokens removed.
 *
 * This is intentionally narrower than macro expansion: `/effort` is the only
 * slash command that can run mid-prompt, and only when followed by a currently
 * supported effort level.  Other slash commands remain ordinary text unless
 * they are submitted through the normal command path at the start of a prompt.
 */
export function applyInlineEffortCommands(text: string, state: RenderState): InlineEffortApplication {
  const supportedLevels = new Set(supportedEfforts(state).map(candidate => candidate.effort));
  const words = wordsIn(text);
  const spans: Array<{ start: number; end: number }> = [];
  const efforts: EffortLevel[] = [];

  for (let i = 0; i < words.length - 1; i++) {
    const command = words[i];
    const arg = words[i + 1];
    if (command.word !== "/effort") continue;
    if (!supportedLevels.has(arg.word as EffortLevel)) continue;

    const effort = arg.word as EffortLevel;
    efforts.push(effort);
    spans.push({ start: command.start, end: arg.end });
    i++;
  }

  if (efforts.length === 0) return { text, efforts };

  for (const effort of efforts) {
    state.effort = effort;
    pushSystemMessage(state, `Effort set to ${effort}`);
  }

  let stripped = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    stripped = removeSpanPreservingBoundary(stripped, spans[i].start, spans[i].end);
  }

  return { text: stripped, efforts };
}

