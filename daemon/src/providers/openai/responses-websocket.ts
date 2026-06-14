import type { StreamCallbacks, StreamResult } from "../types";
import { log } from "../../log";
import { createOpenAIEventAccumulator } from "./stream";
import { OpenAIWebSocketHttpError, type OpenAIWebSocketConnection } from "./websocket";

export interface ReadOpenAIResponsesWebSocketOptions {
  stallTimeoutMs: number;
  connectionReused?: boolean;
  signal?: AbortSignal;
  onTurnState?: (turnState: string) => void;
}

export class OpenAIWebSocketClosedBeforeResponseStartedError extends Error {
  readonly code?: number;
  readonly reason?: string;
  readonly connectionReused: boolean;

  constructor(args: { code?: number; reason?: string; connectionReused?: boolean; cause?: unknown } = {}) {
    super(args.reason || "OpenAI websocket closed before response started");
    this.name = "OpenAIWebSocketClosedBeforeResponseStartedError";
    this.code = args.code;
    this.reason = args.reason;
    this.connectionReused = args.connectionReused === true;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headersFromJson(value: unknown): Headers {
  const headers = new Headers();
  if (!isRecord(value)) return headers;
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      headers.append(name, String(raw));
    }
  }
  return headers;
}

/**
 * ChatGPT's websocket backend can send an in-band status wrapper instead of an
 * HTTP handshake failure. Convert it to the same status-bearing error shape so
 * auth, usage-limit, and transient retry handling stay in one place.
 */
function parseWrappedWebSocketError(text: string): OpenAIWebSocketHttpError | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(data) || data.type !== "error") return null;
  const status = typeof data.status === "number"
    ? data.status
    : typeof data.status_code === "number"
      ? data.status_code
      : null;
  if (status == null || (status >= 200 && status < 300)) return null;
  return new OpenAIWebSocketHttpError(status, headersFromJson(data.headers), text);
}

/**
 * The websocket protocol reports Codex rate limits as JSON events rather than
 * HTTP headers. Rehydrate the header names consumed by the existing usage parser.
 */
function maybeHeadersFromCodexRateLimits(event: Record<string, unknown>): Headers | null {
  if (event.type !== "codex.rate_limits" || !isRecord(event.rate_limits)) return null;
  const rateLimits = event.rate_limits;
  const headers = new Headers();
  const primary = isRecord(rateLimits.primary) ? rateLimits.primary : null;
  const secondary = isRecord(rateLimits.secondary) ? rateLimits.secondary : null;

  if (primary) {
    if (typeof primary.used_percent === "number") headers.set("x-codex-primary-used-percent", String(primary.used_percent));
    if (typeof primary.reset_at === "number") headers.set("x-codex-primary-reset-at", String(primary.reset_at));
  }
  if (secondary) {
    if (typeof secondary.used_percent === "number") headers.set("x-codex-secondary-used-percent", String(secondary.used_percent));
    if (typeof secondary.reset_at === "number") headers.set("x-codex-secondary-reset-at", String(secondary.reset_at));
  }

  return Array.from(headers.keys()).length > 0 ? headers : null;
}

function headerValueFromRecord(headers: Record<string, unknown>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function maybeTurnStateFromMetadata(event: Record<string, unknown>): string | null {
  if (event.type !== "response.metadata" || !isRecord(event.headers)) return null;
  return headerValueFromRecord(event.headers, "x-codex-turn-state");
}

export async function readOpenAIResponsesWebSocket(
  socket: OpenAIWebSocketConnection,
  requestBody: Record<string, unknown>,
  callbacks: StreamCallbacks,
  options: ReadOpenAIResponsesWebSocketOptions,
): Promise<StreamResult> {
  const requestText = JSON.stringify({ type: "response.create", ...requestBody });
  try {
    await socket.sendText(requestText, options.signal, options.stallTimeoutMs);
  } catch (err) {
    if (isWebSocketClosedTransportError(err)) {
      throw new OpenAIWebSocketClosedBeforeResponseStartedError({ connectionReused: options.connectionReused, cause: err });
    }
    throw err;
  }

  const accumulator = createOpenAIEventAccumulator(callbacks);
  let responseStarted = false;
  while (true) {
    const message = await socket.nextMessage(options.stallTimeoutMs, options.signal);
    if (message.type === "close") {
      if (!responseStarted) {
        throw new OpenAIWebSocketClosedBeforeResponseStartedError({
          code: message.code,
          reason: message.reason,
          connectionReused: options.connectionReused,
        });
      }
      log("warn", `openai api: websocket closed before completion (code=${message.code ?? "?"}, reason=${message.reason || ""})`);
      throw new Error(message.reason || "OpenAI websocket closed before response.completed");
    }
    if (message.type === "binary") {
      throw new Error("OpenAI websocket returned an unexpected binary event");
    }

    const wrappedError = parseWrappedWebSocketError(message.text);
    if (wrappedError) {
      callbacks.onHeaders?.(wrappedError.headers);
      throw wrappedError;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(message.text) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof event.type === "string" && event.type.startsWith("response.")) {
      responseStarted = true;
    }

    const rateLimitHeaders = maybeHeadersFromCodexRateLimits(event);
    if (rateLimitHeaders) callbacks.onHeaders?.(rateLimitHeaders);
    const turnState = maybeTurnStateFromMetadata(event);
    if (turnState) options.onTurnState?.(turnState);

    accumulator.handle(event);
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      return accumulator.finalize();
    }
  }
}

function isWebSocketClosedTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("websocket is closed")
    || msg.includes("socket is closed")
    || msg.includes("socket has been ended")
    || msg.includes("connection closed")
    || msg.includes("econnreset")
    || msg.includes("epipe");
}
