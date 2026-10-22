import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";

export function loadDiagnosticsPreference(): boolean {
  return readExocortexConfig().tui?.diagnostics === true;
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
