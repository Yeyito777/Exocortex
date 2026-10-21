import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";
import { FOLD_STYLES, type FoldStyle } from "./turncollapse";

export function loadDiagnosticsPreference(): boolean {
  return readExocortexConfig().tui?.diagnostics === true;
}

/** Experimental folded-history style (/foldstyle). */
export function loadFoldStylePreference(): FoldStyle {
  const style = readExocortexConfig().tui?.foldStyle;
  return typeof style === "string" && (FOLD_STYLES as readonly string[]).includes(style) ? style as FoldStyle : "rows";
}

export function saveFoldStylePreference(style: FoldStyle): void {
  updateExocortexConfig((config) => {
    config.tui = { ...(config.tui ?? {}), foldStyle: style };
  });
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
