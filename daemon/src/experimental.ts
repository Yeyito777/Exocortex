/**
 * Opt-in experimental features from the `experimental` config section.
 *
 * Read once per daemon process: changing a flag needs a daemon restart, and
 * clients learn the values from the `tools_available` bootstrap.
 */

import { experimentalImagesEnabled } from "@exocortex/shared/config";
import type { ExperimentalFeatures } from "@exocortex/shared/protocol";

let snapshot: ExperimentalFeatures | null = null;

export function experimentalFeatures(): ExperimentalFeatures {
  snapshot ??= { images: experimentalImagesEnabled() };
  return snapshot;
}

export function imagesEnabled(): boolean {
  return experimentalFeatures().images;
}

/** Tests: re-read the config on next use. */
export function resetExperimentalFeaturesForTest(): void {
  snapshot = null;
}
