const CHATGPT_BASE_URL = (process.env.OPENAI_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com").replace(/\/+$/, "");

export const OPENAI_AUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTH_URL = "https://auth.openai.com/authorize";
export const OPENAI_TOKEN_URL = "https://auth0.openai.com/oauth/token";
export const OPENAI_USERINFO_URL = "https://auth0.openai.com/userinfo";

export const OPENAI_CALLBACK_PORT = 1455;
export const OPENAI_CALLBACK_PATH = "/auth/callback";

export const OPENAI_ORIGINATOR = "codex_cli_rs";
export const OPENAI_CODEX_CLIENT_VERSION = process.env.OPENAI_CODEX_CLIENT_VERSION?.trim() || "0.99.0";
export const OPENAI_MODELS_URL = `${CHATGPT_BASE_URL}/backend-api/codex/models`;
export const OPENAI_CODEX_RESPONSES_URL = `${CHATGPT_BASE_URL}/backend-api/codex/responses`;
