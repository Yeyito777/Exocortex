/**
 * Tool style resolution.
 *
 * Resolves tool display data for rendering. Uses daemon-provided
 * registry for built-in tools and daemon-provided external tool
 * styles for bash sub-command matching (e.g. "gmail" → Gmail).
 *
 * External tool styles are sent by the daemon on connect (and
 * re-broadcast when tools are added/removed at runtime).
 */

import type { ToolDisplayInfo, ExternalToolStyle } from "./messages";
import { theme, hexToAnsi } from "./theme";

// ── Types ──────────────────────────────────────────────────────────

export interface ResolvedToolDisplay {
  label: string;
  detail: string;
  fg: string;     // ANSI truecolor escape
  /** Original command prefix that matched (external tools only). Used for multi-line re-application. */
  cmd?: string;
}

// ── External tool matching ────────────────────────────────────────

/**
 * Try to match a command string against a single external tool style.
 * Returns resolved display if the command starts with the tool's cmd.
 */
function tryMatch(command: string, style: ExternalToolStyle): ResolvedToolDisplay | null {
  const { cmd } = style;
  if (command === cmd || command.startsWith(cmd + " ") || command.startsWith(cmd + "\n")) {
    const detail = command.slice(cmd.length).trimStart();
    return { label: style.label, detail, fg: hexToAnsi(style.color), cmd };
  }
  return null;
}

/**
 * Match a bash command summary against external tool styles.
 *
 * First tries matching the trimmed command directly. If that fails,
 * skips leading comment lines (# ...) and blank lines, then retries
 * against the first real command line. This handles cases where the
 * AI prepends comments like "# Fetch latest mentions\ngmail ...".
 */
function matchExternalTool(summary: string, styles: ExternalToolStyle[]): ResolvedToolDisplay | null {
  if (styles.length === 0) return null;

  const trimmed = summary.trimStart();
  for (const style of styles) {
    const m = tryMatch(trimmed, style);
    if (m) return m;
  }

  // Retry: skip leading comment and blank lines
  const lines = trimmed.split("\n");
  const firstCmd = lines.findIndex(l => {
    const t = l.trimStart();
    return t !== "" && !t.startsWith("#");
  });
  if (firstCmd > 0) {
    const cmdLine = lines[firstCmd].trimStart();
    for (const style of styles) {
      const m = tryMatch(cmdLine, style);
      if (m) return m;
    }
  }

  return null;
}

// ── Resolution ─────────────────────────────────────────────────────

/**
 * Resolve display properties for a tool call.
 *
 * For bash commands, checks external tool styles first (matching the
 * start of the command string). Falls back to daemon-provided
 * registry, then to a generic default.
 */
export function resolveToolDisplay(
  toolName: string,
  summary: string,
  registry: ToolDisplayInfo[],
  externalToolStyles?: ExternalToolStyle[],
): ResolvedToolDisplay {
  const info = registry.find(t => t.name === toolName);

  // Bash: check external tool styles for sub-command matching
  if (toolName === "bash" && externalToolStyles) {
    const match = matchExternalTool(summary, externalToolStyles);
    if (match) return match;
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
