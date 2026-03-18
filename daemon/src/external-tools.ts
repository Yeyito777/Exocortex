/**
 * External tools — discovery, PATH injection, and runtime watching.
 *
 * Scans external-tools/{tool}/manifest.json for tool metadata.
 * Each manifest declares:
 *   - name:       command name (e.g. "gmail")
 *   - bin:        relative path to executable (e.g. "./gmail" or "./bin/twitter")
 *   - systemHint: text injected into the system prompt
 *   - display:    { label, color } for TUI bash sub-command styling
 *
 * On startup, all manifests are loaded and:
 *   - Their bin directories are prepended to process.env.PATH
 *   - System hints are aggregated for the system prompt builder
 *   - Display styles are collected for the TUI
 *
 * A filesystem watcher on the external-tools/ directory detects tools
 * being added or removed at runtime. Changes are debounced and trigger
 * a full re-scan + callback so the daemon can broadcast updated styles
 * to connected clients.
 */

import { readFileSync, readdirSync, statSync, watch, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { execSync } from "child_process";
import { log } from "./log";
import type { ExternalToolStyle } from "@exocortex/shared/messages";

// ── Manifest schema ──────────────────────────────────────────────

interface Manifest {
  name: string;
  bin: string;
  systemHint: string;
  display: {
    label: string;
    color: string;
  };
}

interface LoadedTool {
  manifest: Manifest;
  /** Absolute path to the directory containing the binary. */
  binDir: string;
}

// ── State ────────────────────────────────────────────────────────

const BASE_PATH = process.env.PATH ?? "";
let _tools: LoadedTool[] = [];
let _watcher: ReturnType<typeof watch> | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _externalToolsDir: string | null = null;

const DEBOUNCE_MS = 1_000;

// ── Repo root resolution ─────────────────────────────────────────

function resolveExternalToolsDir(): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return join(root, "external-tools");
  } catch {
    return null;
  }
}

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

    const binPath = resolve(toolDir, data.bin);
    const binDir = dirname(binPath);

    if (!existsSync(binPath)) {
      log("warn", `external-tools: binary not found at ${binPath} (declared in ${manifestPath}) — skipping`);
      return null;
    }

    return {
      manifest: data as Manifest,
      binDir,
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

// ── Apply scan results ───────────────────────────────────────────

function applyTools(tools: LoadedTool[]): boolean {
  // Check if anything actually changed
  const oldNames = _tools.map(t => t.manifest.name).join(",");
  const newNames = tools.map(t => t.manifest.name).join(",");
  if (oldNames === newNames) return false;

  _tools = tools;
  updatePath(tools);
  return true;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Initialize external tools: scan, update PATH, start watcher.
 * The onUpdate callback fires when tools are added or removed at runtime.
 */
export function initExternalTools(onUpdate?: () => void): void {
  _externalToolsDir = resolveExternalToolsDir();
  if (!_externalToolsDir) {
    log("warn", "external-tools: could not resolve repo root — external tools disabled");
    return;
  }

  // Ensure directory exists (gitignored, may not exist yet)
  mkdirSync(_externalToolsDir, { recursive: true });

  // Initial scan
  const tools = scanTools(_externalToolsDir);
  _tools = tools;
  updatePath(tools);

  if (tools.length > 0) {
    log("info", `external-tools: loaded ${tools.length} tool(s): ${tools.map(t => t.manifest.name).join(", ")}`);
  }

  // Watch for changes
  try {
    _watcher = watch(_externalToolsDir, { persistent: false }, (_eventType, _filename) => {
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        const updated = scanTools(_externalToolsDir!);
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

/** Stop the filesystem watcher. */
export function stopExternalTools(): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
}

/** Aggregated system hints from all loaded external tools. */
export function getExternalToolHints(): string {
  const hints = _tools
    .filter(t => t.manifest.systemHint)
    .map(t => t.manifest.systemHint);
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
