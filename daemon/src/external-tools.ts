/**
 * External tools facade — discovery, PATH injection, daemon supervision, and runtime watching.
 *
 * Scans external-tools/{tool}/manifest.json for tool metadata and coordinates the
 * narrower modules that own manifest parsing, watcher lifecycle, shell rewriting,
 * and supervised daemon lifecycle.
 */

import { mkdirSync } from "fs";
import { externalToolsDir as getExternalToolsDir } from "@exocortex/shared/paths";
import type { ExternalToolStyle } from "@exocortex/shared/messages";
import { log } from "./log";
import { getShellConfigHint, rewriteExternalToolShellCommandForTools } from "./external-tools-shell";
import { scanExternalTools, getToolReloadKey } from "./external-tools-manifest";
import { ExternalToolWatcher, getExternalToolWatchTargets } from "./external-tools-watcher";
import { ExternalToolDaemonSupervisor } from "./external-tools-daemon";
import type { ExternalToolDaemonAction, ExternalToolDaemonStatus, LoadedTool } from "./external-tools-types";

export type { ManifestShellLiteralArg, ManifestShell } from "./external-tools-shell";
export type { ExternalToolDaemonAction, ExternalToolDaemonStatus, LoadedTool, Manifest, ManifestDaemon } from "./external-tools-types";
export { getToolReloadKey } from "./external-tools-manifest";
export { getExternalToolWatchTargets } from "./external-tools-watcher";
export { buildDaemonSpawnSpec, getDaemonStatePaths, isLikelyManagedDaemonPid, reapStaleManagedDaemonPid } from "./external-tools-daemon-process";

const BASE_PATH = process.env.PATH ?? "";
const DEBOUNCE_MS = 1_000;

let tools: LoadedTool[] = [];
let watcher: ExternalToolWatcher | null = null;
let externalToolsDir: string | null = null;
const daemonSupervisor = new ExternalToolDaemonSupervisor();

function updatePath(loadedTools: LoadedTool[]): void {
  if (loadedTools.length === 0) {
    process.env.PATH = BASE_PATH;
    return;
  }
  // Deduplicate bin dirs (multiple tools could share a bin/ directory)
  const dirs = [...new Set(loadedTools.map((tool) => tool.binDir))];
  process.env.PATH = `${dirs.join(":")}:${BASE_PATH}`;
}

function applyTools(nextTools: LoadedTool[]): boolean {
  const oldKey = getToolReloadKey(tools);
  const newKey = getToolReloadKey(nextTools);
  if (oldKey === newKey) return false;

  daemonSupervisor.applyToolChanges(nextTools);
  tools = nextTools;
  updatePath(nextTools);
  return true;
}

function reloadTools(onUpdate?: () => void): void {
  if (!externalToolsDir) return;

  const updated = scanExternalTools(externalToolsDir);
  if (!applyTools(updated)) return;

  log("info", `external-tools: reloaded — ${updated.length} tool(s): ${updated.map((tool) => tool.manifest.name).join(", ") || "(none)"}`);
  onUpdate?.();
}

export function rewriteExternalToolShellCommand(command: string, loadedTools: LoadedTool[] = tools): string {
  return rewriteExternalToolShellCommandForTools(command, loadedTools);
}

/**
 * Initialize external tools: scan, update PATH, start daemons, start watcher.
 * The onUpdate callback fires when tools are added, removed, or changed at runtime.
 */
export function initExternalTools(onUpdate?: () => void): void {
  externalToolsDir = getExternalToolsDir();

  // Ensure directory exists (gitignored, may not exist yet)
  mkdirSync(externalToolsDir, { recursive: true });

  tools = scanExternalTools(externalToolsDir);
  daemonSupervisor.setInitialTools(tools);
  updatePath(tools);

  if (tools.length > 0) {
    log("info", `external-tools: loaded ${tools.length} tool(s): ${tools.map((tool) => tool.manifest.name).join(", ")}`);
  }

  const daemonTools = tools.filter((tool) => tool.manifest.daemon);
  daemonSupervisor.startConfiguredDaemons();
  if (daemonTools.length > 0) {
    log("info", `external-tools: supervising ${daemonTools.length} daemon(s): ${daemonTools.map((tool) => tool.manifest.name).join(", ")}`);
  }

  // Watch for changes. Keep watches shallow so tool runtime artifacts
  // (e.g. browser profile sockets inside config/) can't crash the daemon.
  watcher?.stop();
  watcher = new ExternalToolWatcher(externalToolsDir, DEBOUNCE_MS, () => reloadTools(onUpdate));
  watcher.start();
}

/** Stop the filesystem watcher and all supervised daemons (fire-and-forget). */
export function stopExternalTools(): void {
  watcher?.stop();
  watcher = null;
  void daemonSupervisor.stopAll();
}

/** Stop watcher and await all supervised daemons to exit. */
export async function stopExternalToolsAsync(): Promise<void> {
  watcher?.stop();
  watcher = null;
  await daemonSupervisor.stopAll();
}

export async function manageExternalToolDaemon(toolName: string, action: ExternalToolDaemonAction): Promise<ExternalToolDaemonStatus> {
  return await daemonSupervisor.manage(toolName, action);
}

/** Aggregated system hints from all loaded external tools. */
export function getExternalToolHints(): string {
  const hints = tools.flatMap((tool) => {
    const entries: string[] = [];
    if (tool.manifest.systemHint) entries.push(tool.manifest.systemHint);
    const shellHint = getShellConfigHint(tool.manifest.name, tool.manifest.shell);
    if (shellHint) entries.push(shellHint);
    return entries;
  });
  return hints.length > 0 ? hints.join("\n") : "";
}

/** Display styles for TUI bash sub-command matching. */
export function getExternalToolStyles(): ExternalToolStyle[] {
  return tools.map((tool) => ({
    cmd: tool.manifest.name,
    label: tool.manifest.display.label,
    color: tool.manifest.display.color,
  }));
}

/** Number of currently loaded external tools. */
export function getExternalToolCount(): number {
  return tools.length;
}

/** Number of tool daemons currently being supervised. */
export function getSupervisedDaemonCount(): number {
  return daemonSupervisor.count;
}
