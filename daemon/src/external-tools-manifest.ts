import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { log } from "./log";
import { isValidShellConfig } from "./external-tools-shell";
import type { LoadedTool, Manifest } from "./external-tools-types";

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

export function scanExternalTools(dir: string): LoadedTool[] {
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
