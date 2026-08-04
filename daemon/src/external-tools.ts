/**
 * External tools facade — discovery, PATH injection, daemon supervision, and runtime watching.
 *
 * Scans external-tools/{tool}/manifest.json for tool metadata and coordinates the
 * narrower modules that own manifest parsing, watcher lifecycle, auth injection,
 * and supervised daemon lifecycle.
 */

import { mkdirSync } from "fs";
import { spawn } from "child_process";
import { resolve } from "path";
import { StringDecoder } from "string_decoder";
import { externalToolsDir as getExternalToolsDir, worktreeName } from "@exocortex/shared/paths";
import type { ExternalToolStyle } from "@exocortex/shared/messages";
import { log } from "./log";
import { rewriteExternalToolShellCommandForToolsWithAuth } from "./external-tools-shell";
import { scanExternalTools, getToolReloadKey } from "./external-tools-manifest";
import { ExternalToolWatcher, getExternalToolWatchTargets } from "./external-tools-watcher";
import { ExternalToolDaemonSupervisor } from "./external-tools-daemon";
import { getExternalToolAuthArgs } from "./external-tools-auth";
import type { ExternalToolDaemonAction, ExternalToolDaemonStatus, LoadedTool } from "./external-tools-types";
import { setExternalNotificationToolOnline } from "./external-notifications";

export type { ExternalToolDaemonAction, ExternalToolDaemonStatus, LoadedTool, Manifest, ManifestAuth, ManifestDaemon } from "./external-tools-types";
export { getToolReloadKey } from "./external-tools-manifest";
export { getExternalToolWatchTargets } from "./external-tools-watcher";
export { buildDaemonSpawnSpec, getDaemonStatePaths, isLikelyManagedDaemonPid, killProcessGroup, reapStaleManagedDaemonPid } from "./external-tools-daemon-process";

const BASE_PATH = process.env.PATH ?? "";
const DEBOUNCE_MS = 1_000;

let tools: LoadedTool[] = [];
let watcher: ExternalToolWatcher | null = null;
let externalToolsDir: string | null = null;
let daemonSupervisionEnabled = false;
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
  if (!applyTools(updated)) return;

  log("info", `external-tools: reloaded — ${updated.length} tool(s): ${updated.map((tool) => tool.manifest.name).join(", ") || "(none)"}`);
  onUpdate?.();
}

export async function rewriteExternalToolShellCommandForExecution(command: string, loadedTools: LoadedTool[] = tools): Promise<string> {
  return await rewriteExternalToolShellCommandForToolsWithAuth(command, loadedTools, async (tool) => getExternalToolAuthArgs(tool as LoadedTool));
}

/** Registered external command names in stable manifest order. */
export function getExternalToolNames(): string[] {
  return tools.map((tool) => tool.manifest.name);
}

/** PATH projected for one conversation; unselected managed external tools are omitted. */
export function getExternalToolPath(allowedNames?: readonly string[]): string {
  const allowed = allowedNames === undefined ? null : new Set(allowedNames);
  const selected = allowed === null ? tools : tools.filter((tool) => allowed.has(tool.manifest.name));
  const dirs = [...new Set(selected.map((tool) => tool.binDir))];
  return dirs.length > 0 ? `${dirs.join(":")}:${BASE_PATH}` : BASE_PATH;
}

/** Reject recognized managed external commands that are outside this conversation's allowlist. */
export async function rewriteExternalToolShellCommandForPolicy(
  command: string,
  allowedNames?: readonly string[],
  loadedTools: LoadedTool[] = tools,
): Promise<string> {
  const allowed = allowedNames === undefined ? null : new Set(allowedNames);
  if (allowed) {
    // The auth rewriter exposes its conservative top-level parser through the
    // rewritten result. Compare against one tool at a time so recognized direct
    // invocations are denied before the command reaches Bash.
    for (const tool of loadedTools) {
      if (allowed.has(tool.manifest.name)) continue;
      let referenced = false;
      await rewriteExternalToolShellCommandForToolsWithAuth(command, [tool], async () => {
        referenced = true;
        return [];
      });
      if (referenced) throw new Error(`External tool unavailable in this conversation: ${tool.manifest.name}`);
    }
  }
  const selected = allowed ? loadedTools.filter((tool) => allowed.has(tool.manifest.name)) : loadedTools;
  return await rewriteExternalToolShellCommandForExecution(command, selected);
}

export interface ExternalToolRunResult {
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

/** Direct, argv-safe execution path used by the native external-tool broker. */
export async function runExternalTool(
  name: string,
  args: readonly string[],
  stdin: string | undefined,
  signal?: AbortSignal,
  timeoutMs = 300_000,
  loadedTools: readonly LoadedTool[] = tools,
  environment: Record<string, string> = {},
): Promise<ExternalToolRunResult> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const tool = loadedTools.find((candidate) => candidate.manifest.name === name);
  if (!tool) throw new Error(`Unknown or unavailable external tool: ${name}`);
  const authArgs = await getExternalToolAuthArgs(tool);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const executable = resolve(tool.toolDir, tool.manifest.bin);
  const MAX_OUTPUT_BYTES = 1024 * 1024;

  return await new Promise<ExternalToolRunResult>((resolveResult, reject) => {
    const child = spawn(executable, [...authArgs, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: getExternalToolPath([name]), ...environment },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const decoder = new StringDecoder("utf8");
    let outputBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const append = (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const selected = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      output += decoder.write(selected);
      outputBytes += selected.length;
      if (selected.length < chunk.length) truncated = true;
    };
    const kill = () => {
      if (!child.pid || child.killed) return;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      forceTimer ??= setTimeout(() => {
        if (!child.pid || settled) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, 2_000);
    };
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) kill();
    if (timeoutMs > 0) timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      output += decoder.end();
      if (truncated) output += "\n... (output byte-truncated at 1MB)";
      resolveResult({ output, exitCode: code, signal: closeSignal, timedOut });
    });
    child.stdin.on("error", () => { /* child may exit before consuming stdin */ });
    child.stdin.end(stdin ?? "");
  });
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

/** Aggregated system hints from all loaded external tools. */
export function getExternalToolHints(loadedTools: readonly LoadedTool[] = tools): string {
  const hints = loadedTools.flatMap((tool) => tool.manifest.systemHint
    ? [`## ${tool.manifest.name}\n${tool.manifest.systemHint}`]
    : []);
  return hints.length > 0 ? hints.join("\n") : "";
}

/** Aggregated system hints restricted to one resolved conversation policy. */
export function getExternalToolHintsForNames(
  allowedNames: readonly string[],
  loadedTools: readonly LoadedTool[] = tools,
): string {
  const allowed = new Set(allowedNames);
  return getExternalToolHints(loadedTools.filter((tool) => allowed.has(tool.manifest.name)));
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
