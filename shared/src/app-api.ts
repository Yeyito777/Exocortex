/**
 * The app API: programs in any language use the user's daemon as a
 * dependency (docs/app-api.md). Shared constants, names and validation, so
 * the daemon and in-repo clients agree on them.
 */

/** Bumped only for incompatible changes; clients refuse a daemon whose version they do not know. */
export const APP_API_VERSION = 1;

/** An app's name, e.g. `nvim`, `lasebeam`. */
export const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An app-defined tool's name. */
export const APP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * - `saved`: in the sidebar under `apps/<app>/`, kept until deleted.
 * - `temporary`: on disk but hidden; deleted `idleTtlMs` after its last activity.
 * - `ephemeral`: memory only; ends with its owner's connection.
 */
export type AppLifetime = "saved" | "temporary" | "ephemeral";
export const APP_LIFETIMES: readonly AppLifetime[] = ["saved", "temporary", "ephemeral"];

/**
 * What the model gets besides the app's own text:
 * - `none`: nothing (the default).
 * - `agent`: the provider's agent base (Claude Code's own prompt, or
 *   Exocortex's environment header and the selected tools' hints).
 * - `full`: exactly what an ordinary conversation gets.
 */
export type AppSystemBase = "none" | "agent" | "full";
export const APP_SYSTEM_BASES: readonly AppSystemBase[] = ["none", "agent", "full"];

export interface AppSystemSpec {
  text?: string;
  base?: AppSystemBase;
}

/** Built-in tools by one provider-neutral name; each maps to its provider's own tools. */
export const APP_BUILTIN_TOOLS = [
  "bash", "read", "write", "edit", "glob", "grep", "web_search", "web_fetch",
  "exo", "chrono", "goal", "attach",
] as const;
export type AppBuiltinTool = typeof APP_BUILTIN_TOOLS[number];

/** A tool the app defines and runs itself. */
export interface AppToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool's input; an object schema. */
  inputSchema: Record<string, unknown>;
  /** How long the model waits for the app's answer; default 10 minutes. */
  timeoutMs?: number;
}

export interface AppToolsSpec {
  /** Built-in tools by neutral name, or "all" for what an ordinary conversation gets. Default none. */
  builtin?: string[] | "all";
  /** The app's own tools. Default none. */
  app?: AppToolDef[];
}

/** Declared by an app connection in client_capabilities. */
export interface AppClientInfo {
  name: string;
  version?: string;
  /**
   * The client's session token, to take its conversations back after a
   * dropped connection or a daemon restart. Omitted: the daemon makes one
   * (app_welcome.session); send that one when reconnecting.
   */
  session?: string;
  /** How long the session's ephemeral conversations wait for it to reconnect; default APP_DEFAULT_RECONNECT_GRACE_MS. */
  reconnectGraceMs?: number;
}

/** A session token: what app_welcome hands out, and what a reconnecting client sends back. */
export const APP_SESSION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** How long a disconnected session's ephemeral conversations wait for it to come back. */
export const APP_DEFAULT_RECONNECT_GRACE_MS = 2 * 60_000;
export const APP_MAX_RECONNECT_GRACE_MS = 24 * 60 * 60_000;

/**
 * How an app conversation's Claude turns may be billed (docs/app-api.md,
 * "Accounts and API credits"). Every field defaults to what an ordinary
 * conversation does.
 * - `credits`: `allow` (default): Claude subscription accounts first, API
 *   credits while every one is at a usage limit; `never`: subscriptions only.
 * - `whenLimited`: what a turn does when nothing it may use can run it:
 *   `wait` (default) until something can, or `error` at once
 *   (turn_result.limited says until when).
 */
export interface AppRouteSpec {
  credits?: "allow" | "never";
  whenLimited?: "wait" | "error";
}
export const APP_ROUTE_CREDITS = ["allow", "never"] as const;
export const APP_ROUTE_WHEN_LIMITED = ["wait", "error"] as const;

export const APP_DEFAULT_IDLE_TTL_MS = 60 * 60_000;
export const APP_MAX_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
export const APP_TOOL_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const APP_TOOL_MAX_TIMEOUT_MS = 24 * 60 * 60_000;
/** How long an app tool call waits for an owner when none is connected. */
export const APP_OWNER_WAIT_MS = 60_000;
export const APP_MAX_TOOLS = 128;
export const APP_MAX_SYSTEM_TEXT_BYTES = 1024 * 1024;
/** Saved app conversations live in `<APPS_FOLDER_NAME>/<app>/` in the sidebar. */
export const APPS_FOLDER_NAME = "apps";

/** An app conversation as the daemon reports it. */
export interface AppConversationInfo {
  convId: string;
  app: string;
  lifetime: AppLifetime;
  title: string;
  provider: string;
  model: string;
  effort?: string;
  createdAt: number;
  lastActivityAt: number;
  /** temporary only: when it is deleted unless something happens on it first. */
  expiresAt?: number;
  idleTtlMs?: number;
  /** Whether a connection currently owns it (receives its app tool calls). */
  ownerConnected: boolean;
  streaming: boolean;
  /** The app-supplied working directory, if any. */
  cwd?: string;
  /** The daemon-created working directory, when there is no app cwd. */
  workspace?: string;
  systemBase: AppSystemBase;
  /** The neutral built-in tool names it was created with. */
  builtinTools: string[] | "all";
  appTools: string[];
  /** Its route preferences, when it set any. */
  route?: AppRouteSpec;
  /** The Claude account its turns last ran on (Anthropic, several accounts), if any. */
  account?: string;
  /** Its turns run on Claude API credits now (every subscription account is at a limit). */
  billing?: "api-credits";
}

/** Why a turn awaited with `awaitResult` / `app_run` ended. */
export type TurnStopReason = "end_turn" | "aborted" | "error";

export function isAppName(value: unknown): value is string {
  return typeof value === "string" && APP_NAME_PATTERN.test(value);
}

export function isAppToolName(value: unknown): value is string {
  return typeof value === "string" && APP_TOOL_NAME_PATTERN.test(value);
}
