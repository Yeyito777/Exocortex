/**
 * Config-driven tool denylist.
 *
 * This is intentionally simple: config/config.json can provide per-tool string
 * patterns, or grouped entries with a shared reason. Patterns are matched
 * case-insitively against the tool's important string inputs and its full JSON
 * input. A pattern containing `*` is treated as a glob; otherwise it is a
 * substring match.
 *
 * Path-taking tools are also matched on the path they will actually touch
 * (resolved against the turn's cwd, `~` expanded, symlinks followed), and a
 * grep/glob search root is refused when a denied path lies under it. Bash is
 * matched on its command text only, which is best-effort: a shell can always
 * spell a path in a way no text pattern anticipates.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readExocortexConfig, type SafetyConfig } from "@exocortex/shared/config";

export interface SafetyPattern {
  pattern: string;
  reason?: string;
}

export interface SafetyDecision {
  allowed: boolean;
  toolName: string;
  pattern?: string;
  reason?: string;
  target?: string;
  message?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDenylistEntries(value: unknown): SafetyPattern[] {
  if (!Array.isArray(value)) return [];

  const patterns: SafetyPattern[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      patterns.push({ pattern: item });
      continue;
    }

    if (!isObject(item)) continue;
    const reason = typeof item.reason === "string" && item.reason.trim().length > 0
      ? item.reason.trim()
      : undefined;
    const groupPatterns = Array.isArray(item.patterns) ? item.patterns : [];
    for (const pattern of groupPatterns) {
      if (typeof pattern === "string" && pattern.length > 0) {
        patterns.push({ pattern, reason });
      }
    }
  }

  return patterns;
}

export function getToolDenylist(safety: SafetyConfig | undefined, toolName: string): SafetyPattern[] {
  if (!safety || safety.enabled === false) return [];

  const lower = toolName.toLowerCase();
  const denylist = isObject(safety.denylist) ? safety.denylist : undefined;

  return [
    ...parseDenylistEntries(safety[toolName]),
    ...(lower === toolName ? [] : parseDenylistEntries(safety[lower])),
    ...parseDenylistEntries(denylist?.[toolName]),
    ...(lower === toolName ? [] : parseDenylistEntries(denylist?.[lower])),
    ...parseDenylistEntries(safety["*"]),
    ...parseDenylistEntries(denylist?.["*"]),
  ];
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternMatches(pattern: string, target: string): boolean {
  const normalizedPattern = normalize(pattern);
  if (!normalizedPattern) return false;

  if (!normalizedPattern.includes("*")) {
    return target.includes(normalizedPattern);
  }

  const regex = new RegExp("^" + normalizedPattern.split("*").map(escapeRegExp).join(".*") + "$", "i");
  return regex.test(target);
}

function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) collectStringValues(item, out);
  }
  return out;
}

function primaryInputStrings(toolName: string, input: Record<string, unknown>): string[] {
  const keysByTool: Record<string, string[]> = {
    bash: ["command"],
    read: ["file_path"],
    write: ["file_path", "content"],
    edit: ["path", "oldText", "newText"],
    patch: ["input", "cwd"],
    grep: ["pattern", "path", "glob", "type"],
    glob: ["pattern", "patterns", "path", "exclude", "query"],
    browse: ["url", "prompt"],
  };

  const values: string[] = [];
  for (const key of keysByTool[toolName] ?? []) {
    const value = input[key];
    if (typeof value === "string") values.push(value);
  }
  return values;
}

function targetStrings(toolName: string, input: Record<string, unknown>): string[] {
  const values = [
    ...primaryInputStrings(toolName, input),
    ...collectStringValues(input),
    JSON.stringify(input),
  ].filter((value): value is string => typeof value === "string");

  return [...new Set(values.map(normalize).filter(Boolean))];
}

export function evaluateToolCallSafety(
  toolName: string,
  input: Record<string, unknown>,
  safety: SafetyConfig | undefined = readExocortexConfig().safety,
): SafetyDecision {
  const patterns = getToolDenylist(safety, toolName);
  if (patterns.length === 0) return { allowed: true, toolName };

  for (const entry of patterns) {
    for (const target of targetStrings(toolName, input)) {
      if (globPatternMatches(entry.pattern, target)) {
        return {
          allowed: false,
          toolName,
          pattern: entry.pattern,
          reason: entry.reason,
          target,
          message: `Blocked by Exocortex safety denylist for tool '${toolName}'.`,
        };
      }
    }
  }

  return { allowed: true, toolName };
}

export function formatSafetyBlock(decision: SafetyDecision): string {
  const lines = [decision.message ?? `Blocked by Exocortex safety denylist for tool '${decision.toolName}'.`];
  if (decision.reason) lines.push(`Reason: ${decision.reason}`);
  if (decision.pattern) lines.push(`Matched denylist pattern: ${decision.pattern}`);
  if (decision.target) lines.push(`Matched input: ${decision.target.length > 500 ? decision.target.slice(0, 500) + "..." : decision.target}`);
  lines.push("Edit config/config.json manually if this denylist entry should change.");
  return lines.join("\n");
}

// ── Resolved paths ──────────────────────────────────────────────────

/** The absolute path a tool will touch, `~` expanded, relative to the turn's cwd. */
function absoluteToolPath(path: string, cwd: string): string {
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** realpath of the deepest existing ancestor, so a not-yet-created file under a symlinked directory resolves too. */
function realToolPath(path: string): string {
  const rest: string[] = [];
  let current = path;
  while (true) {
    try {
      return rest.length > 0 ? join(realpathSync(current), ...rest.reverse()) : realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

function pathVariants(path: string, cwd: string): string[] {
  const absolute = absoluteToolPath(path, cwd);
  return [...new Set([absolute, realToolPath(absolute)])];
}

/** The fixed absolute-path prefix a pattern denies (`*\/home/x/keys.sh*` → `/home/x/keys.sh`), if any. */
function deniedPathPrefix(pattern: string): string | null {
  const stripped = pattern.replace(/^\*+/, "");
  const prefix = stripped.split("*")[0]!.trim();
  if (!prefix.startsWith("/")) return null;
  return prefix.length > 1 ? prefix.replace(/\/+$/, "") : prefix;
}

function isWithin(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(normalizedParent);
}

export interface PathSafetyTargets {
  /** Denylists consulted for these paths (e.g. `patch` also honors `write` and `edit`). */
  toolNames: string[];
  /** Files the tool reads or writes. */
  files: string[];
  /** Directories the tool searches recursively (grep/glob). */
  searchRoots: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function patchFilePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line.trimEnd());
    if (match) paths.push(match[1]!.trim());
  }
  return paths;
}

/** The files and search roots a tool call touches, for the denylist. */
export function pathSafetyTargets(toolName: string, input: Record<string, unknown>, cwd: string): PathSafetyTargets | null {
  const str = (key: string) => typeof input[key] === "string" && (input[key] as string).length > 0 ? input[key] as string : undefined;
  switch (toolName) {
    case "read": return { toolNames: ["read"], files: stringArray([str("file_path")]), searchRoots: [] };
    case "view_image": return { toolNames: ["read"], files: stringArray([str("path")]), searchRoots: [] };
    case "attach": return { toolNames: ["read"], files: stringArray(input.paths), searchRoots: [] };
    case "write": return { toolNames: ["write"], files: stringArray([str("file_path")]), searchRoots: [] };
    case "edit": return { toolNames: ["edit", "write"], files: stringArray([str("path")]), searchRoots: [] };
    case "patch":
    case "apply_patch": {
      const text = str("input") ?? str("patch") ?? "";
      const patchCwd = str("cwd") ? absoluteToolPath(str("cwd")!, cwd) : cwd;
      return {
        toolNames: ["patch", "write", "edit"],
        files: patchFilePaths(text).map(path => absoluteToolPath(path, patchCwd)),
        searchRoots: [],
      };
    }
    case "grep": return { toolNames: ["grep", "read"], files: [], searchRoots: [str("path") ?? cwd] };
    case "glob": return { toolNames: ["glob"], files: [], searchRoots: [str("path") ?? cwd] };
    default: return null;
  }
}

/**
 * Match the denylist against the paths a tool call will really touch, not the
 * text the model wrote: `./`, `//`, `..`, relative paths and symlinks all
 * resolve to the same file. A search root is denied when a denied path lies
 * under it, since searching it would read (or list) that file.
 */
export function evaluatePathSafety(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  safety: SafetyConfig | undefined = readExocortexConfig().safety,
): SafetyDecision {
  const targets = pathSafetyTargets(toolName, input, cwd);
  if (!targets) return { allowed: true, toolName };
  const patterns = targets.toolNames.flatMap(name => getToolDenylist(safety, name));
  if (patterns.length === 0) return { allowed: true, toolName };

  const blocked = (entry: SafetyPattern, target: string): SafetyDecision => ({
    allowed: false,
    toolName,
    pattern: entry.pattern,
    reason: entry.reason,
    target,
    message: `Blocked by Exocortex safety denylist for tool '${toolName}'.`,
  });

  for (const file of targets.files) {
    for (const variant of pathVariants(file, cwd)) {
      const normalized = normalize(variant);
      for (const entry of patterns) {
        if (globPatternMatches(entry.pattern, normalized)) return blocked(entry, variant);
      }
    }
  }
  for (const root of targets.searchRoots) {
    for (const variant of pathVariants(root, cwd)) {
      const normalizedRoot = normalize(variant);
      for (const entry of patterns) {
        if (globPatternMatches(entry.pattern, normalizedRoot)) return blocked(entry, variant);
        const prefix = deniedPathPrefix(normalize(entry.pattern));
        if (prefix && (isWithin(prefix, normalizedRoot) || isWithin(normalizedRoot, prefix))) return blocked(entry, variant);
      }
    }
  }
  return { allowed: true, toolName };
}
