/**
 * Tool style resolution.
 *
 * Resolves tool display data for rendering. Uses daemon-provided
 * registry as the base, with optional user overrides for bash
 * sub-commands loaded from ~/.config/exocortex/tool-styles.json.
 *
 * User overrides match the beginning of bash command strings.
 * Example config:
 * {
 *   "gmail": { "label": "Gmail", "color": "#4ddbb7" },
 *   "docker": { "label": "Docker", "color": "#0db7ed" }
 * }
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ToolDisplayInfo } from "./messages";
import { theme, hexToAnsi } from "./theme";

// ── Types ──────────────────────────────────────────────────────────

interface UserToolStyle {
  label: string;
  color: string;
}

export interface ResolvedToolDisplay {
  label: string;
  detail: string;
  fg: string;     // ANSI truecolor escape
}

// ── User overrides ─────────────────────────────────────────────────

let userStyles: Record<string, UserToolStyle> = {};

function loadUserStyles(): void {
  try {
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const path = join(xdg, "exocortex", "tool-styles.json");
    const data = readFileSync(path, "utf8");
    userStyles = JSON.parse(data);
  } catch {
    userStyles = {};
  }
}
loadUserStyles();

// ── Resolution ─────────────────────────────────────────────────────

/**
 * Resolve display properties for a tool call.
 *
 * For bash commands, checks user overrides first (matching the
 * start of the command string). Falls back to daemon-provided
 * registry, then to a generic default.
 */
export function resolveToolDisplay(
  toolName: string,
  summary: string,
  registry: ToolDisplayInfo[],
): ResolvedToolDisplay {
  const info = registry.find(t => t.name === toolName);

  // Bash: check user overrides for sub-command matching
  if (toolName === "bash") {
    const trimmed = summary.trimStart();
    for (const [cmd, style] of Object.entries(userStyles)) {
      if (trimmed === cmd || trimmed.startsWith(cmd + " ") || trimmed.startsWith(cmd + "\n")) {
        const detail = trimmed.slice(cmd.length).trimStart();
        return { label: style.label, detail, fg: hexToAnsi(style.color) };
      }
    }
  }

  // Use daemon-provided registry
  if (info) {
    return {
      label: info.label,
      detail: summary,
      fg: hexToAnsi(info.color),
    };
  }

  // Fallback — use theme's tool color
  return { label: toolName, detail: summary, fg: theme.tool };
}
