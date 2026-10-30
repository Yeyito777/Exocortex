import { isFastMode, type FastMode } from "./messages";
import { migrateLegacyDaybreak } from "./daybreak";
/**
 * Shared Exocortex config loader.
 *
 * The canonical user-facing config file is config/config.json.  Older
 * installs may still have config/theme.json; we read it as a compatibility
 * fallback only when config.json is absent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_ID,
  EFFORT_LEVELS,
  defaultEffortForModelId,
  type EffortLevel,
  type ModelId,
  type ProviderId,
} from "./messages";
import { agentCwdDir, configDir, repoRoot } from "./paths";

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
  /** Arguments passed directly. Supports {target}, {path}, and their :sh variants; remote openers also support {host}. */
  args?: string[];
}

export interface OpenFileRuleConfig extends OpenCommandConfig {
  /** File extensions handled by this opener, without a leading dot. */
  extensions?: string[];
  /** Also match existing regular text files by content, including extensionless files. */
  text?: boolean;
  /** Open the original file on the selected /ssh host instead of a downloaded preview. */
  remote?: OpenCommandConfig | null;
}

export interface OpenersConfig {
  /** Opener used for http/https links. Set to null to disable link opening. */
  url?: OpenCommandConfig | null;
  /** File openers matched by extension or text content, checked in order. */
  rules?: OpenFileRuleConfig[];
}

export interface OpenAIProviderConfig {
  /**
   * If true, an OpenAI usage_limit_reached 429 with a reset timestamp keeps the
   * stream open and retries when the usage window resets. Defaults to false.
   */
  retryOnUsageLimitReset?: boolean;
  /**
   * Monthly spending budget in USD for an API-key login. The status bar then
   * draws the key's spend as bars: the month against it, today against what
   * was left of it this morning spread over the days left. Unset: plain amounts.
   */
  monthlyBudgetUsd?: number;
  /**
   * A prepaid credit grant funding the API key. The status bar then shows the
   * spend counted since `since` against `amountUsd`, what is left, and how long
   * it lasts at the last week's pace. Takes precedence over `monthlyBudgetUsd`.
   */
  credit?: OpenAICreditConfig;
}

export interface OpenAICreditConfig {
  amountUsd: number;
  /** Day the grant was credited, YYYY-MM-DD (local time). */
  since: string;
  /** Day it expires, YYYY-MM-DD. */
  expires?: string;
}

export interface DeepSeekProviderConfig {
  /** Override the OpenAI-compatible DeepSeek API base URL. Defaults to https://api.deepseek.com. */
  baseUrl?: string;
}

export interface OpenCodeProviderConfig {
  /** Override the OpenCode Zen API base URL. Defaults to https://opencode.ai/zen/v1. */
  baseUrl?: string;
}

export interface AnthropicProviderConfig {
  /** /proxy: send Claude requests through another machine's logins (daemon/src/provider-proxy/manager.ts). */
  proxy?: { ssh?: string };
  /**
   * Run Claude turns on Claude API credits (an API key) while every Claude
   * subscription account is at a usage limit (docs/claude-accounts.md).
   */
  apiCreditFallback?: AnthropicApiCreditFallbackConfig;
}

export interface AnthropicApiCreditFallbackConfig {
  enabled?: boolean;
  /** The keys. With `strategy: "order"` (or no Console balances to go by), the order they are used in. */
  keys?: AnthropicApiCreditKeyConfig[];
  /**
   * Which key new credit turns take: `expiry` (default), the one whose Console
   * organization has the credit that expires soonest; `order`, the first in
   * `keys`. Either way a conversation stays on its key while its cache is warm.
   */
  strategy?: "expiry" | "order";
  /** A key with less left than this (USD, default 2) is used only when every key has. */
  minBalanceUsd?: number;
}

export interface AnthropicApiCreditKeyConfig {
  /** Name of the API key in the `secrets` store, e.g. ANTHROPIC_API_KEY_MAX2_CREDITS. Never the key itself. */
  secret: string;
  /** Short name shown in the status bar, e.g. "max2". Defaults to the secret name. */
  label?: string;
  /** The Claude account (`main`, `max2`, …) whose plan grants these credits: its row on the Accounts screen shows them. */
  account?: string;
  /**
   * Day of the month its credits are granted again (the plan's billing day).
   * A key out of credits waits until then; without it, the expiry day of its
   * monthly grant, else a day. The status bar counts "this cycle" from it
   * (else from the 1st).
   */
  renewsOnDay?: number;
  /**
   * The key's Claude Console organization, for its real balance: the daemon
   * reads it about hourly through a vimbrowser tab signed into that account
   * (providers/anthropic/credit-sync.ts). Without it, or until a sync
   * succeeds, the balance is estimated from `grants`.
   */
  console?: AnthropicApiCreditConsoleConfig;
  /**
   * The credit grants on the key's organization, for an estimated balance
   * while the Console's is unknown (no `console`, or no sync yet): each
   * grant's amount less what Exocortex counted the key spending, the
   * soonest-expiring grant first. Spend made elsewhere with the key is not seen.
   */
  grants?: AnthropicApiCreditGrantConfig[];
}

export interface AnthropicApiCreditConsoleConfig {
  /** Organization UUID, as in the Console's `/api/organizations` (not a secret). */
  org: string;
  /** The vimbrowser context signed into its account; unset: the default context. */
  browserContext?: string;
}

export interface AnthropicApiCreditGrantConfig {
  amountUsd: number;
  /** Last day it can be used, YYYY-MM-DD (local time); it expires at the end of that day. */
  expires: string;
  /** Day it was credited, YYYY-MM-DD; spend before it is not counted against it. */
  since?: string;
  /**
   * Granted again every month (a Claude Max plan's $200): each grant expires
   * on `expires`' day of the month and the next one, of the same amount,
   * starts then. An assumption: the plan's credits renew on that day.
   */
  monthly?: boolean;
  /** Short name, e.g. "Max" or "YC". */
  label?: string;
}

export interface ProvidersConfig {
  openai?: OpenAIProviderConfig;
  anthropic?: AnthropicProviderConfig;
  deepseek?: DeepSeekProviderConfig;
  opencode?: OpenCodeProviderConfig;
  /** OpenRouter API base URL override (API keys belong in provider auth or OPENROUTER_API_KEY). */
  openrouter?: { baseUrl?: string };
  /** Preserve unknown provider config blocks. */
  [provider: string]: unknown;
}

export interface AgentConfig {
  /** Compatibility working directory for daemon/ownerless operations. Conversation tools use isolated workspaces. */
  workingDirectory?: string;
  /** How long a turn waits for a /proxy link that is down for a reason that may clear up (no network, DNS, remote daemon away). Default 30. */
  proxyOutageWaitMinutes?: number;
  /** How deep native exo subagents may nest: 1 = only top-level conversations delegate, 2 (default) = their children may too. */
  maxSubagentDepth?: number;
}

export interface ClientHostsConfig {
  /**
   * Client IDs for the user's machines: the name client_bash's host takes and
   * the model sees. Lowercase letters, digits and dashes, up to 32. Keyed by
   * user@hostname as a machine announces itself ("root@localhost": "phone"),
   * which names every machine announcing it (the second gets phone-2), or by
   * one install's ID (its data/client-install-id), which names that machine
   * alone. An unnamed machine gets one from its platform or hostname (mac,
   * windows, toronto). IDs are kept across reconnects and restarts.
   */
  names?: Record<string, string>;
}

export type PingMode = "sound" | "notif" | "both";

export interface PingConfig {
  /** What the TUI should do when an assistant stream finishes. */
  mode?: PingMode | null;
  /** Sound file used by mode "sound" or "both". */
  sound?: string | null;
}

export interface ConversationDefaultsConfig {
  /** Provider used for newly-created conversations when a client does not override it. */
  provider?: ProviderId;
  /** Provider-scoped model id used for newly-created conversations. */
  model?: ModelId;
  /** Reasoning effort used for newly-created conversations. */
  effort?: EffortLevel;
  /** Whether OpenAI fast service tier is enabled for newly-created conversations. */
  fastMode?: FastMode;
}

export interface DefaultsConfig {
  /** User-configured conversation defaults. Absence means product defaults. */
  conversation?: ConversationDefaultsConfig;
  /** Preserve unknown future/user default blocks. */
  [key: string]: unknown;
}

export interface FeatureFlagsConfig {
  /** Expose the model-facing goal lifecycle tool. Defaults to true; set false to hide/disable it. */
  goalTool?: boolean;
  /** Preserve unknown future feature flags. */
  [feature: string]: unknown;
}

export interface ExperimentalConfig {
  /** Preserve unknown future experiments. */
  [experiment: string]: unknown;
}

export interface DiagnosticsConfig {
  /**
   * Collect correlated daemon/TUI conversation-open timings, event-loop lag,
   * and model/tool round traces (including OpenAI request submission).
   * Defaults to false because the extra clocks, bookkeeping, and
   * log I/O are intended for temporary investigations. Daemon JSONL diagnostics
   * are retained for seven days and capped at 32 MiB per kind/day.
   */
  performanceProfiling?: boolean;
  /** Preserve unknown future diagnostic settings. */
  [diagnostic: string]: unknown;
}

export interface ConversationDefaults {
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: FastMode;
}

export interface TuiConfig {
  /** If true, the TUI censors account/email labels in status and auth UI. */
  hideSensitiveInfo?: boolean;
  /** If true, the TUI shows output-token counts alongside response throughput. */
  diagnostics?: boolean;
  /** Ctrl+O: show every turn's work and every notification instead of folding them. */
  showTurnWork?: boolean;
  /** Clock for the message finish time in AI metadata: "12h" (default, `2:03pm`) or "24h" (`14:03`). */
  clock?: "12h" | "24h";
  /** How sidebar folders open: expand in place ("tree", default) or replace the list ("navigate"). */
  sidebarFolders?: "navigate" | "tree";
  /** Display math: typeset images on Kitty-graphics terminals ("auto", default), always "text", or force "image". */
  math?: "auto" | "text" | "image";
  /** Scroll the message area with terminal scroll regions (DECSTBM + SU/SD) and draw only exposed rows; default true. */
  scrollRegions?: boolean;
}

/** The app API (docs/app-api.md). */
export interface AppApiConfig {
  /** How long a disconnected app session's ephemeral conversations wait for it (ms); default 2 minutes. A client may ask for its own. */
  reconnectGraceMs?: number;
  /** Hand ephemeral app conversations to the next daemon on a graceful restart; default true. */
  ephemeralSurvivesRestart?: boolean;
}

export interface ExocortexConfig {
  /** The app API: reconnect grace and restart handoff. */
  appApi?: AppApiConfig;
  /** Active TUI theme name. */
  theme?: string;
  /** Experimental/product feature gates. */
  features?: FeatureFlagsConfig;
  /** Opt-in experimental features, all off by default. */
  experimental?: ExperimentalConfig;
  /** Opt-in runtime diagnostics. */
  diagnostics?: DiagnosticsConfig;
  /** User-overridable app defaults. */
  defaults?: DefaultsConfig;
  /** Agent/runtime behavior. */
  agent?: AgentConfig;
  /** The user's machines client_bash reaches. */
  clientHosts?: ClientHostsConfig;
  /** TUI ping behavior when an assistant stream finishes. */
  ping?: PingConfig;
  /** TUI display/privacy preferences. */
  tui?: TuiConfig;
  /** Legacy pre-/ping sound setting. Prefer ping.sound for new writes. */
  sound?: string | null;
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
        extensions: ["html"],
        command: "xdg-open",
        args: ["{path}"],
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
  return {
    theme: "whale",
    features: { goalTool: true },
    experimental: {},
    diagnostics: { performanceProfiling: false },
    agent: { workingDirectory: ".exocortex-cwd" },
    ping: { mode: null, sound: null },
    openers: defaultOpenersConfig(),
  };
}

/** Whether the temporary correlated daemon/TUI performance profiler is enabled. */
export function performanceProfilingEnabled(config: ExocortexConfig = readExocortexConfig()): boolean {
  return config.diagnostics?.performanceProfiling === true;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function agentWorkingDirectory(config: ExocortexConfig = readExocortexConfig()): string {
  const configured = config.agent?.workingDirectory;
  const raw = typeof configured === "string" && configured.trim()
    ? configured.trim()
    : agentCwdDir();
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(repoRoot(), expanded);
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

function isProviderId(value: unknown): value is ProviderId {
  return value === "openai" || value === "anthropic" || value === "deepseek" || value === "opencode" || value === "openrouter";
}

function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function normalizeModelId(value: unknown): ModelId | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

export function productConversationDefaults(provider: ProviderId = DEFAULT_PROVIDER_ID): ConversationDefaults {
  const model = DEFAULT_MODEL_BY_PROVIDER[provider];
  return {
    provider,
    model,
    effort: defaultEffortForModelId(provider, model),
    fastMode: false,
  };
}

/**
 * Return the user-saved conversation defaults from a config object, if present.
 * This performs only schema-level normalization; provider/model capability
 * validation lives in the TUI/daemon, where the live provider registry exists.
 */
export function configuredConversationDefaults(config: ExocortexConfig = readExocortexConfig()): ConversationDefaults | null {
  const defaults = config.defaults;
  if (!isObject(defaults)) return null;
  const conversation = defaults.conversation;
  if (!isObject(conversation)) return null;

  const provider = isProviderId(conversation.provider) ? conversation.provider : DEFAULT_PROVIDER_ID;
  const model = migrateLegacyDaybreak({
    provider, model: normalizeModelId(conversation.model) ?? DEFAULT_MODEL_BY_PROVIDER[provider],
  }).model;
  const effort = isEffortLevel(conversation.effort)
    ? conversation.effort
    : defaultEffortForModelId(provider, model);

  return {
    provider,
    model,
    effort,
    fastMode: isFastMode(conversation.fastMode) ? conversation.fastMode : false,
  };
}

/** Return the active conversation defaults, falling back to product defaults. */
export function effectiveConversationDefaults(config: ExocortexConfig = readExocortexConfig()): ConversationDefaults {
  return configuredConversationDefaults(config) ?? productConversationDefaults();
}

/** Persist a complete user conversation default, preserving unrelated config keys. */
export function saveConversationDefaults(defaults: ConversationDefaults): void {
  updateExocortexConfig((config) => {
    config.defaults = {
      ...(isObject(config.defaults) ? config.defaults : {}),
      conversation: { ...defaults },
    };
  });
}

/** Remove the user conversation default override, preserving unrelated config keys. */
export function clearConversationDefaults(): void {
  updateExocortexConfig((config) => {
    if (!isObject(config.defaults)) return;
    delete config.defaults.conversation;
    if (Object.keys(config.defaults).length === 0) delete config.defaults;
  });
}
