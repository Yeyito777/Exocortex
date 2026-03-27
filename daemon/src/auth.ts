import type { ProviderId } from "./messages";
import {
  AuthError,
  ensureAuthenticated as ensureAnthropicAuthenticated,
  login as anthropicLogin,
  refreshTokens as refreshAnthropicTokens,
  verifyAuth as verifyAnthropicAuth,
  clearAuth as clearAnthropicAuth,
  hasConfiguredCredentials as hasAnthropicCredentials,
} from "./providers/anthropic/auth";
import {
  ensureAuthenticated as ensureOpenAIAuthenticated,
  login as openaiLogin,
  verifyAuth as verifyOpenAIAuth,
  logout as clearOpenAIAuth,
  hasConfiguredCredentials as hasOpenAICredentials,
} from "./providers/openai/auth";

export { AuthError };
export interface LoginResult {
  tokens: { accessToken: string };
  profile: { email: string | null } | null;
}

export interface LoginCallbacks {
  onProgress?: (msg: string) => void;
  onOpenUrl?: (url: string) => void;
}

export interface EnsureAuthResult {
  status: "already_authenticated" | "refreshed" | "logged_in";
  email: string | null;
}

export function login(provider: ProviderId, callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  switch (provider) {
    case "anthropic":
      return anthropicLogin(callbacks);
    case "openai":
      return openaiLogin(callbacks);
    default:
      throw new Error(`Login is not implemented for provider: ${provider}`);
  }
}

export function ensureAuthenticated(provider: ProviderId, callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  switch (provider) {
    case "anthropic":
      return ensureAnthropicAuthenticated(callbacks);
    case "openai":
      return ensureOpenAIAuthenticated(callbacks);
    default:
      throw new Error(`Authentication is not implemented for provider: ${provider}`);
  }
}

export function refreshTokens(provider: ProviderId, refreshToken: string) {
  switch (provider) {
    case "anthropic":
      return refreshAnthropicTokens(refreshToken);
    case "openai":
      throw new Error(`Token refresh is not supported for provider: ${provider}`);
    default:
      throw new Error(`Token refresh is not implemented for provider: ${provider}`);
  }
}

export function verifyAuth(provider: ProviderId, accessToken: string): Promise<boolean> {
  switch (provider) {
    case "anthropic":
      return verifyAnthropicAuth(accessToken);
    case "openai":
      return verifyOpenAIAuth(accessToken);
    default:
      throw new Error(`Auth verification is not implemented for provider: ${provider}`);
  }
}

export function clearAuth(provider: ProviderId): boolean {
  switch (provider) {
    case "anthropic":
      return clearAnthropicAuth();
    case "openai":
      return clearOpenAIAuth();
    default:
      return false;
  }
}

export function hasConfiguredCredentials(provider: ProviderId): boolean {
  switch (provider) {
    case "anthropic":
      return hasAnthropicCredentials();
    case "openai":
      return hasOpenAICredentials();
    default:
      return false;
  }
}
