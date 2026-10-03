import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { conversationWorkspaceDir } from "@exocortex/shared/paths";
import { defaultOpenersConfig, readExocortexConfig } from "@exocortex/shared/config";
import { isWebUrl, localPathFromTarget, trimUrlPunctuation } from "./links";
import { isEditableTextFile } from "./text-file";
import { validateSshAlias } from "./ssh-transport";

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

interface FileOpenRule extends NormalizedOpenCommandConfig {
  extensions: readonly string[];
  text: boolean;
  remote: NormalizedOpenCommandConfig | null;
}

interface NormalizedOpenersConfig {
  url: NormalizedOpenCommandConfig | null;
  rules: readonly FileOpenRule[];
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

function normalizeOpenFileRule(value: unknown): FileOpenRule | null {
  const command = normalizeCommandConfig(value);
  if (!command || !isRecord(value)) return null;
  const extensions = normalizeExtensions(value.extensions);
  const text = value.text === true;
  if (extensions.length === 0 && !text) return null;
  return { ...command, extensions, text, remote: normalizeCommandConfig(value.remote) };
}

function defaultNormalizedOpenersConfig(): NormalizedOpenersConfig {
  const defaults = defaultOpenersConfig();
  return {
    url: normalizeCommandConfig(defaults.url) ?? { command: "xdg-open", args: ["{target}"] },
    rules: (defaults.rules ?? [])
      .map(normalizeOpenFileRule)
      .filter((rule): rule is FileOpenRule => rule !== null),
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
        .filter((rule): rule is FileOpenRule => rule !== null)
      : [])
    : defaults.rules;

  return { url, rules };
}

const LOCAL_PATH_RE = /(?:file:\/\/(?:localhost)?\/|~\/|\.{1,2}\/|\/)[^\s<>"`]+/gi;

function trimTrailingTargetPunctuation(target: string): string {
  return target.replace(/[),.;:!?'\]}]+$/g, "");
}

function extensionOf(filePath: string): string | null {
  const match = filePath.match(/\.([^.\/]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function ruleForPath(filePath: string, rules: readonly FileOpenRule[], textPath?: string): FileOpenRule | null {
  const ext = extensionOf(filePath);
  let isText: boolean | undefined;
  return rules.find(rule => {
    if (ext && rule.extensions.includes(ext)) return true;
    // Only inspect content when resolving an actual open, not during history
    // hit-testing: over /ssh, the displayed path belongs to the remote daemon.
    return rule.text && textPath !== undefined && (isText ??= isEditableTextFile(textPath));
  }) ?? null;
}

function expandUserPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderCommandTemplate(template: string, target: string, path: string, host?: string): string {
  const values: Record<string, string | undefined> = { target, path, host };
  // One pass: placeholder-looking text inside a filename is always literal.
  return template.replace(/\{(target|path|host)(:sh)?\}/g, (literal, key: string, quote: string | undefined) => {
    const value = values[key];
    return value === undefined ? literal : quote ? shellQuote(value) : value;
  });
}

function commandFromConfig(config: NormalizedOpenCommandConfig, target: string, path = target, host?: string): OpenCommand {
  return {
    command: renderCommandTemplate(config.command, target, path, host),
    args: config.args.map((arg) => renderCommandTemplate(arg, target, path, host)),
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
    const target = trimUrlPunctuation(raw);
    if (!isWebUrl(target)) continue;
    matches.push({ target, start, end: start + target.length });
  }
  return matches;
}

function collectFilePathMatches(
  text: string,
  occupied: readonly OpenableTargetMatch[],
  rules: readonly FileOpenRule[],
): OpenableTargetMatch[] {
  const matches: OpenableTargetMatch[] = [];
  if (rules.length === 0) return matches;
  const hasTextRule = rules.some(rule => rule.text);
  LOCAL_PATH_RE.lastIndex = 0;

  for (const match of text.matchAll(LOCAL_PATH_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    // Do not find a local path inside a URL, scheme, or ordinary word.
    if (start > 0 && /[\w:/\\]/.test(text[start - 1])) continue;
    const target = trimTrailingTargetPunctuation(raw);
    const path = localPathFromTarget(target);
    if (path === null || (!hasTextRule && !ruleForPath(path, rules))) continue;

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
 * - openers.rules controls local file extensions, text matching, and commands
 */
export function findOpenableTargetMatches(text: string): OpenableTargetMatch[] {
  const openers = readOpenersConfig();
  const urls = collectUrlMatches(text);
  const fileMatches = collectFilePathMatches(text, urls, openers.rules);
  return [...(openers.url ? urls : []), ...fileMatches].sort((a, b) => a.start - b.start);
}

export interface OpenTargetOptions {
  baseDirectory?: string;
  /** Explicit Markdown links can open folders and files without extension rules. */
  localLink?: boolean;
}

/** Hit-testing is syntax/config only; a history path may live on an SSH host. */
export function canOpenLinkTarget(target: string): boolean {
  if (/^https?:\/\//i.test(target)) return isWebUrl(target) && readOpenersConfig().url !== null;
  return localPathFromTarget(target) !== null;
}

export function resolveOpenCommand(target: string, options: OpenTargetOptions = {}): OpenCommand | null {
  const openers = readOpenersConfig();

  if (/^https?:\/\//i.test(target)) {
    return openers.url && isWebUrl(target) ? commandFromConfig(openers.url, target) : null;
  }

  const localPath = localPathFromTarget(target);
  if (localPath === null) return null;
  const expandedPath = resolve(options.baseDirectory ?? process.cwd(), expandUserPath(localPath));
  const rule = ruleForPath(localPath, openers.rules, expandedPath);
  if (!rule) return options.localLink ? { command: "xdg-open", args: [expandedPath] } : null;
  return commandFromConfig(rule, target, expandedPath);
}

/** Match a daemon-resolved remote file without ever probing the TUI host's path. */
export function resolveRemoteOpenCommand(
  alias: string,
  path: string,
  options: { text?: boolean; target?: string } = {},
): OpenCommand | null {
  if (validateSshAlias(alias) || !path.startsWith("/") || path.startsWith("//")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) return null;
  const ext = extensionOf(path);
  for (const rule of readOpenersConfig().rules) {
    if ((ext !== null && rule.extensions.includes(ext)) || (rule.text && options.text === true)) {
      return rule.remote ? commandFromConfig(rule.remote, options.target ?? path, path, alias) : null;
    }
    // A higher-priority content rule must be classified before selecting a
    // later extension rule. Do not silently change first-match ordering over SSH.
    if (rule.text && options.text === undefined) return null;
  }
  return null;
}

/** Resolve on process creation, not editor exit: remote editing owns the new terminal. */
export function openCommandDetached(command: OpenCommand): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(command.command, command.args, { detached: true, stdio: "ignore", shell: false });
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** History links belong to the conversation, not the terminal's launch directory. */
export function openConversationTarget(target: string, conversationId: string | null): boolean {
  return openTargetDetached(target, {
    baseDirectory: conversationId ? conversationWorkspaceDir(conversationId) : undefined,
    localLink: true,
  });
}

export function openTargetDetached(target: string, options: OpenTargetOptions = {}): boolean {
  const openCommand = resolveOpenCommand(target, options);
  if (!openCommand) return false;

  try {
    const child = spawn(openCommand.command, openCommand.args, {
      detached: true,
      stdio: "ignore",
      cwd: options.baseDirectory,
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
