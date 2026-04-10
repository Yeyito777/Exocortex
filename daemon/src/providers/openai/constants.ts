const CHATGPT_BASE_URL = (process.env.OPENAI_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com").replace(/\/+$/, "");
const OPENAI_AUTH_ISSUER = "https://auth.openai.com";

export const OPENAI_AUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTH_URL = `${OPENAI_AUTH_ISSUER}/oauth/authorize`;
export const OPENAI_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/oauth/token`;
export const OPENAI_USERINFO_URL = `${OPENAI_AUTH_ISSUER}/userinfo`;

export const OPENAI_CALLBACK_PORT = 1455;
export const OPENAI_CALLBACK_PATH = "/auth/callback";

export const OPENAI_ORIGINATOR = "codex_cli_rs";
export const OPENAI_CODEX_CLIENT_VERSION = process.env.OPENAI_CODEX_CLIENT_VERSION?.trim() || "0.99.0";
export const OPENAI_ACCOUNTS_URL = `${CHATGPT_BASE_URL}/backend-api/accounts`;
export const OPENAI_ACCOUNT_CHECK_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/check/v4-2023-04-27`;
export const OPENAI_MODELS_URL = `${CHATGPT_BASE_URL}/backend-api/codex/models`;
export const OPENAI_CODEX_RESPONSES_URL = `${CHATGPT_BASE_URL}/backend-api/codex/responses`;
