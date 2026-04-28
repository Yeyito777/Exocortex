import type { StoredAuth } from "../../store";

export interface StoredDeepSeekAuth extends StoredAuth {
  source: "api_key" | "env";
  /** Redacted key label for status/debug surfaces. The full key is stored in tokens.accessToken. */
  apiKeyLabel: string;
}

export interface DeepSeekModelsResponse {
  object?: "list";
  data?: Array<{
    id?: string;
    object?: string;
    owned_by?: string;
  }>;
}

export interface DeepSeekErrorResponse {
  error?: {
    message?: string;
    type?: string;
    param?: string | null;
    code?: string | null;
  };
}
