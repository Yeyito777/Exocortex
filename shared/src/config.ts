/**
 * Shared Exocortex config loader.
 *
 * The canonical user-facing config file is config/config.json.  Older
 * installs may still have config/theme.json; we read it as a compatibility
 * fallback only when config.json is absent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { configDir } from "./paths";

export type SafetyDenylistEntry = string | {
  /** Human-readable explanation shown when any pattern in this group matches. */
  reason?: string;
  /** String/glob patterns denied for the tool. */
  patterns: string[];
};

export interface SafetyConfig {
  /** Set to false to disable all safety denylist checks. Defaults to true. */
  enabled?: boolean;
  /** Optional grouped form: safety.denylist.<toolName> = SafetyDenylistEntry[]. */
  denylist?: Record<string, SafetyDenylistEntry[]>;
  /** Optional simple form: safety.<toolName> = SafetyDenylistEntry[]. */
  [toolName: string]: unknown;
}

export interface OpenCommandConfig {
  /** Executable to spawn when opening a matching target. */
  command: string;
  /** Arguments passed to command. Supports {target}, {path}, {target:sh}, and {path:sh}. */
  args?: string[];
}

export interface OpenFileRuleConfig extends OpenCommandConfig {
  /** File extensions handled by this opener, without a leading dot. */
  extensions: string[];
}

export interface OpenersConfig {
  /** Opener used for http/https links. Set to null to disable link opening. */
  url?: OpenCommandConfig | null;
  /** File openers matched by extension, checked in order. */
  rules?: OpenFileRuleConfig[];
}

export interface OpenAIProviderConfig {
  /**
   * If true, an OpenAI usage_limit_reached 429 with a reset timestamp keeps the
   * stream open and retries when the usage window resets. Defaults to false.
   */
  retryOnUsageLimitReset?: boolean;
}

export interface ProvidersConfig {
  openai?: OpenAIProviderConfig;
  /** Preserve unknown provider config blocks. */
  [provider: string]: unknown;
}

export interface ExocortexConfig {
  /** Active TUI theme name. */
  theme?: string;
  /** TUI open-on-enter commands for links and file paths. */
  openers?: OpenersConfig;
  /** Provider-specific behavior. */
  providers?: ProvidersConfig;
  /** Tool safety policy. */
  safety?: SafetyConfig;
  /** Preserve unknown future/user keys. */
  [key: string]: unknown;
}

export function defaultOpenersConfig(): OpenersConfig {
  return {
    url: { command: "xdg-open", args: ["{target}"] },
    rules: [
      {
        extensions: [
          "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff",
          "avif", "heic", "heif", "svg", "ico", "jxl", "jp2", "ppm", "pgm",
          "pbm", "pnm", "pdf",
        ],
        command: "show",
        args: ["{path}"],
      },
      {
        extensions: [
          "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma",
          "aif", "aiff", "alac", "mid", "midi", "mov", "mp4", "m4v", "mkv",
          "webm", "avi",
        ],
        command: "st",
        args: ["-e", "zsh", "-ic", "exec audio-play {path:sh}"],
      },
      {
        extensions: ["md", "py", "txt"],
        command: "st",
        args: ["-e", "zsh", "-ic", "exec nvim {path:sh}"],
      },
    ],
  };
}

export function defaultExocortexConfig(): ExocortexConfig {
  return { theme: "whale", openers: defaultOpenersConfig() };
}

export function exocortexConfigPath(): string {
  return join(configDir(), "config.json");
}

export function legacyThemeConfigPath(): string {
  return join(configDir(), "theme.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Read config/config.json. If it does not exist, fall back to legacy
 * config/theme.json for the theme only.
 */
export function readExocortexConfig(): ExocortexConfig {
  const main = exocortexConfigPath();
  if (existsSync(main)) {
    const data = parseJsonObject(main);
    return data ? { ...data } as ExocortexConfig : {};
  }

  const defaultConfig = defaultExocortexConfig();

  // Legacy migration: old installs used config/theme.json. If present, carry
  // that theme into the generated config; otherwise default to whale.
  const legacyTheme = parseJsonObject(legacyThemeConfigPath());
  if (legacyTheme && typeof legacyTheme.theme === "string") {
    defaultConfig.theme = legacyTheme.theme;
  }

  try {
    writeExocortexConfig(defaultConfig);
  } catch {
    // If config cannot be written, still return the default so callers work.
  }

  return defaultConfig;
}

/** Write the whole config object to config/config.json. */
export function writeExocortexConfig(config: ExocortexConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(exocortexConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/** Read-modify-write helper that preserves unknown config keys. */
export function updateExocortexConfig(mutator: (config: ExocortexConfig) => ExocortexConfig | void): ExocortexConfig {
  const config = readExocortexConfig();
  const replacement = mutator(config);
  const next = replacement ?? config;
  writeExocortexConfig(next);
  return next;
}
