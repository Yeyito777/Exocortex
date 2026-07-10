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
