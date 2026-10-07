import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";

export function loadDiagnosticsPreference(): boolean {
  return readExocortexConfig().tui?.diagnostics === true;
}

export function saveDiagnosticsPreference(enabled: boolean): void {
  updateExocortexConfig((config) => {
    config.tui = { ...(config.tui ?? {}), diagnostics: enabled };
  });
}
