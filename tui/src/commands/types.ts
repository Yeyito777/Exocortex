import type { RenderState } from "../state";
import type { TrimMode } from "../protocol";
import type { ProviderId, ModelId, EffortLevel } from "../messages";

export interface CompletionItem {
  name: string;
  desc: string;
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
  | { type: "rename_conversation"; title: string }
  | { type: "generate_title" }
  | { type: "login"; provider?: ProviderId }
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
