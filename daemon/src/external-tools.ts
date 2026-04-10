/**
 * External tools — discovery, PATH injection, daemon supervision, and runtime watching.
 *
 * Scans external-tools/{tool}/manifest.json for tool metadata.
 * Each manifest declares:
 *   - name:       command name (e.g. "gmail")
 *   - bin:        relative path to executable (e.g. "./gmail" or "./bin/twitter")
 *   - systemHint: text injected into the system prompt
 *   - display:    { label, color } for TUI bash sub-command styling
 *   - shell:      (optional) bash-harness hints for safe literal argument rewriting
 *   - daemon:     (optional) long-running background process to supervise
 *
 * On startup, all manifests are loaded and:
 *   - Their bin directories are prepended to process.env.PATH
 *   - System hints are aggregated for the system prompt builder
 *   - Display styles are collected for the TUI
 *   - Declared daemons are spawned and supervised
 *
 * A filesystem watcher on the external-tools/ directory detects tools
 * being added or removed at runtime. Changes are debounced and trigger
 * a full re-scan + callback so the daemon can broadcast updated styles
 * to connected clients.
 */

import { readFileSync, readdirSync, statSync, watch, existsSync, mkdirSync, openSync, closeSync } from "fs";
import { join, dirname, resolve } from "path";
import { spawn, type ChildProcess } from "child_process";
import { log } from "./log";
import { externalToolsDir as getExternalToolsDir } from "@exocortex/shared/paths";
import type { ExternalToolStyle } from "@exocortex/shared/messages";
import {
  type ManifestShell,
  isValidShellConfig,
  getShellConfigHint,
  rewriteExternalToolShellCommandForTools,
} from "./external-tools-shell";

// ── Manifest schema ──────────────────────────────────────────────

export interface ManifestDaemon {
  /** Shell command to run from the tool directory (executed via `bash -lc`). */
  command: string;
  /**
   * When to restart the daemon after it exits.
   *   "on-failure" (default) — restart only on non-zero exit code
   *   "always"               — restart on any exit
   *   "never"                — don't restart
   */
  restart?: "on-failure" | "always" | "never";
  /** Additional environment variables merged into the process env. */
  env?: Record<string, string>;
}

export type { ManifestShellLiteralArg, ManifestShell } from "./external-tools-shell";

export interface Manifest {
  name: string;
  bin: string;
  systemHint: string;
  display: {
    label: string;
    color: string;
  };
  /** Optional shell invocation hints for the bash harness. */
  shell?: ManifestShell;
  /** Optional long-running daemon that exocortexd will spawn and supervise. */
  daemon?: ManifestDaemon;
}

export interface LoadedTool {
  manifest: Manifest;
  /** Absolute path to the directory containing the binary. */
  binDir: string;
  /** Absolute path to the tool's root directory. */
  toolDir: string;
}

// ── State ────────────────────────────────────────────────────────

const BASE_PATH = process.env.PATH ?? "";
let _tools: LoadedTool[] = [];
let _watcher: ReturnType<typeof watch> | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _externalToolsDir: string | null = null;

const DEBOUNCE_MS = 1_000;

// ── Daemon supervision ───────────────────────────────────────────

interface ManagedDaemon {
  toolName: string;
  toolDir: string;
  config: ManifestDaemon;
  child: ChildProcess | null;
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  lastStartTime: number;
  stopping: boolean;
}

const _daemons = new Map<string, ManagedDaemon>();

/** Restart backoff schedule (ms). Resets after 5 min of stable uptime. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const BACKOFF_RESET_MS = 5 * 60_000;

export function buildDaemonSpawnSpec(command: string): { cmd: string; args: string[] } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  return { cmd: "bash", args: ["-lc", trimmed] };
}

function spawnDaemonProcess(managed: ManagedDaemon): void {
  const spec = buildDaemonSpawnSpec(managed.config.command);
  if (!spec) {
    log("warn", `external-tools: empty daemon command for '${managed.toolName}'`);
    return;
  }

  // Ensure config/ dir exists for the log file
  const configDir = join(managed.toolDir, "config");
  mkdirSync(configDir, { recursive: true });
  const logPath = join(configDir, "service.log");
  const logFd = openSync(logPath, "a");

  try {
    const child = spawn(spec.cmd, spec.args, {
      cwd: managed.toolDir,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...managed.config.env },
      detached: true,
    });

    managed.child = child;
    managed.lastStartTime = Date.now();

    log("info", `external-tools: started daemon '${managed.toolName}' (pid ${child.pid})`);

    child.on("error", (err) => {
      log("warn", `external-tools: daemon '${managed.toolName}' spawn error: ${err.message}`);
      managed.child = null;
      scheduleDaemonRestart(managed);
    });

    child.on("exit", (code, signal) => {
      managed.child = null;

      if (managed.stopping) return;

      log("warn", `external-tools: daemon '${managed.toolName}' exited (code=${code}, signal=${signal})`);

      const policy = managed.config.restart ?? "on-failure";
      const shouldRestart =
        policy === "always" || (policy === "on-failure" && code !== 0);

      if (shouldRestart) {
        scheduleDaemonRestart(managed);
      }
    });
  } finally {
    // Parent closes its copy — child inherited the fd on spawn
    closeSync(logFd);
  }
}

function scheduleDaemonRestart(managed: ManagedDaemon): void {
  if (managed.stopping) return;

  // Reset backoff after sustained uptime
  const uptime = Date.now() - managed.lastStartTime;
  if (uptime > BACKOFF_RESET_MS) managed.restartCount = 0;

  const delay = BACKOFF_MS[Math.min(managed.restartCount, BACKOFF_MS.length - 1)];
  managed.restartCount++;

  log("info", `external-tools: restarting daemon '${managed.toolName}' in ${delay / 1000}s (attempt ${managed.restartCount})`);

  managed.restartTimer = setTimeout(() => {
    managed.restartTimer = null;
    if (!managed.stopping) spawnDaemonProcess(managed);
  }, delay);
  managed.restartTimer.unref?.();
}

function startToolDaemon(tool: LoadedTool): void {
  if (!tool.manifest.daemon) return;

  const existing = _daemons.get(tool.manifest.name);
  if (existing?.child) return; // already running

  const managed: ManagedDaemon = {
    toolName: tool.manifest.name,
    toolDir: tool.toolDir,
    config: tool.manifest.daemon,
    child: null,
    restartCount: 0,
    restartTimer: null,
    lastStartTime: 0,
    stopping: false,
  };

  _daemons.set(tool.manifest.name, managed);
  spawnDaemonProcess(managed);
}

function stopToolDaemon(name: string): Promise<void> {
  const managed = _daemons.get(name);
  if (!managed) return Promise.resolve();

  managed.stopping = true;

  if (managed.restartTimer) {
    clearTimeout(managed.restartTimer);
    managed.restartTimer = null;
  }

  if (!managed.child || !managed.child.pid) {
    _daemons.delete(name);
    return Promise.resolve();
  }

  const child = managed.child;
  const pid = child.pid!;

  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(bailTimer);
      managed.child = null;
      _daemons.delete(name);
      resolve();
    };

    child.once("exit", () => {
      log("info", `external-tools: daemon '${name}' stopped (pid ${pid})`);
      settle();
    });

    // Send SIGTERM to the entire process group (negative PID)
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Process group already dead
      settle();
      return;
    }

    // Escalate to SIGKILL after 5s
    const forceKillTimer = setTimeout(() => {
      log("warn", `external-tools: force-killing daemon '${name}' (pgid ${pid})`);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already dead
      }
    }, 5_000);

    // Bail-out: resolve even if exit event never fires (7s total)
    const bailTimer = setTimeout(() => {
      log("warn", `external-tools: giving up waiting for daemon '${name}' (pid ${pid})`);
      settle();
    }, 7_000);
  });
}

function stopAllDaemons(): Promise<void> {
  const promises = [..._daemons.keys()].map((name) => stopToolDaemon(name));
  return Promise.all(promises).then(() => {});
}

// ── External tools directory ─────────────────────────────────────
// Resolved from import.meta.dir via @exocortex/shared/paths — no
// git dependency, survives mv of the repo.

// ── Manifest loading ─────────────────────────────────────────────

function loadManifest(toolDir: string): LoadedTool | null {
  const manifestPath = join(toolDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const data = JSON.parse(raw);

    // Validate required fields
    if (
      typeof data.name !== "string" || !data.name ||
      typeof data.bin !== "string" || !data.bin ||
      typeof data.systemHint !== "string" ||
      typeof data.display !== "object" || !data.display ||
      typeof data.display.label !== "string" ||
      typeof data.display.color !== "string"
    ) {
      log("warn", `external-tools: invalid manifest at ${manifestPath} — skipping`);
      return null;
    }

    // Validate optional shell field
    if (data.shell !== undefined && !isValidShellConfig(data.shell)) {
      log("warn", `external-tools: invalid shell config in ${manifestPath} — ignoring shell hints`);
      data.shell = undefined;
    }

    // Validate optional daemon field
    if (data.daemon !== undefined) {
      if (typeof data.daemon !== "object" || typeof data.daemon.command !== "string" || !data.daemon.command) {
        log("warn", `external-tools: invalid daemon config in ${manifestPath} — ignoring daemon`);
        data.daemon = undefined;
      }
    }

    const binPath = resolve(toolDir, data.bin);
    const binDir = dirname(binPath);

    if (!existsSync(binPath)) {
      log("warn", `external-tools: binary not found at ${binPath} (declared in ${manifestPath}) — skipping`);
      return null;
    }

    return {
      manifest: data as Manifest,
      binDir,
      toolDir,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `external-tools: failed to read ${manifestPath}: ${msg}`);
    return null;
  }
}

function scanTools(dir: string): LoadedTool[] {
  if (!existsSync(dir)) return [];

  const tools: LoadedTool[] = [];
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const toolDir = join(dir, entry);
    try {
      if (!statSync(toolDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const tool = loadManifest(toolDir);
    if (tool) tools.push(tool);
  }

  // Sort by name for deterministic ordering
  tools.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return tools;
}

// ── PATH management ──────────────────────────────────────────────

function updatePath(tools: LoadedTool[]): void {
  if (tools.length === 0) {
    process.env.PATH = BASE_PATH;
    return;
  }
  // Deduplicate bin dirs (multiple tools could share a bin/ directory)
  const dirs = [...new Set(tools.map(t => t.binDir))];
  process.env.PATH = dirs.join(":") + ":" + BASE_PATH;
}

export function getToolReloadKey(tools: LoadedTool[]): string {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.manifest.name,
    bin: tool.manifest.bin,
    systemHint: tool.manifest.systemHint,
    display: tool.manifest.display,
    shell: tool.manifest.shell ?? null,
    daemon: tool.manifest.daemon ?? null,
    binDir: tool.binDir,
    toolDir: tool.toolDir,
  })));
}

function daemonSignature(daemon: ManifestDaemon | undefined): string {
  return JSON.stringify(daemon ?? null);
}

function daemonConfigChanged(oldTool: LoadedTool, newTool: LoadedTool): boolean {
  return oldTool.toolDir !== newTool.toolDir || daemonSignature(oldTool.manifest.daemon) !== daemonSignature(newTool.manifest.daemon);
}

// ── Apply scan results ───────────────────────────────────────────

function applyTools(tools: LoadedTool[]): boolean {
  // Check if anything actually changed
  const oldKey = getToolReloadKey(_tools);
  const newKey = getToolReloadKey(tools);
  if (oldKey === newKey) return false;

  const oldByName = new Map(_tools.map((tool) => [tool.manifest.name, tool]));
  const newByName = new Map(tools.map((tool) => [tool.manifest.name, tool]));

  // Stop daemons for removed tools or tools whose daemon config disappeared.
  for (const [name, oldTool] of oldByName) {
    const newTool = newByName.get(name);
    if (!newTool || (oldTool.manifest.daemon && !newTool.manifest.daemon)) {
      void stopToolDaemon(name);
    }
  }

  for (const [name, newTool] of newByName) {
    const oldTool = oldByName.get(name);
    if (!oldTool) {
      if (newTool.manifest.daemon) startToolDaemon(newTool);
      continue;
    }

    if (!oldTool.manifest.daemon && newTool.manifest.daemon) {
      startToolDaemon(newTool);
      continue;
    }

    if (oldTool.manifest.daemon && newTool.manifest.daemon && daemonConfigChanged(oldTool, newTool)) {
      void stopToolDaemon(name).then(() => startToolDaemon(newTool));
    }
  }

  _tools = tools;
  updatePath(tools);
  return true;
}

// ── Shell rewriting helpers ──────────────────────────────────────

export function rewriteExternalToolShellCommand(command: string, tools: LoadedTool[] = _tools): string {
  return rewriteExternalToolShellCommandForTools(command, tools);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Initialize external tools: scan, update PATH, start daemons, start watcher.
 * The onUpdate callback fires when tools are added, removed, or changed at runtime.
 */
export function initExternalTools(onUpdate?: () => void): void {
  _externalToolsDir = getExternalToolsDir();

  // Ensure directory exists (gitignored, may not exist yet)
  mkdirSync(_externalToolsDir, { recursive: true });

  // Initial scan
  const tools = scanTools(_externalToolsDir);
  _tools = tools;
  updatePath(tools);

  if (tools.length > 0) {
    log("info", `external-tools: loaded ${tools.length} tool(s): ${tools.map(t => t.manifest.name).join(", ")}`);
  }

  // Start declared daemons
  const daemonTools = tools.filter(t => t.manifest.daemon);
  for (const tool of daemonTools) {
    startToolDaemon(tool);
  }
  if (daemonTools.length > 0) {
    log("info", `external-tools: supervising ${daemonTools.length} daemon(s): ${daemonTools.map(t => t.manifest.name).join(", ")}`);
  }

  // Watch for changes
  const externalToolsDir = _externalToolsDir;
  try {
    _watcher = watch(externalToolsDir, { persistent: false, recursive: true }, (_eventType, _filename) => {
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        const updated = scanTools(externalToolsDir);
        if (applyTools(updated)) {
          log("info", `external-tools: reloaded — ${updated.length} tool(s): ${updated.map(t => t.manifest.name).join(", ") || "(none)"}`);
          onUpdate?.();
        }
      }, DEBOUNCE_MS);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `external-tools: failed to start watcher: ${msg}`);
  }
}

/** Stop the filesystem watcher and all supervised daemons (fire-and-forget). */
export function stopExternalTools(): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  stopAllDaemons();
}

/** Stop watcher and await all supervised daemons to exit. */
export async function stopExternalToolsAsync(): Promise<void> {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  await stopAllDaemons();
}

/** Aggregated system hints from all loaded external tools. */
export function getExternalToolHints(): string {
  const hints = _tools.flatMap((tool) => {
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
  return _tools.map(t => ({
    cmd: t.manifest.name,
    label: t.manifest.display.label,
    color: t.manifest.display.color,
  }));
}

/** Number of currently loaded external tools. */
export function getExternalToolCount(): number {
  return _tools.length;
}

/** Number of tool daemons currently being supervised. */
export function getSupervisedDaemonCount(): number {
  return _daemons.size;
}
