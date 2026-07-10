import { buildOpenAIHeaders } from "./http";
import { buildCodexTurnMetadata, buildCodexWindowId, getCodexInstallationId } from "./identity";
import { OPENAI_RESPONSES_WEBSOCKETS_BETA } from "./constants";
import type { StreamOptions } from "../types";

const REMOTE_COMPACTION_BETA_FEATURE = "remote_compaction_v2";

export interface OpenAIRequestSession {
  accessToken: string;
  accountId: string | null;
  /** Stable key for the OpenAI account whose token/account-id this request uses. */
  accountKey?: string | null;
}

export function buildOpenAIRequestHeaders(
  session: OpenAIRequestSession,
  options: StreamOptions,
): Record<string, string> {
  const headers: Record<string, string> = buildOpenAIHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    Accept: "application/json",
    "OpenAI-Beta": OPENAI_RESPONSES_WEBSOCKETS_BETA,
    "x-codex-beta-features": REMOTE_COMPACTION_BETA_FEATURE,
    "x-codex-installation-id": getCodexInstallationId(),
  });

  if (options.promptCacheKey) {
    const windowId = options.codexWindowId ?? buildCodexWindowId(options.promptCacheKey);
    headers.session_id = options.promptCacheKey;
    headers["session-id"] = options.promptCacheKey;
    headers.thread_id = options.promptCacheKey;
    headers["thread-id"] = options.promptCacheKey;
    headers["x-client-request-id"] = options.promptCacheKey;
    headers["x-codex-window-id"] = windowId;
  }

  if (options.promptCacheKey && (options.codexTurnId || options.compaction)) {
    headers["x-codex-turn-metadata"] = JSON.stringify(buildCodexTurnMetadata(
      options.promptCacheKey,
      options.codexWindowId,
      options.compaction ? options.compactionMetadata ?? {} : undefined,
      options.codexTurnId,
      options.codexTurnStartedAtMs,
    ));
  }

  if (session.accountId) {
    headers["ChatGPT-Account-ID"] = session.accountId;
  }

  return headers;
}

export function buildPromptCacheBodyFields(options: StreamOptions): Record<string, string> {
  return options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {};
}
