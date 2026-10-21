import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";
import type { FoldStyle } from "./turncollapse";

export function loadDiagnosticsPreference(): boolean {
  return readExocortexConfig().tui?.diagnostics === true;
}

/** How folded history looks (config tui.foldStyle; no command): gutter marks unless "rows". */
export function loadFoldStylePreference(): FoldStyle {
  return readExocortexConfig().tui?.foldStyle === "rows" ? "rows" : "gutter";
}

/** Whether folded history leaves a faint gutter mark (config tui.foldMarks; default on). */
export function loadFoldMarksPreference(): boolean {
  return readExocortexConfig().tui?.foldMarks !== false;
}

/** Ctrl+O (show every turn's work) is a sticky view preference, like /diagnostics. */
export function loadTurnWorkPreference(): boolean {
  return readExocortexConfig().tui?.showTurnWork === true;
}

export function saveTurnWorkPreference(enabled: boolean): void {
  updateExocortexConfig((config) => {
    config.tui = { ...(config.tui ?? {}), showTurnWork: enabled };
  });
}

export function saveDiagnosticsPreference(enabled: boolean): void {
  updateExocortexConfig((config) => {
    config.tui = { ...(config.tui ?? {}), diagnostics: enabled };
  });
}
