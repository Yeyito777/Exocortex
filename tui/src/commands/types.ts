import type { RenderState } from "../state";
import type { GoalAction, OpenAILoginMethod, TrimMode } from "../protocol";
import type { ProviderId, ModelId, EffortLevel } from "../messages";

export interface CompletionItem {
  name: string;
  desc: string;
  /** Optional replacement text. Defaults to name. */
  insertText?: string;
  /** Extra strings that should match this item during prefix filtering. */
  aliases?: string[];
}

export type CommandResult =
  | { type: "handled" }
  | { type: "quit" }
  | { type: "new_conversation" }
  | { type: "create_conversation_for_instructions"; text: string }
  | { type: "replay_requested" }
  | { type: "model_changed"; provider: ProviderId; model: ModelId }
  | { type: "trim_requested"; mode: TrimMode; count: number }
  | { type: "effort_changed"; effort: EffortLevel }
  | { type: "fast_mode_changed"; enabled: boolean }
  | { type: "goal"; action: GoalAction; objective?: string; pausable?: boolean; completable?: boolean }
  | { type: "rename_conversation"; title: string }
  | { type: "generate_title" }
  | { type: "login"; provider?: ProviderId; apiKey?: string; action?: "add" | "remove"; target?: string; method?: OpenAILoginMethod }
  | { type: "account"; provider?: ProviderId; target?: string }
  | { type: "logout"; provider?: ProviderId }
  | { type: "theme_changed" }
  | { type: "get_system_prompt" }
  | { type: "set_system_instructions"; text: string };

export interface SlashCommand {
  name: string;
  description: string;
  args?: CompletionItem[];
  /** Optional dynamic/nested argument completions keyed by command prefix. */
  getArgs?: (state: RenderState) => Record<string, CompletionItem[]>;
  handler: (text: string, state: RenderState) => CommandResult;
}
