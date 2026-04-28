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

export function isNonRetryableProviderError(err: unknown): err is NonRetryableProviderError {
  return err instanceof NonRetryableProviderError
    || (err instanceof Error && err.name === "NonRetryableProviderError");
}
