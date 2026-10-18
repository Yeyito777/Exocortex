export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Provider returned a terminal request/content error. Retrying the same payload
 * will only repeat the failure, so transport retry loops must hard-fail it.
 */
export class NonRetryableProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableProviderError";
  }
}

/**
 * Context overflow is terminal for an ordinary model turn, but OpenAI's native
 * compaction operation deliberately retries it through the normal transient
 * error loop before falling back to plaintext compaction.
 */
export class ContextWindowProviderError extends NonRetryableProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ContextWindowProviderError";
  }
}

export function isContextWindowProviderError(err: unknown): err is ContextWindowProviderError {
  return err instanceof ContextWindowProviderError
    || (err instanceof Error && err.name === "ContextWindowProviderError");
}

export function isNonRetryableProviderError(err: unknown): err is NonRetryableProviderError {
  return err instanceof NonRetryableProviderError
    || (err instanceof Error && (
      err.name === "NonRetryableProviderError"
      || err.name === "ContextWindowProviderError"
    ));
}

/**
 * How a failed provider request relates to the network.
 *
 * - "network": the request never reached the provider (DNS failure, connection
 *   refused, no route). Worth waiting for connectivity to return.
 * - "maybe_network": the connection broke or timed out. An outage if the
 *   connectivity probe also fails; otherwise an ordinary provider error.
 * - null: the provider answered (HTTP status, rate limit, auth, bad request) or
 *   the failure is not about the network at all.
 */
export type NetworkFailureKind = "network" | "maybe_network";

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME", "ENOTFOUND",
  "ECONNREFUSED", "ConnectionRefused", "FailedToOpenSocket",
  "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const MAYBE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT",
  "ConnectionClosed", "ERR_SOCKET_CLOSED", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT",
]);
const NETWORK_MESSAGE_PATTERNS = [
  // Error codes quoted in messages (Claude Code: "... (EAI_AGAIN)", Node: "getaddrinfo ENOTFOUND host").
  /\b(?:EAI_AGAIN|EAI_FAIL|EAI_NODATA|EAI_NONAME|ENOTFOUND|ECONNREFUSED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|EADDRNOTAVAIL|FailedToOpenSocket|ConnectionRefused|UND_ERR_CONNECT_TIMEOUT)\b/,
  /\bgetaddrinfo\b/i,
  // Claude Code's connection-error wording.
  /can't reach the api server/i,
  /no internet route/i,
  /unable to connect to api\b/i,
  // fetch (undici/Bun) and generic socket wording.
  /\bfetch failed\b/i,
  /unable to connect\. is the computer able to access the url/i,
  /\bnetwork is (?:unreachable|down)\b/i,
  /websocket connection to .* failed: failed to connect/i,
];
const MAYBE_NETWORK_MESSAGE_PATTERNS = [
  /\b(?:ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|ESOCKETTIMEDOUT|ConnectionClosed|UND_ERR_SOCKET)\b/,
  /\bsocket hang up\b/i,
  /\bconnection dropped\b/i,
  /\brequest timed out\b/i,
  /\bconnection (?:was )?(?:reset|closed unexpectedly)\b/i,
  /\bwebsocket (?:connect|handshake) timeout\b/i,
];
/** The provider answered, or the failure is local configuration: never an outage. */
const NOT_NETWORK_MESSAGE_PATTERNS = [
  /\bAPI error \(\d{3}\)/i,
  /\bHTTP [45]\d\d\b/,
  /\b(?:rate.?limit|overloaded|quota|usage limit|unauthori[sz]ed|forbidden|authentication)\b/i,
  /\b(?:certificate|SSL|TLS)\b/i,
  /Exocortex \/proxy/,
  /couldn't connect through your proxy|\bERR_PROXY/i,
];

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Classify a message from a provider's own retry report or error text. */
export function classifyNetworkFailureMessage(message: string): NetworkFailureKind | null {
  if (!message) return null;
  if (NOT_NETWORK_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) return null;
  if (NETWORK_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) return "network";
  if (MAYBE_NETWORK_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) return "maybe_network";
  return null;
}

/** Classify a failed provider request; walks `cause` chains and AggregateErrors. */
export function classifyNetworkFailure(error: unknown): NetworkFailureKind | null {
  let maybe = false;
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && seen.size < 16) {
    const current = pending.shift();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof AuthError || isNonRetryableProviderError(current)) return null;
    if (current instanceof Error && (current.name === "AbortError" || current.name === "StreamPreemptedError")) return null;
    // /proxy link failures are waited out by proxy-link-wait.ts, not as network outages.
    if (current instanceof Error && current.name === "ProviderProxyUnavailableError") return null;
    // An HTTP response means the provider was reached.
    const status = typeof current === "object" ? (current as { status?: unknown }).status : undefined;
    if (typeof status === "number" && status >= 100) return null;
    const code = errorCode(current);
    if (code && NETWORK_ERROR_CODES.has(code)) return "network";
    if (code && MAYBE_NETWORK_ERROR_CODES.has(code)) maybe = true;
    const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    const byMessage = classifyNetworkFailureMessage(message);
    if (byMessage === "network") return "network";
    if (byMessage === "maybe_network") maybe = true;
    else if (message && NOT_NETWORK_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) return null;
    if (typeof current === "object") {
      pending.push((current as { cause?: unknown }).cause);
      if (current instanceof AggregateError) pending.push(...current.errors);
    }
  }
  return maybe ? "maybe_network" : null;
}
