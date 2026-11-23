/**
 * The Antigravity CLI's hooks are configured globally, in
 * ~/.gemini/config/hooks.json, so Exocortex keeps one named entry there: a
 * PreToolUse hook that does nothing unless the agent runs for Exocortex (its
 * environment carries the hook script and bridge socket; see bridge.ts). The
 * owner's own `agy` sessions are left to their usual permissions: an empty
 * hook output is no decision.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../../log";

export const HOOK_ENTRY_NAME = "exocortex";

/** Runs via `sh -c`; drains stdin when not an Exocortex process, as the CLI writes the call to it. */
export const HOOK_COMMAND = `if [ -n "$EXOCORTEX_GEMINI_HOOK" ]; then exec "$EXOCORTEX_GEMINI_BUN" "$EXOCORTEX_GEMINI_HOOK"; fi; cat >/dev/null`;

export function hooksFilePath(home = homedir()): string {
  return process.env.EXOCORTEX_GEMINI_HOOKS_FILE?.trim() || join(home, ".gemini", "config", "hooks.json");
}

function hookEntry(): Record<string, unknown> {
  return {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 15 }] }],
  };
}

/** Add or refresh Exocortex's entry, keeping every other hook. Returns whether the file changed. */
export function ensureExocortexHook(path = hooksFilePath()): boolean {
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
      else throw new Error("not a JSON object");
    } catch (error) {
      log("warn", `gemini: leaving ${path} alone: it is not valid JSON (${error instanceof Error ? error.message : error}); Exocortex's safety hook is not installed`);
      return false;
    }
  }
  const wanted = hookEntry();
  if (JSON.stringify(current[HOOK_ENTRY_NAME]) === JSON.stringify(wanted)) return false;
  const next = { ...current, [HOOK_ENTRY_NAME]: wanted };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.exocortex-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
  log("info", `gemini: installed Exocortex's PreToolUse hook in ${path}`);
  return true;
}
