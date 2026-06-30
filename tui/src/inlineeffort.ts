import type { RenderState } from "./state";
import type { EffortLevel } from "./messages";
import { pushSystemMessage } from "./state";
import { effortItems, providerSupportsFastMode, supportedEfforts } from "./commands/shared";
import type { CompletionItem } from "./commands";
import type { QueueWaitTarget } from "./state";
import { matchQueueTargetAfterCommand, queueTargetCompletionItems } from "./queuetargets";

export const INLINE_EFFORT_COMMAND: CompletionItem = {
  name: "/effort",
  desc: "Set reasoning effort level",
};

export const INLINE_FAST_COMMAND: CompletionItem = {
  name: "/fast",
  desc: "Toggle or set fast mode",
};

export const INLINE_QUEUE_COMMAND: CompletionItem = {
  name: "/queue",
  desc: "Send after global, conversation, or folder idle",
};

export const INLINE_COMMANDS: CompletionItem[] = [INLINE_EFFORT_COMMAND, INLINE_FAST_COMMAND, INLINE_QUEUE_COMMAND];

const INLINE_FAST_ARGS: CompletionItem[] = [
  { name: "on", desc: "Enable fast mode for this conversation" },
  { name: "off", desc: "Disable fast mode for this conversation" },
];

export interface InlineCommandApplication {
  text: string;
  efforts: EffortLevel[];
  fastModes: boolean[];
  /** Present when the prompt contained /queue and should enter the TUI-owned queue. */
  queue?: QueueWaitTarget;
}

export type InlineEffortApplication = InlineCommandApplication;

type InlineAction =
  | { type: "effort"; effort: EffortLevel }
  | { type: "fast"; enabled: boolean };

interface WordPosition {
  word: string;
  start: number;
  end: number;
}

export function getInlineCommandArgs(state: RenderState, commandName?: string): Record<string, CompletionItem[]> {
  const registry: Record<string, CompletionItem[]> = {};
  if (!commandName || commandName === "/effort") registry["/effort"] = effortItems(state);
  if (!commandName || commandName === "/fast") registry["/fast"] = INLINE_FAST_ARGS;
  if (!commandName || commandName === "/queue") registry["/queue"] = queueTargetCompletionItems(state);
  return registry;
}

export function getInlineEffortArgs(state: RenderState): Record<string, CompletionItem[]> {
  return getInlineCommandArgs(state);
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
 * Execute supported inline slash commands anywhere in prompt text and return
 * the prompt with those command tokens removed.
 *
 * This is intentionally narrower than macro expansion: only `/effort <level>`,
 * `/fast [on|off]`, and `/queue` can run mid-prompt.  Other slash commands
 * remain ordinary text unless they are submitted through the normal command
 * path at the start of a prompt.
 */
export function applyInlineCommands(text: string, state: RenderState): InlineCommandApplication {
  const supportedLevels = new Set(supportedEfforts(state).map(candidate => candidate.effort));
  const supportsFast = providerSupportsFastMode(state);
  const words = wordsIn(text);
  const spans: Array<{ start: number; end: number }> = [];
  const actions: InlineAction[] = [];
  const efforts: EffortLevel[] = [];
  const fastModes: boolean[] = [];
  let queue: QueueWaitTarget | undefined;
  let simulatedFastMode = state.fastMode;

  for (let i = 0; i < words.length; i++) {
    const command = words[i];
    const arg = words[i + 1];

    if (command.word === "/effort" && arg && supportedLevels.has(arg.word as EffortLevel)) {
      const effort = arg.word as EffortLevel;
      efforts.push(effort);
      actions.push({ type: "effort", effort });
      spans.push({ start: command.start, end: arg.end });
      i++;
      continue;
    }

    if (command.word === "/fast" && supportsFast) {
      const rawArg = arg?.word.toLowerCase();
      const hasExplicitArg = rawArg === "on" || rawArg === "off";
      const enabled = hasExplicitArg ? rawArg === "on" : !simulatedFastMode;
      simulatedFastMode = enabled;
      fastModes.push(enabled);
      actions.push({ type: "fast", enabled });
      spans.push({ start: command.start, end: hasExplicitArg && arg ? arg.end : command.end });
      if (hasExplicitArg) i++;
      continue;
    }

    if (command.word === "/queue") {
      const target = matchQueueTargetAfterCommand(state, text, command.end);
      queue = target?.target ?? { type: "global" };
      const spanEnd = target?.end ?? command.end;
      spans.push({ start: command.start, end: spanEnd });
      while (i + 1 < words.length && words[i + 1].start < spanEnd) i++;
    }
  }

  if (actions.length === 0 && !queue) return { text, efforts, fastModes };

  for (const action of actions) {
    if (action.type === "effort") {
      state.effort = action.effort;
      pushSystemMessage(state, `Effort set to ${action.effort}`);
    } else {
      state.fastMode = action.enabled;
      pushSystemMessage(state, `Fast mode ${action.enabled ? "enabled" : "disabled"}.`);
    }
  }

  let stripped = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    stripped = removeSpanPreservingBoundary(stripped, spans[i].start, spans[i].end);
  }

  return { text: stripped, efforts, fastModes, ...(queue ? { queue } : {}) };
}

export function applyInlineEffortCommands(text: string, state: RenderState): InlineCommandApplication {
  return applyInlineCommands(text, state);
}
