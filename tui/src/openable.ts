import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultOpenersConfig, readExocortexConfig } from "@exocortex/shared/config";

export interface OpenableTargetMatch {
  target: string;
  start: number;
  end: number;
}

export interface OpenCommand {
  command: string;
  args: string[];
}

interface NormalizedOpenCommandConfig {
  command: string;
  args: string[];
}

interface ExtensionOpenRule extends NormalizedOpenCommandConfig {
  extensions: readonly string[];
}

interface NormalizedOpenersConfig {
  url: NormalizedOpenCommandConfig | null;
  rules: readonly ExtensionOpenRule[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeCommandConfig(value: unknown): NormalizedOpenCommandConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value.command !== "string" || value.command.trim() === "") return null;
  const args = Array.isArray(value.args)
    ? value.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return { command: value.command, args };
}

function normalizeExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const extensions = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase().replace(/^\.+/, "");
    if (normalized) extensions.add(normalized);
  }
  return [...extensions];
}

function normalizeOpenFileRule(value: unknown): ExtensionOpenRule | null {
  const command = normalizeCommandConfig(value);
  if (!command || !isRecord(value)) return null;
  const extensions = normalizeExtensions(value.extensions);
  if (extensions.length === 0) return null;
  return { ...command, extensions };
}

function defaultNormalizedOpenersConfig(): NormalizedOpenersConfig {
  const defaults = defaultOpenersConfig();
  return {
    url: normalizeCommandConfig(defaults.url) ?? { command: "xdg-open", args: ["{target}"] },
    rules: (defaults.rules ?? [])
      .map(normalizeOpenFileRule)
      .filter((rule): rule is ExtensionOpenRule => rule !== null),
  };
}

function readOpenersConfig(): NormalizedOpenersConfig {
  const defaults = defaultNormalizedOpenersConfig();
  const configured = readExocortexConfig().openers;
  if (!isRecord(configured)) return defaults;

  const url = hasOwn(configured, "url")
    ? (configured.url === null ? null : normalizeCommandConfig(configured.url))
    : defaults.url;

  const rules = hasOwn(configured, "rules")
    ? (Array.isArray(configured.rules)
      ? configured.rules
        .map(normalizeOpenFileRule)
        .filter((rule): rule is ExtensionOpenRule => rule !== null)
      : [])
    : defaults.rules;

  return { url, rules };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openableFilePathRegExp(rules: readonly ExtensionOpenRule[]): RegExp | null {
  const pattern = [...new Set(rules.flatMap((rule) => rule.extensions))]
    .map(escapeRegExp)
    .join("|");
  if (!pattern) return null;
  return new RegExp(String.raw`(?:~/|\.{1,2}/|/)\S*?\.(?:${pattern})\b`, "gi");
}

function trimTrailingTargetPunctuation(target: string): string {
  return target.replace(/[),.;:!?\]}]+$/g, "");
}

function extensionOf(filePath: string): string | null {
  const match = filePath.match(/\.([^.\/]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function ruleForPath(filePath: string, rules: readonly ExtensionOpenRule[]): ExtensionOpenRule | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  return rules.find((rule) => rule.extensions.includes(ext)) ?? null;
}

function expandUserPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function replaceLiteral(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement);
}

function renderCommandTemplate(template: string, target: string, path: string): string {
  let rendered = template;
  rendered = replaceLiteral(rendered, "{target:sh}", shellQuote(target));
  rendered = replaceLiteral(rendered, "{path:sh}", shellQuote(path));
  rendered = replaceLiteral(rendered, "{target}", target);
  rendered = replaceLiteral(rendered, "{path}", path);
  return rendered;
}

function commandFromConfig(config: NormalizedOpenCommandConfig, target: string, path = target): OpenCommand {
  return {
    command: renderCommandTemplate(config.command, target, path),
    args: config.args.map((arg) => renderCommandTemplate(arg, target, path)),
  };
}

function overlapsAny(match: OpenableTargetMatch, matches: readonly OpenableTargetMatch[]): boolean {
  return matches.some((existing) => match.start < existing.end && match.end > existing.start);
}

function collectUrlMatches(text: string): OpenableTargetMatch[] {
  const matches: OpenableTargetMatch[] = [];
  URL_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const target = trimTrailingTargetPunctuation(raw);
    if (!target) continue;
    matches.push({ target, start, end: start + target.length });
  }
  return matches;
}

function collectFilePathMatches(
  text: string,
  occupied: readonly OpenableTargetMatch[],
  rules: readonly ExtensionOpenRule[],
): OpenableTargetMatch[] {
  const matches: OpenableTargetMatch[] = [];
  const localFilePathRe = openableFilePathRegExp(rules);
  if (!localFilePathRe) return matches;

  for (const match of text.matchAll(localFilePathRe)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const target = trimTrailingTargetPunctuation(raw);
    if (!target || !ruleForPath(target, rules)) continue;

    const candidate = { target, start, end: start + target.length };
    if (overlapsAny(candidate, occupied)) continue;
    matches.push(candidate);
  }
  return matches;
}

/**
 * Find openable targets in rendered text.
 *
 * Targets are configured by config/config.json under openers:
 * - openers.url controls http/https link opening
 * - openers.rules controls local file extensions and commands
 */
export function findOpenableTargetMatches(text: string): OpenableTargetMatch[] {
  const openers = readOpenersConfig();
  const urlMatches = openers.url ? collectUrlMatches(text) : [];
  const fileMatches = collectFilePathMatches(text, urlMatches, openers.rules);
  return [...urlMatches, ...fileMatches].sort((a, b) => a.start - b.start);
}

export function resolveOpenCommand(target: string): OpenCommand | null {
  const openers = readOpenersConfig();

  if (/^https?:\/\//i.test(target)) {
    return openers.url ? commandFromConfig(openers.url, target) : null;
  }

  const rule = ruleForPath(target, openers.rules);
  if (!rule) return null;
  const expandedPath = expandUserPath(target);
  return commandFromConfig(rule, target, expandedPath);
}

export function openTargetDetached(target: string): boolean {
  const openCommand = resolveOpenCommand(target);
  if (!openCommand) return false;

  try {
    const child = spawn(openCommand.command, openCommand.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // Best effort: opening a target should never disrupt the TUI.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
