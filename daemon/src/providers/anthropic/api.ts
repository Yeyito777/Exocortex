/**
 * Anthropic Messages API streaming client.
 */

import { createHash, randomBytes, randomUUID } from "crypto";
import { loadAuth, isTokenExpired, saveAuth } from "../../store";
import { refreshTokens, getVerifiedAccessToken, AuthError } from "./auth";
import { injectToolBreakpoints, injectMessageBreakpoints } from "./cache";
import { log } from "../../log";
import { ANTHROPIC_BASE_URL } from "./constants";
import { DEFAULT_EFFORT, type ModelId, type EffortLevel, type ApiMessage, type ApiContentBlock } from "../../messages";
import type { ApiToolCall, ContentBlock, StreamResult, StreamCallbacks, StreamOptions } from "../types";

export { AuthError };

const API_VERSION = "2023-06-01";
const CLAUDE_CODE_VERSION = "2.1.81";
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
const BETA_FLAGS = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,effort-2025-11-24";
const BILLING_SALT = "59cf53e54c78";

function versionHash(messages: ApiMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  let text = "";
  if (firstUser) {
    const content = firstUser.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: ApiContentBlock) => b.type === "text");
      if (tb && "text" in tb) text = tb.text;
    }
  }
  const chars = [4, 7, 20].map((i) => text[i] || "0").join("");
  return createHash("sha256").update(`${BILLING_SALT}${chars}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);
}

function billingHeader(messages: ApiMessage[]): string {
  const hash = versionHash(messages);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${hash}; cc_entrypoint=cli; cch=00000;`;
}

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

const MODEL_IDS: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-opus-4-6": "claude-opus-4-6",
};

const NON_RETRYABLE_STREAM_ERRORS = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
]);

class RetryableStreamError extends Error {
  constructor(message: string) { super(message); this.name = "RetryableStreamError"; }
}

async function forceRefreshToken(failedToken: string): Promise<string> {
  const auth = loadAuth();
  if (!auth?.tokens?.refreshToken) throw new Error("No refresh token");
  if (auth.tokens.accessToken !== failedToken) return auth.tokens.accessToken;
  const newTokens = await refreshTokens(auth.tokens.refreshToken);
  saveAuth({ ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
  return newTokens.accessToken;
}

function supportsAdaptive(model: ModelId): boolean {
  return model === "sonnet" || model === "opus" || model === "claude-sonnet-4-6" || model === "claude-opus-4-6";
}

function supportsEffort(model: ModelId): boolean {
  return model === "opus" || model === "claude-opus-4-6";
}

function buildRequest(
  accessToken: string, messages: ApiMessage[], model: ModelId,
  maxTokens: number, system?: string, tools?: unknown[],
  effort: EffortLevel = DEFAULT_EFFORT,
) {
  const adaptive = supportsAdaptive(model);
  const thinking = adaptive
    ? { type: "adaptive" }
    : { type: "enabled", budget_tokens: 10000 };

  const body: Record<string, unknown> = {
    model: MODEL_IDS[model] ?? model, messages: injectMessageBreakpoints(messages),
    max_tokens: maxTokens, thinking, stream: true,
    metadata: { user_id: getMetadataUserId() },
  };
  if (supportsEffort(model)) body.output_config = { effort };
  if (tools && tools.length > 0) body.tools = injectToolBreakpoints(tools);
  const systemBlocks: unknown[] = [{ type: "text", text: billingHeader(messages) }];
  if (system) {
    systemBlocks.push({ type: "text", text: system, cache_control: { type: "ephemeral" } });
  }
  body.system = systemBlocks;

  return {
    url: `${ANTHROPIC_BASE_URL}/v1/messages?beta=true`,
    init: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": BETA_FLAGS,
        "Content-Type": "application/json",
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "x-app": "cli",
      },
      body: JSON.stringify(body),
    } satisfies RequestInit,
  };
}

interface BlockState {
  type: "text" | "thinking" | "tool_use";
  text: string;
  id: string;
  name: string;
  inputJson: string;
  signature: string;
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

  if (!stopReason && toolCalls.length > 0) stopReason = "tool_use";

  return { text: fullText, thinking: fullThinking, stopReason, blocks: orderedBlocks, toolCalls, inputTokens, outputTokens };
}

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

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { system, signal, maxTokens = 32000, tools, effort } = options;
  let accessToken = await getVerifiedAccessToken();
  let authRetried = false;
  let retryAttempt = 0;

  while (true) {
    const { url, init } = buildRequest(accessToken, messages, model, maxTokens, system, tools, effort);
    const res = await fetch(url, { ...init, signal });

    if (!authRetried && (res.status === 401 || (res.status === 403 && (await res.clone().text()).includes("revoked")))) {
      log("warn", `api: ${res.status}, refreshing token`);
      accessToken = await forceRefreshToken(accessToken);
      authRetried = true;
      continue;
    }

    if (res.status === 429 || res.status === 529 || res.status === 503) {
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, `HTTP ${res.status}`, callbacks);
        continue;
      }
      const text = await res.text();
      throw new RetryableStreamError(`API error (${res.status}) after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      log("error", `api: error (${res.status}): ${text.slice(0, 500)}`);
      throw new Error(`API error (${res.status}): ${text}`);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readStream(res, callbacks);
    } catch (err) {
      if (err instanceof RetryableStreamError && retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, (err as Error).message, callbacks);
        continue;
      }
      throw err;
    }
  }
}
