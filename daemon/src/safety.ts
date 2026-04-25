/**
 * Config-driven tool denylist.
 *
 * This is intentionally simple: config/config.json can provide per-tool string
 * patterns, or grouped entries with a shared reason. Patterns are matched
 * case-insitively against the tool's important string inputs and its full JSON
 * input. A pattern containing `*` is treated as a glob; otherwise it is a
 * substring match.
 */

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
    edit: ["file_path", "old_string", "new_string"],
    grep: ["pattern", "path", "glob", "type"],
    glob: ["pattern", "path"],
    browse: ["url", "prompt"],
    transcribe_audio: ["file_path", "mime_type"],
    generate_image: ["prompt"],
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
