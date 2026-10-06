import type { FastMode } from "@exocortex/shared/messages";
import { DAYBREAK_RETIRED_MODEL, supportsDaybreak } from "@exocortex/shared/daybreak";
import type { RenderState } from "./state";
import { normalizeEffortForModel, type EffortLevel, type ProviderId, type ModelId } from "./messages";
import { getModelInfo, isStreaming, pushSystemMessage } from "./state";
import { availableProviders, effortItems, providerAllowsCustomModels, providerModels, providerSupportsFastMode, supportedEfforts } from "./commands/shared";
import type { CompletionItem } from "./commands";
import type { QueueWaitTarget } from "./state";
import { matchQueueTargetAfterCommand, queueTargetCompletionItems } from "./queuetargets";
import { SPEED_COMMAND_ARGS, speedModeForArgument } from "./commands/speed";
import { applyModelSelectionWithNotice, modelCommandArgs } from "./commands/model";

export const INLINE_MODEL_COMMAND: CompletionItem = {
  name: "/model",
  desc: "Select provider/model for this prompt",
};

export const INLINE_EFFORT_COMMAND: CompletionItem = {
  name: "/effort",
  desc: "Set reasoning effort level",
};

export const INLINE_FAST_COMMAND: CompletionItem = {
  name: "/fast",
  desc: "Toggle or set fast mode",
};

export const INLINE_ULTRAFAST_COMMAND: CompletionItem = {
  name: "/ultrafast",
  desc: "Toggle or set ultrafast mode",
};

export const INLINE_QUEUE_COMMAND: CompletionItem = {
  name: "/queue",
  desc: "Send after global, conversation, or folder idle",
};

export const INLINE_COMMANDS: CompletionItem[] = [INLINE_MODEL_COMMAND, INLINE_EFFORT_COMMAND, INLINE_FAST_COMMAND, INLINE_ULTRAFAST_COMMAND, INLINE_QUEUE_COMMAND];

export interface InlineCommandApplication {
  text: string;
  efforts: EffortLevel[];
  fastModes: FastMode[];
  /** Final settings after ordered model/effort/speed modifiers; sync the model first. */
  modelSelection?: Pick<RenderState, "provider" | "model" | "effort" | "fastMode" | "daybreak">;
  /** Invalid selection blocks submission without partially applying modifiers. */
  error?: string;
  /** Present when the prompt contained /queue and should enter the daemon-owned idle queue. */
  queue?: QueueWaitTarget;
}

export type InlineEffortApplication = InlineCommandApplication;

type InlineAction =
  | { type: "model"; provider: ProviderId; model: ModelId }
  | { type: "effort"; effort: EffortLevel }
  | { type: "fast"; enabled: FastMode; label: "Fast" | "Ultrafast" };

interface ParsedInlineCommands {
  result: InlineCommandApplication;
  actions: InlineAction[];
}

interface WordPosition {
  word: string;
  start: number;
  end: number;
}

export function getInlineCommandArgs(state: RenderState, commandName?: string): Record<string, CompletionItem[]> {
  const registry: Record<string, CompletionItem[]> = {};
  if (!commandName || commandName === "/model") Object.assign(registry, modelCommandArgs(state));
  if (!commandName || commandName === "/effort") registry["/effort"] = effortItems(state);
  // Syntax does not depend on entitlement: standalone/inline completion and
  // highlighting must agree, even when execution will report unavailable.
  for (const name of ["/fast", "/ultrafast"]) {
    if (!commandName || commandName === name) registry[name] = SPEED_COMMAND_ARGS;
  }
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
 * This is intentionally narrower than macro expansion: only `/model <provider> <model>`, `/effort <level>`,
 * `/fast [on|off]`, `/ultrafast [on|off]`, and `/queue` can run mid-prompt. Other slash commands
 * remain ordinary text unless they are submitted through the normal command
 * path at the start of a prompt.
 */
function parseInlineCommands(text: string, state: RenderState): ParsedInlineCommands {
  // Only scalar selection fields are changed during preview. Never persist
  // preferences or mutate RenderState until every modifier has been validated.
  const simulated = { ...state };
  const words = wordsIn(text);
  const spans: Array<{ start: number; end: number }> = [];
  const actions: InlineAction[] = [];
  const efforts: EffortLevel[] = [];
  const fastModes: FastMode[] = [];
  let queue: QueueWaitTarget | undefined;
  let changedModel = false;
  const reject = (error: string): ParsedInlineCommands => ({
    result: { text, efforts: [], fastModes: [], error }, actions: [],
  });

  for (let i = 0; i < words.length; i++) {
    const command = words[i];
    const arg = words[i + 1];

    if (command.word === "/model") {
      const modelArg = words[i + 2];
      // Preserve standalone /model and /model <provider> informational views.
      if (i === 0 && words.length <= 2) continue;
      if (!arg || !modelArg || arg.word.startsWith("/") || modelArg.word.startsWith("/")) {
        return reject("Usage: /model <provider> <model>");
      }
      const provider = arg.word as ProviderId;
      const model = modelArg.word;
      if (provider === "openai" && model.startsWith("gpt-daybreak-")) return reject(DAYBREAK_RETIRED_MODEL);
      const providers = availableProviders(state);
      if (!providers.includes(provider)) return reject(`Unknown provider: ${provider}. Available: ${providers.join(", ")}`);
      if (!providerAllowsCustomModels(state, provider) && !providerModels(state, provider).includes(model)) {
        return reject(`Unknown model for provider ${provider}: ${model}. Available: ${providerModels(state, provider).join(", ")}`);
      }
      if (state.convId && isStreaming(state)) return reject("Cannot switch provider/model while this conversation is streaming.");
      simulated.provider = provider;
      simulated.model = model;
      simulated.effort = normalizeEffortForModel(getModelInfo(state, provider, model), simulated.effort);
      if (!providerSupportsFastMode(state, provider, model, simulated.fastMode)) simulated.fastMode = false;
      if (!supportsDaybreak(provider, getModelInfo(state, provider, model))) simulated.daybreak = false;
      changedModel = true;
      actions.push({ type: "model", provider, model });
      spans.push({ start: command.start, end: modelArg.end });
      i += 2;
      continue;
    }

    if (command.word === "/effort" && arg && supportedEfforts(simulated).some(candidate => candidate.effort === arg.word)) {
      const effort = arg.word as EffortLevel;
      simulated.effort = effort;
      efforts.push(effort);
      actions.push({ type: "effort", effort });
      spans.push({ start: command.start, end: arg.end });
      i++;
      continue;
    }

    if ((command.word === "/fast" && providerSupportsFastMode(simulated)) || command.word === "/ultrafast") {
      const rawArg = arg?.word.toLowerCase();
      const hasExplicitArg = rawArg === "on" || rawArg === "off";
      const tier = command.word === "/ultrafast" ? "ultrafast" : true;
      const enabled = speedModeForArgument(tier, hasExplicitArg ? rawArg : undefined, simulated.fastMode);
      if (enabled === "ultrafast" && !providerSupportsFastMode(simulated, simulated.provider, simulated.model, enabled)) {
        return reject("Ultrafast is not advertised for this model/account.");
      }
      simulated.fastMode = enabled;
      fastModes.push(enabled);
      actions.push({ type: "fast", enabled, label: tier === "ultrafast" ? "Ultrafast" : "Fast" });
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

  if (actions.length === 0 && !queue) {
    return { result: { text, efforts, fastModes }, actions };
  }

  let stripped = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    stripped = removeSpanPreservingBoundary(stripped, spans[i].start, spans[i].end);
  }

  return {
    result: {
      text: stripped, efforts, fastModes, ...(queue ? { queue } : {}),
      ...(changedModel ? { modelSelection: {
        provider: simulated.provider, model: simulated.model,
        effort: simulated.effort, fastMode: simulated.fastMode,
        daybreak: simulated.daybreak,
      } } : {}),
    },
    actions,
  };
}

/** Parse inline commands without changing conversation settings or adding notices. */
export function previewInlineCommands(text: string, state: RenderState): InlineCommandApplication {
  return parseInlineCommands(text, state).result;
}

export function applyInlineCommands(text: string, state: RenderState): InlineCommandApplication {
  const parsed = parseInlineCommands(text, state);
  if (parsed.result.error) {
    pushSystemMessage(state, parsed.result.error);
    return parsed.result;
  }
  for (const action of parsed.actions) {
    if (action.type === "model") {
      applyModelSelectionWithNotice(state, action.provider, action.model);
    } else if (action.type === "effort") {
      state.effort = action.effort;
      pushSystemMessage(state, `Effort set to ${action.effort}`);
    } else {
      state.fastMode = action.enabled;
      pushSystemMessage(state, `${action.label} mode ${action.enabled ? "enabled" : "disabled"}.`);
    }
  }
  return parsed.result;
}

export function applyInlineEffortCommands(text: string, state: RenderState): InlineCommandApplication {
  return applyInlineCommands(text, state);
}
