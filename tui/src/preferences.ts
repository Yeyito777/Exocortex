import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { storageDir } from "@exocortex/shared/paths";
import type { ProviderId } from "./messages";

interface TuiPreferences {
  preferredProvider?: ProviderId;
}

function prefsPath(): string {
  return join(storageDir(), "tui-preferences.json");
}

function readPreferences(): TuiPreferences {
  try {
    if (!existsSync(prefsPath())) return {};
    const parsed = JSON.parse(readFileSync(prefsPath(), "utf8")) as TuiPreferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writePreferences(prefs: TuiPreferences): void {
  const dir = storageDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2) + "\n");
}

function updatePreferences(mutator: (prefs: TuiPreferences) => TuiPreferences): void {
  writePreferences(mutator(readPreferences()));
}

export function loadPreferredProvider(): ProviderId | null {
  const provider = readPreferences().preferredProvider;
  return provider === "openai" || provider === "anthropic" || provider === "deepseek" ? provider : null;
}

export function savePreferredProvider(provider: ProviderId): void {
  updatePreferences((prefs) => ({ ...prefs, preferredProvider: provider }));
}

export function clearPreferredProvider(): void {
  updatePreferences((prefs) => {
    const next = { ...prefs };
    delete next.preferredProvider;
    return next;
  });
}
