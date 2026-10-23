import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";

/** Clock style of the finish time in AI metadata. TUI-only; set with /clock. */
export type ClockFormat = "12h" | "24h";

export const DEFAULT_CLOCK: ClockFormat = "12h";

export function loadClockPreference(): ClockFormat {
  return readExocortexConfig().tui?.clock === "24h" ? "24h" : DEFAULT_CLOCK;
}

export function saveClockPreference(clock: ClockFormat): void {
  updateExocortexConfig((config) => {
    config.tui = { ...(config.tui ?? {}), clock };
  });
}
