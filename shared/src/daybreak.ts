import type { ModelInfo, ProviderId } from "./messages";

/** Selectable product alias; never send this id as the provider's wire model. */
export const DAYBREAK_MODEL_ID = "gpt-6-sol-daybreak";
export const DAYBREAK_BASE_MODEL_ID = "gpt-6-sol";

export function openAIWireModel(model: string): string {
  return model === DAYBREAK_MODEL_ID ? DAYBREAK_BASE_MODEL_ID : model;
}

/** Reserve Daybreak ids so custom-model support cannot bypass discovery. */
export function isDaybreakModelId(model: string): boolean {
  return model.startsWith("gpt-daybreak-") || model.endsWith("-daybreak");
}

/** Wire-level safety guard; product discovery only exposes GPT-6 Sol. */
export function isDaybreakSolModel(model: string): boolean {
  return /^gpt-\d+(?:\.\d+)*-sol$/.test(model);
}

export function supportsDaybreak(
  provider: ProviderId,
  model: Pick<ModelInfo, "id" | "supportsDaybreak"> | null | undefined,
): boolean {
  return provider === "openai" && !!model
    && model.id === DAYBREAK_BASE_MODEL_ID && model.supportsDaybreak === true;
}

export const DAYBREAK_UNAVAILABLE = "gpt-6-sol-daybreak is only available when the connected account advertises Daybreak Blue for gpt-6-sol. Select gpt-6-sol to use standard access.";
export const DAYBREAK_RETIRED_MODEL = "Use /model openai gpt-6-sol-daybreak for Daybreak Blue.";

/** Upgrade old selections without changing historical messages/checkpoints. */
export function migrateLegacyDaybreak<T extends { provider: ProviderId; model: string; daybreak?: boolean }>(selection: T): T {
  if (selection.provider === "openai" && (selection.model === "gpt-daybreak-blue-latest"
      || (selection.model === DAYBREAK_BASE_MODEL_ID && selection.daybreak === true))) {
    selection.model = DAYBREAK_MODEL_ID;
  }
  delete selection.daybreak;
  return selection;
}
