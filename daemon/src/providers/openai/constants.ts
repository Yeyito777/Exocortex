const CHATGPT_BASE_URL = (process.env.OPENAI_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com").replace(/\/+$/, "");
export const OPENAI_AUTH_ISSUER = "https://auth.openai.com";

export const OPENAI_AUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTH_URL = `${OPENAI_AUTH_ISSUER}/oauth/authorize`;
export const OPENAI_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/oauth/token`;
export const OPENAI_USERINFO_URL = `${OPENAI_AUTH_ISSUER}/userinfo`;

export const OPENAI_CALLBACK_PORT = 1455;
export const OPENAI_CALLBACK_PATH = "/auth/callback";
export const OPENAI_DEVICE_AUTH_USER_CODE_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const OPENAI_DEVICE_AUTH_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`;
export const OPENAI_DEVICE_AUTH_VERIFICATION_URL = `${OPENAI_AUTH_ISSUER}/codex/device`;
export const OPENAI_DEVICE_AUTH_CALLBACK_URL = `${OPENAI_AUTH_ISSUER}/deviceauth/callback`;

export const OPENAI_ORIGINATOR = "codex_cli_rs";
export const OPENAI_CODEX_CLIENT_VERSION = process.env.OPENAI_CODEX_CLIENT_VERSION?.trim() || "0.99.0";
export const OPENAI_RESPONSES_WEBSOCKETS_BETA = "responses_websockets=2026-02-06";
export const OPENAI_ACCOUNTS_URL = `${CHATGPT_BASE_URL}/backend-api/accounts`;
export const OPENAI_ACCOUNT_CHECK_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/check/v4-2023-04-27`;
export const OPENAI_MODELS_URL = `${CHATGPT_BASE_URL}/backend-api/codex/models`;
export const OPENAI_CODEX_RESPONSES_URL = `${CHATGPT_BASE_URL}/backend-api/codex/responses`;
export const OPENAI_CODEX_RESPONSES_WS_URL = toWebSocketUrl(OPENAI_CODEX_RESPONSES_URL);
export const OPENAI_USAGE_URL = `${CHATGPT_BASE_URL}/backend-api/wham/usage`;
export const OPENAI_USAGE_RESET_CREDITS_URL = `${CHATGPT_BASE_URL}/backend-api/wham/rate-limit-reset-credits`;
export const OPENAI_USAGE_RESET_CONSUME_URL = `${OPENAI_USAGE_RESET_CREDITS_URL}/consume`;
export const OPENAI_TRANSCRIBE_URL = `${CHATGPT_BASE_URL}/backend-api/transcribe`;

function toWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}
