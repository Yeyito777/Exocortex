/**
 * Opt-in experimental features from the `experimental` config section.
 *
 * Read once per daemon process: changing a flag needs a daemon restart, and
 * clients learn the values from the `tools_available` bootstrap.
 */

import type { ExperimentalFeatures } from "@exocortex/shared/protocol";

let snapshot: ExperimentalFeatures | null = null;

export function experimentalFeatures(): ExperimentalFeatures {
  // Inline images graduated; `images: true` keeps TUIs that still gate on it showing them.
  snapshot ??= { images: true };
  return snapshot;
}

/** Tests: re-read the config on next use. */
export function resetExperimentalFeaturesForTest(): void {
  snapshot = null;
}
