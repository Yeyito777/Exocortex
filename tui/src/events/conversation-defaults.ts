import { productConversationDefaults, type ConversationDefaults } from "@exocortex/shared/config";
import type { ConversationDefaultsSnapshot } from "../protocol";
import { resetNewConversationDefaults, type RenderState } from "../state";

export function formatConversationDefaults(defaults: ConversationDefaults): string {
  return [
    `Provider: ${defaults.provider}`,
    `Model:    ${defaults.model}`,
    `Effort:   ${defaults.effort}`,
    `Fast:     ${defaults.fastMode === "ultrafast" ? "ultrafast" : defaults.fastMode ? "on" : "off"}`,
  ].join("\n");
}

/** Refresh the cache without overwriting a focused chat or an edited draft. */
export function receiveConversationDefaults(
  state: RenderState,
  snapshot: ConversationDefaultsSnapshot,
  applyToDraft = false,
): void {
  const previous = state.conversationDefaults?.defaults ?? productConversationDefaults();
  const followingDefaults = !state.hasChosenProvider
    || (state.provider === previous.provider && state.model === previous.model
      && state.effort === previous.effort && state.fastMode === previous.fastMode && !state.daybreak);
  state.conversationDefaults = { defaults: { ...snapshot.defaults }, configured: snapshot.configured };
  if (!state.convId && (applyToDraft || followingDefaults)) resetNewConversationDefaults(state);
}
