/**
 * Load non-secret environment variables from config/secrets/env into process.env.
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
 *
 * Every child the daemon starts (bash, Claude Code, tool daemons) inherits
 * process.env, so credentials (names containing KEY, TOKEN, SECRET, PASSWORD,
 * PASSWD or CREDENTIAL) are not exported: an agent shell could read them with
 * no allowlist or audit entry. Keep those in the secrets store and inject them
 * per command with `secrets run --allow NAME -- …`.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { log } from "./log";
import { secretsDir } from "@exocortex/shared/paths";

const ENV_PATH = join(secretsDir(), "env");

/** Variable names that hold credentials and must not reach child processes. */
export function isCredentialName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(name);
}

export function parseEnvFile(content: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
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

    if (key) entries.push([key, value]);
  }
  return entries;
}

export function loadEnvFile(path = ENV_PATH, env: NodeJS.ProcessEnv = process.env): void {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return; // file doesn't exist — nothing to load
  }

  let loaded = 0;
  const withheld: string[] = [];
  for (const [key, value] of parseEnvFile(content)) {
    if (isCredentialName(key)) {
      withheld.push(key);
      continue;
    }
    env[key] = value;
    loaded++;
  }

  if (loaded > 0) {
    log("info", `env: loaded ${loaded} variable(s) from ${path}`);
  }
  if (withheld.length > 0) {
    log("warn", `env: not exporting credential variable(s) ${withheld.join(", ")} from ${path}; agents get secrets through \`secrets run --allow NAME\``);
  }
}
