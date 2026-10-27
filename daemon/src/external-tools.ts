/**
 * External tools facade — discovery, PATH injection, daemon supervision, and runtime watching.
 *
 * Scans external-tools/{tool}/manifest.json for tool metadata and coordinates the
 * narrower modules that own manifest parsing, watcher lifecycle, auth injection,
 * and supervised daemon lifecycle.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { externalToolsDir as getExternalToolsDir, repoRoot, worktreeName } from "@exocortex/shared/paths";
import { localMacroEnvironment } from "@exocortex/shared/macro-environment";
import type { ExternalToolStyle } from "@exocortex/shared/messages";
import { log } from "./log";
import { scanExternalTools, getToolReloadKey } from "./external-tools-manifest";
import { ExternalToolWatcher, getExternalToolWatchTargets } from "./external-tools-watcher";
import { ExternalToolDaemonSupervisor } from "./external-tools-daemon";
import type { ExternalToolDaemonAction, ExternalToolDaemonStatus, LoadedTool } from "./external-tools-types";
import { setExternalNotificationToolOnline } from "./external-notifications";

export type { ExternalToolDaemonAction, ExternalToolDaemonStatus, LoadedTool, Manifest, ManifestDaemon } from "./external-tools-types";
export { getToolReloadKey } from "./external-tools-manifest";
export { getExternalToolWatchTargets } from "./external-tools-watcher";
export { buildDaemonSpawnSpec, getDaemonStatePaths, isLikelyManagedDaemonPid, killProcessGroup, reapStaleManagedDaemonPid } from "./external-tools-daemon-process";

const BASE_PATH = process.env.PATH ?? "";
const DEBOUNCE_MS = 1_000;
export const EXOCORTEX_SOURCE_DIR_PLACEHOLDER = "<exocortex-source-dir>";

export function resolveSystemHintPaths(systemHint: string): string {
  // Resolve lazily while building model context so manifests stay portable when
  // the Exocortex checkout moves or is installed under a different home directory.
  return systemHint.replaceAll(EXOCORTEX_SOURCE_DIR_PLACEHOLDER, repoRoot());
}

let tools: LoadedTool[] = [];
let watcher: ExternalToolWatcher | null = null;
let externalToolsDir: string | null = null;
let installedToolDirsKey = "";
let daemonSupervisionEnabled = false;
let onToolsUpdate: (() => void) | undefined;
const daemonSupervisor = new ExternalToolDaemonSupervisor(setExternalNotificationToolOnline);

/**
 * Linked worktrees share the canonical external-tools directories through
 * symlinks. Starting another supervisor there makes dev/test instances fight
 * the main daemon over the same PID files, sockets, and authenticated sessions.
 */
export function shouldSuperviseExternalToolDaemons(
  linkedWorktree: string | null = worktreeName(),
  override = process.env.EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS,
): boolean {
  if (override === "1") return true;
  if (override === "0") return false;
  return linkedWorktree === null;
}

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

  if (daemonSupervisionEnabled) {
    daemonSupervisor.applyToolChanges(nextTools);
  } else {
    // Keep management metadata current without starting/stopping shared daemons.
    daemonSupervisor.setInitialTools(nextTools);
  }
  tools = nextTools;
  updatePath(nextTools);
  return true;
}

function reloadTools(onUpdate?: () => void): void {
  if (!externalToolsDir) return;

  const updated = scanExternalTools(externalToolsDir);
  const manifestChanged = applyTools(updated);
  // Uninstall macros also list checkouts without a valid manifest.
  const nextDirsKey = JSON.stringify(localMacroEnvironment().installedToolDirs);
  const directoriesChanged = nextDirsKey !== installedToolDirsKey;
  installedToolDirsKey = nextDirsKey;
  if (!manifestChanged && !directoriesChanged) return;

  log("info", `external-tools: reloaded — ${updated.length} tool(s): ${updated.map((tool) => tool.manifest.name).join(", ") || "(none)"}`);
  onUpdate?.();
}

/** Registered external command names in stable manifest order. */
export function getExternalToolNames(): string[] {
  return tools.map((tool) => tool.manifest.name);
}

/**
 * Initialize external tools: scan, update PATH, start daemons, start watcher.
 * The onUpdate callback fires when tools are added, removed, or changed at runtime.
 */
export function initExternalTools(onUpdate?: () => void): void {
  externalToolsDir = getExternalToolsDir();
  onToolsUpdate = onUpdate;

  // Ensure directory exists (gitignored, may not exist yet)
  mkdirSync(externalToolsDir, { recursive: true });

  tools = scanExternalTools(externalToolsDir);
  installedToolDirsKey = JSON.stringify(localMacroEnvironment().installedToolDirs);
  daemonSupervisor.setInitialTools(tools);
  daemonSupervisionEnabled = shouldSuperviseExternalToolDaemons();
  updatePath(tools);

  if (tools.length > 0) {
    log("info", `external-tools: loaded ${tools.length} tool(s): ${tools.map((tool) => tool.manifest.name).join(", ")}`);
  }

  const daemonTools = tools.filter((tool) => tool.manifest.daemon);
  if (daemonSupervisionEnabled) {
    daemonSupervisor.startConfiguredDaemons();
  }
  if (daemonTools.length > 0 && daemonSupervisionEnabled) {
    log("info", `external-tools: supervising ${daemonTools.length} daemon(s): ${daemonTools.map((tool) => tool.manifest.name).join(", ")}`);
  } else if (daemonTools.length > 0) {
    log("info", `external-tools: linked worktree instance — leaving ${daemonTools.length} shared daemon(s) to the main instance`);
  }

  // Watch for changes. Keep watches shallow so tool runtime artifacts
  // (e.g. browser profile sockets inside config/) can't crash the daemon.
  watcher?.stop();
  watcher = new ExternalToolWatcher(externalToolsDir, DEBOUNCE_MS, () => reloadTools(onUpdate));
  watcher.start();
}

/** Re-read the manifests now (after writing one) instead of waiting for the watcher. */
export function reloadExternalToolsNow(): void {
  reloadTools(onToolsUpdate);
}

/** The loaded tools with their manifests as written (placeholders unresolved). */
export function getLoadedExternalTools(): readonly LoadedTool[] {
  return tools;
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
  if (!daemonSupervisionEnabled) {
    throw new Error(
      `External-tool daemon management is disabled in linked worktree instances; use the main Exocortex instance`
    );
  }
  return await daemonSupervisor.manage(toolName, action);
}

/** Each loaded external tool's system hint as injected, with the manifest it comes from. */
export function getExternalToolHintEntries(loadedTools: readonly LoadedTool[] = tools): { name: string; hint: string; manifestPath: string }[] {
  return loadedTools.flatMap((tool) => tool.manifest.systemHint
    ? [{ name: tool.manifest.name, hint: resolveSystemHintPaths(tool.manifest.systemHint), manifestPath: join(tool.toolDir, "manifest.json") }]
    : []);
}

/** Aggregated system hints from all loaded external tools. */
export function getExternalToolHints(loadedTools: readonly LoadedTool[] = tools): string {
  return getExternalToolHintEntries(loadedTools).map((entry) => `## ${entry.name}\n${entry.hint}`).join("\n");
}

/**
 * Display styles for TUI Bash sub-command matching.
 *
 * This is the presentation contract for managed external tools: execution
 * remains an ordinary Bash call, then the TUI recognizes the command name and
 * renders the manifest label/color. Keep this separate from the native tool
 * registry; registering a generic external wrapper breaks that presentation.
 */
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

/** Install an isolated manifest inventory for a unit test and return its restore callback. */
export function setLoadedExternalToolsForTest(nextTools: readonly LoadedTool[]): () => void {
  const previous = tools;
  tools = [...nextTools];
  return () => { tools = previous; };
}

/** Number of tool daemons currently being supervised. */
export function getSupervisedDaemonCount(): number {
  return daemonSupervisor.count;
}
