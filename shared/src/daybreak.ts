import type { ModelInfo, ProviderId } from "./messages";

/** Product scope: Daybreak Blue on Sol only, not a separate model or speed tier. */
export function isDaybreakSolModel(model: string): boolean {
  return /^gpt-\d+(?:\.\d+)*-sol$/.test(model);
}

export function supportsDaybreak(
  provider: ProviderId,
  model: Pick<ModelInfo, "id" | "supportsDaybreak"> | null | undefined,
): boolean {
  return provider === "openai" && !!model
    && isDaybreakSolModel(model.id) && model.supportsDaybreak === true;
}

export const DAYBREAK_UNAVAILABLE = "Daybreak Blue is only available on Sol models when advertised by the connected account. Select a supported Sol model or turn /daybreak off.";
export const DAYBREAK_RETIRED_MODEL = "Daybreak is an access mode, not a model. Select Sol and enable /daybreak.";

/** Upgrade old selections without changing historical messages/checkpoints. */
export function migrateLegacyDaybreak<T extends { provider: ProviderId; model: string; daybreak?: boolean }>(selection: T): T {
  if (selection.provider === "openai" && selection.model === "gpt-daybreak-blue-latest") {
    selection.model = "gpt-6-sol";
    selection.daybreak = true;
  }
  return selection;
}
