/**
 * Anthropic Messages API streaming client.
 *
 * Handles SSE parsing, auth token management, and retry logic.
 * This is the sole point of contact with the Anthropic API.
 */

import { randomBytes, randomUUID } from "crypto";
import { loadAuth, isTokenExpired, saveAuth } from "./store";
import { refreshTokens, AuthError } from "./auth";
import { injectToolBreakpoints, injectMessageBreakpoints } from "./cache";
import { log } from "./log";
import { ANTHROPIC_BASE_URL } from "./constants";
import type { ModelId, ApiMessage, ApiContentBlock } from "./messages";
export type { ApiMessage, ApiContentBlock };

export { AuthError };

// ── Config ──────────────────────────────────────────────────────────
const API_VERSION = "2023-06-01";
// IMPORTANT: User-Agent, beta headers, and metadata.user_id must mirror Claude
// Code exactly. The API uses these for request routing and priority — using a
// custom name (e.g. "exocortex/0.1.0") causes consistent load shedding
// (overloaded_error). Update these when Claude Code releases a new version.
// See Mnemo reference/api-request-identity.md for the full story.
const CLAUDE_CODE_VERSION = "2.1.68";
const CLAUDE_CODE_USER_AGENT = `claude-code/${CLAUDE_CODE_VERSION}`;
const BETA_BASE = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05";
const BETA_ADAPTIVE = `${BETA_BASE},adaptive-thinking-2026-01-28`;
const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 10;

let _userId: string | null = null;
const _sessionId: string = randomUUID();

function getMetadataUserId(): string {
  if (_userId) return _userId;
  const auth = loadAuth();
  const accountUuid = auth?.profile?.accountUuid ?? "";
  const userHash = randomBytes(32).toString("hex");
  _userId = `user_${userHash}_account_${accountUuid}_session_${_sessionId}`;
  return _userId;
}

const MODEL_IDS: Record<ModelId, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5-20251001",
  opus:   "claude-opus-4-6",
};

// ── Types ───────────────────────────────────────────────────────────

/** A tool call parsed from the API response. */
export interface ApiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** An ordered content block from a single API response (text or thinking). */
export type ContentBlock =
  | { type: "thinking"; text: string; signature: string }
  | { type: "text"; text: string };

export interface StreamResult {
  text: string;
  thinking: string;
  stopReason: string;
  blocks: ContentBlock[];
  toolCalls: ApiToolCall[];
  inputTokens?: number;
  outputTokens?: number;
}

export interface StreamCallbacks {
  onText: (chunk: string) => void;
  onThinking: (chunk: string) => void;
  onBlockStart?: (type: "text" | "thinking") => void;
  /** Fired incrementally when a signature_delta arrives during streaming. */
  onSignature?: (signature: string) => void;
  onHeaders?: (headers: Headers) => void;
  /** Fired when a transient stream error triggers a retry.
   *  Callers should reset any accumulated partial state (streamed blocks, etc.). */
  onRetry?: (attempt: number, maxAttempts: number, errorMessage: string, delaySec: number) => void;
}

export interface StreamOptions {
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  tools?: unknown[];
}

/** Non-retryable SSE error types — bad request, auth, or model not found. */
const NON_RETRYABLE_STREAM_ERRORS = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
]);

class RetryableStreamError extends Error {
  constructor(message: string) { super(message); this.name = "RetryableStreamError"; }
}

// ── Token management ────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) throw new Error("Not authenticated");

  if (isTokenExpired(auth.tokens)) {
    if (!auth.tokens.refreshToken) throw new Error("Token expired, no refresh token");
    log("info", "api: token expired, refreshing");
    const newTokens = await refreshTokens(auth.tokens.refreshToken);
    saveAuth({ ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
    return newTokens.accessToken;
  }

  return auth.tokens.accessToken;
}

async function forceRefreshToken(failedToken: string): Promise<string> {
  const auth = loadAuth();
  if (!auth?.tokens?.refreshToken) throw new Error("No refresh token");
  if (auth.tokens.accessToken !== failedToken) return auth.tokens.accessToken;
  const newTokens = await refreshTokens(auth.tokens.refreshToken);
  saveAuth({ ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
  return newTokens.accessToken;
}

// ── Request building ────────────────────────────────────────────────

function supportsAdaptive(model: ModelId): boolean {
  return model === "sonnet" || model === "opus";
}

function buildRequest(
  accessToken: string, messages: ApiMessage[], model: ModelId,
  maxTokens: number, system?: string, tools?: unknown[],
) {
  const adaptive = supportsAdaptive(model);
  const thinking = adaptive
    ? { type: "adaptive" }
    : { type: "enabled", budget_tokens: 10000 };

  const body: Record<string, unknown> = {
    model: MODEL_IDS[model], messages: injectMessageBreakpoints(messages),
    max_tokens: maxTokens, thinking, stream: true,
    metadata: { user_id: getMetadataUserId() },
  };
  if (tools && tools.length > 0) body.tools = injectToolBreakpoints(tools);
  if (system) {
    body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }

  return {
    url: `${ANTHROPIC_BASE_URL}/v1/messages?beta=true`,
    init: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": adaptive ? BETA_ADAPTIVE : BETA_BASE,
        "Content-Type": "application/json",
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "x-app": "cli",
      },
      body: JSON.stringify(body),
    } satisfies RequestInit,
  };
}

// ── SSE stream parser ───────────────────────────────────────────────

/** Internal block state tracked during SSE parsing. */
interface BlockState {
  type: "text" | "thinking" | "tool_use";
  text: string;
  id: string;          // tool_use
  name: string;        // tool_use
  inputJson: string;   // tool_use (accumulated partial JSON)
  signature: string;   // thinking
}

function finalizeBlock(
  block: BlockState,
  orderedBlocks: ContentBlock[],
  toolCalls: ApiToolCall[],
): void {
  if (block.type === "thinking") {
    if (block.text) {
      orderedBlocks.push({ type: "thinking", text: block.text, signature: block.signature });
    }
  } else if (block.type === "text") {
    if (block.text) {
      orderedBlocks.push({ type: "text", text: block.text });
    }
  } else if (block.type === "tool_use") {
    let input: Record<string, unknown> = {};
    try { if (block.inputJson) input = JSON.parse(block.inputJson); }
    catch { log("warn", `api: failed to parse tool input JSON for ${block.name}: ${block.inputJson.slice(0, 200)}`); }
    toolCalls.push({ id: block.id, name: block.name, input });
  }
}

async function readStream(res: Response, cb: StreamCallbacks): Promise<StreamResult> {
  if (!res.body) throw new Error("No response body");

  let fullText = "";
  let fullThinking = "";
  let stopReason = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const toolCalls: ApiToolCall[] = [];
  const orderedBlocks: ContentBlock[] = [];
  const blocks = new Map<number, BlockState>();

  const processEvent = (event: Record<string, unknown>) => {
    switch (event.type) {
      case "content_block_start": {
        const idx = event.index as number;
        const contentBlock = event.content_block as Record<string, unknown>;
        if (contentBlock.type === "text") {
          blocks.set(idx, { type: "text", text: "", id: "", name: "", inputJson: "", signature: "" });
          cb.onBlockStart?.("text");
        } else if (contentBlock.type === "thinking") {
          blocks.set(idx, { type: "thinking", text: "", id: "", name: "", inputJson: "", signature: "" });
          cb.onBlockStart?.("thinking");
        } else if (contentBlock.type === "tool_use") {
          blocks.set(idx, {
            type: "tool_use", text: "",
            id: (contentBlock.id as string) ?? "",
            name: (contentBlock.name as string) ?? "",
            inputJson: "", signature: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const idx = event.index as number;
        const block = blocks.get(idx);
        if (!block) break;
        const delta = event.delta as Record<string, string> | undefined;
        if (delta?.type === "text_delta") {
          block.text += delta.text;
          fullText += delta.text;
          cb.onText(delta.text);
        } else if (delta?.type === "thinking_delta") {
          block.text += delta.thinking;
          fullThinking += delta.thinking;
          cb.onThinking(delta.thinking);
        } else if (delta?.type === "signature_delta") {
          block.signature = delta.signature;
          cb.onSignature?.(delta.signature);
        } else if (delta?.type === "input_json_delta") {
          block.inputJson += delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const idx = event.index as number;
        const block = blocks.get(idx);
        if (block) finalizeBlock(block, orderedBlocks, toolCalls);
        break;
      }
      case "message_start": {
        const msg = event.message as Record<string, Record<string, number>> | undefined;
        if (msg?.usage) {
          // Total context = non-cached + cache-written + cache-read.
          // With prompt caching active, input_tokens alone is just the
          // tiny non-cached remainder (sometimes as low as 1).
          inputTokens = (msg.usage.input_tokens ?? 0)
            + (msg.usage.cache_creation_input_tokens ?? 0)
            + (msg.usage.cache_read_input_tokens ?? 0);
        }
        break;
      }
      case "message_delta": {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
        const delta = event.delta as Record<string, string> | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        break;
      }
      case "error": {
        const err = event.error as Record<string, string> | undefined;
        const errType = err?.type ?? "unknown";
        // User-facing message is just the API's message field (e.g. "Overloaded").
        // The full type (overloaded_error, api_error) is logged by retryBackoff.
        const reason = err?.message || errType;
        if (NON_RETRYABLE_STREAM_ERRORS.has(errType)) throw new Error(reason);
        throw new RetryableStreamError(reason);
      }
    }
  };

  const processLines = (lines: string[]) => {
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try { processEvent(JSON.parse(data)); }
      catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(
          () => reject(new RetryableStreamError(`No data for ${STREAM_STALL_TIMEOUT / 1000}s`)),
          STREAM_STALL_TIMEOUT,
        );
      }),
    ]).finally(() => clearTimeout(stallTimer!));
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    processLines(lines);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processLines(buffer.split("\n"));

  // Infer stop reason from tool calls if missing
  if (!stopReason && toolCalls.length > 0) stopReason = "tool_use";

  return { text: fullText, thinking: fullThinking, stopReason, blocks: orderedBlocks, toolCalls, inputTokens, outputTokens };
}

// ── Retry helper ───────────────────────────────────────────────────

/** Exponential backoff with jitter: 1s, 2s, 4s, 8s, … capped at 30s. */
function retryBackoff(
  attempt: number,
  errMsg: string,
  callbacks: StreamCallbacks,
): Promise<void> {
  const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
  const delaySec = Math.round(delay / 1000);
  log("warn", `api: ${errMsg}, retry ${attempt + 1}/${MAX_RETRIES} in ${delaySec}s`);
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, delaySec);
  return new Promise((r) => setTimeout(r, delay));
}

// ── Public: stream a message ────────────────────────────────────────

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { system, signal, maxTokens = 32000, tools } = options;
  let accessToken = await getAccessToken();
  let authRetried = false;
  let retryAttempt = 0;

  while (true) {
    const { url, init } = buildRequest(accessToken, messages, model, maxTokens, system, tools);
    const res = await fetch(url, { ...init, signal });

    // Auth errors → refresh once
    if (!authRetried && (res.status === 401 || (res.status === 403 && (await res.clone().text()).includes("revoked")))) {
      log("warn", `api: ${res.status}, refreshing token`);
      accessToken = await forceRefreshToken(accessToken);
      authRetried = true;
      continue;
    }

    // Retryable HTTP errors → backoff
    if (res.status === 429 || res.status === 529 || res.status === 503) {
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, `HTTP ${res.status}`, callbacks);
        continue;
      }
      const text = await res.text();
      throw new RetryableStreamError(`API error (${res.status}) after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
    }

    // Non-retryable errors
    if (!res.ok) {
      const text = await res.text();
      log("error", `api: error (${res.status}): ${text.slice(0, 500)}`);
      throw new Error(`API error (${res.status}): ${text}`);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readStream(res, callbacks);
    } catch (err) {
      // Retryable stream error → same backoff as HTTP-level errors
      if (err instanceof RetryableStreamError && retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, (err as Error).message, callbacks);
        continue;
      }
      throw err;
    }
  }
}
