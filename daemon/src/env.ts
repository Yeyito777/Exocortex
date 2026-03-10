/**
 * Load environment variables from ~/.config/exocortex/env into process.env.
 *
 * Supports:
 *   KEY=value
 *   export KEY=value
 *   KEY="value"         (double-quoted, strips quotes)
 *   export KEY="value"
 *
 * Lines starting with # and blank lines are ignored.
 * Multiline values are not supported.
 * Silently skips if the file doesn't exist.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { log } from "./log";
import { configDir } from "@exocortex/shared/paths";

const ENV_PATH = join(configDir(), "env");

export function loadEnvFile(): void {
  let content: string;
  try {
    content = readFileSync(ENV_PATH, "utf-8");
  } catch {
    return; // file doesn't exist — nothing to load
  }

  let loaded = 0;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Strip leading "export "
    const stripped = line.startsWith("export ") ? line.slice(7) : line;

    const eq = stripped.indexOf("=");
    if (eq === -1) continue;

    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();

    // Strip matching quotes
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      process.env[key] = value;
      loaded++;
    }
  }

  if (loaded > 0) {
    log("info", `env: loaded ${loaded} variable(s) from ${ENV_PATH}`);
  }
}
