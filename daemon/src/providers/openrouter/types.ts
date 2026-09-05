import type { StoredAuth } from "../../store";

export interface StoredOpenRouterAuth extends StoredAuth {
  source: "api_key" | "env";
  /** Redacted key label for status/debug surfaces. The full key is stored in tokens.accessToken. */
  apiKeyLabel: string;
}

export interface OpenRouterErrorResponse {
  error?: {
    message?: string;
    type?: string;
    param?: string | null;
    code?: string | number | null;
  };
}
