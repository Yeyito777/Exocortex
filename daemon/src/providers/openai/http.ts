import { arch, platform, release } from "node:os";
import { OPENAI_CODEX_CLIENT_VERSION, OPENAI_ORIGINATOR } from "./constants";

const OPENAI_USER_AGENT =
  `${OPENAI_ORIGINATOR}/${OPENAI_CODEX_CLIENT_VERSION} (${platform()} ${release()}; ${arch()}) exocortexd/openai`;

export function buildOpenAIHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    originator: OPENAI_ORIGINATOR,
    "User-Agent": OPENAI_USER_AGENT,
    ...overrides,
  };
}

export function buildOpenAIJsonHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return buildOpenAIHeaders({
    Accept: "application/json",
    ...overrides,
  });
}

export function parseOpenAIJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${context} returned non-JSON response: ${text.slice(0, 500)}`);
  }
}
