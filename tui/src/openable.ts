import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenableTargetMatch {
  target: string;
  start: number;
  end: number;
}

export interface OpenCommand {
  command: string;
  args: string[];
}

interface ExtensionOpenRule {
  extensions: readonly string[];
  commandForPath(filePath: string): OpenCommand;
}

const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff",
  "avif", "heic", "heif", "svg", "ico", "jxl", "jp2", "ppm", "pgm",
  "pbm", "pnm",
] as const;

const AUDIO_EXTENSIONS = [
  "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma",
  "aif", "aiff", "alac", "mid", "midi", "mov", "mp4", "m4v", "mkv",
  "webm", "avi",
] as const;

const SHOW_EXTENSIONS = [...IMAGE_EXTENSIONS, "pdf"] as const;
const NVIM_EXTENSIONS = ["md", "py", "txt"] as const;

function terminalCommand(commandLine: string): OpenCommand {
  return { command: "st", args: ["-e", "zsh", "-ic", commandLine] };
}

const EXTENSION_OPEN_RULES: readonly ExtensionOpenRule[] = [
  {
    extensions: SHOW_EXTENSIONS,
    commandForPath: (filePath) => ({ command: "show", args: [filePath] }),
  },
  {
    extensions: AUDIO_EXTENSIONS,
    commandForPath: (filePath) => terminalCommand(`exec audio-play ${shellQuote(filePath)}`),
  },
  {
    extensions: NVIM_EXTENSIONS,
    commandForPath: (filePath) => terminalCommand(`exec nvim ${shellQuote(filePath)}`),
  },
];

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OPENABLE_EXTENSION_PATTERN = [...new Set(EXTENSION_OPEN_RULES.flatMap((rule) => rule.extensions))]
  .map(escapeRegExp)
  .join("|");

const LOCAL_FILE_PATH_RE = new RegExp(
  String.raw`(?:~/|\.{1,2}/|/)\S*?\.(?:${OPENABLE_EXTENSION_PATTERN})\b`,
  "gi",
);

function trimTrailingTargetPunctuation(target: string): string {
  return target.replace(/[),.;:!?\]}]+$/g, "");
}

function extensionOf(filePath: string): string | null {
  const match = filePath.match(/\.([^.\/]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function ruleForPath(filePath: string): ExtensionOpenRule | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  return EXTENSION_OPEN_RULES.find((rule) => rule.extensions.includes(ext)) ?? null;
}

function expandUserPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

function collectFilePathMatches(text: string, occupied: readonly OpenableTargetMatch[]): OpenableTargetMatch[] {
  const matches: OpenableTargetMatch[] = [];
  LOCAL_FILE_PATH_RE.lastIndex = 0;
  for (const match of text.matchAll(LOCAL_FILE_PATH_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const target = trimTrailingTargetPunctuation(raw);
    if (!target || !ruleForPath(target)) continue;

    const candidate = { target, start, end: start + target.length };
    if (overlapsAny(candidate, occupied)) continue;
    matches.push(candidate);
  }
  return matches;
}

/**
 * Find openable targets in rendered text.
 *
 * Targets currently include:
 * - local files with configured extension rules
 * - http/https links, opened through xdg-open
 */
export function findOpenableTargetMatches(text: string): OpenableTargetMatch[] {
  const urlMatches = collectUrlMatches(text);
  const fileMatches = collectFilePathMatches(text, urlMatches);
  return [...urlMatches, ...fileMatches].sort((a, b) => a.start - b.start);
}

export function resolveOpenCommand(target: string): OpenCommand | null {
  if (/^https?:\/\//i.test(target)) {
    return { command: "xdg-open", args: [target] };
  }

  const rule = ruleForPath(target);
  if (!rule) return null;
  return rule.commandForPath(expandUserPath(target));
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
