import type { DeviceCodeAuthPrompt } from "@exocortex/shared/protocol";
import type { LoginCallbacks } from "../types";
import { buildOpenAIJsonHeaders, parseOpenAIJson } from "./http";
import {
  OPENAI_AUTH_CLIENT_ID,
  OPENAI_DEVICE_AUTH_CALLBACK_URL,
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USER_CODE_URL,
  OPENAI_DEVICE_AUTH_VERIFICATION_URL,
} from "./constants";
import { exchangeOpenAIAuthorizationCode } from "./oauth";
import type { OpenAITokenResponse } from "./session";

const DEVICE_AUTH_EXPIRES_IN_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

interface DeviceUserCodeResponse {
  device_auth_id: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface DeviceAuthorizationResponse {
  authorization_code: string;
  code_verifier: string;
  code_challenge: string;
}

interface PendingDeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

function responseError(context: string, status: number, body: string): Error {
  const detail = body.trim().slice(0, 500);
  return new Error(`${context} failed with status ${status}${detail ? `: ${detail}` : ""}`);
}

function parsePollInterval(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_POLL_INTERVAL_SECONDS;
}

async function requestDeviceCode(): Promise<PendingDeviceAuthorization> {
  const response = await fetch(OPENAI_DEVICE_AUTH_USER_CODE_URL, {
    method: "POST",
    headers: buildOpenAIJsonHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ client_id: OPENAI_AUTH_CLIENT_ID }),
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("OpenAI code login is not available. Use the browser login flow instead.");
    }
    throw responseError("OpenAI device-code request", response.status, text);
  }

  const parsed = parseOpenAIJson<DeviceUserCodeResponse>(text, "OpenAI device-code request");
  const deviceAuthId = parsed.device_auth_id?.trim();
  const userCode = (parsed.user_code ?? parsed.usercode)?.trim();
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device-code request returned an incomplete response");
  }
  return {
    deviceAuthId,
    userCode,
    intervalSeconds: parsePollInterval(parsed.interval),
  };
}

async function pollForAuthorization(pending: PendingDeviceAuthorization): Promise<DeviceAuthorizationResponse> {
  const deadline = Date.now() + DEVICE_AUTH_EXPIRES_IN_SECONDS * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(OPENAI_DEVICE_AUTH_TOKEN_URL, {
      method: "POST",
      headers: buildOpenAIJsonHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        device_auth_id: pending.deviceAuthId,
        user_code: pending.userCode,
      }),
    });
    const text = await response.text();
    if (response.ok) {
      const parsed = parseOpenAIJson<DeviceAuthorizationResponse>(text, "OpenAI device authorization");
      if (!parsed.authorization_code?.trim() || !parsed.code_verifier?.trim() || !parsed.code_challenge?.trim()) {
        throw new Error("OpenAI device authorization returned an incomplete response");
      }
      return parsed;
    }

    // OpenAI uses 403/404 while the user has not completed the browser step.
    if (response.status !== 403 && response.status !== 404) {
      throw responseError("OpenAI device authorization", response.status, text);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await Bun.sleep(Math.min(pending.intervalSeconds * 1000, remainingMs));
  }
  throw new Error("OpenAI device authorization timed out after 15 minutes");
}

function formatDeviceCodePrompt(prompt: DeviceCodeAuthPrompt): string {
  return [
    "OpenAI code authorization:",
    `1. Open ${prompt.verificationUrl} in any browser and sign in.`,
    `2. Enter this one-time code: ${prompt.userCode}`,
    "The code expires in 15 minutes. Continue only if you started this login in Exocortex.",
  ].join("\n");
}

export async function runOpenAIDeviceOAuth(callbacks: LoginCallbacks = {}): Promise<OpenAITokenResponse> {
  callbacks.onProgress?.("Requesting an OpenAI one-time code...");
  const pending = await requestDeviceCode();
  const prompt: DeviceCodeAuthPrompt = {
    verificationUrl: OPENAI_DEVICE_AUTH_VERIFICATION_URL,
    userCode: pending.userCode,
    expiresInSeconds: DEVICE_AUTH_EXPIRES_IN_SECONDS,
  };
  if (callbacks.onDeviceCode) await callbacks.onDeviceCode(prompt);
  else callbacks.onProgress?.(formatDeviceCodePrompt(prompt));

  callbacks.onProgress?.("Waiting for code authorization...");
  const authorization = await pollForAuthorization(pending);
  callbacks.onProgress?.("Code accepted. Exchanging OpenAI credentials...");
  return exchangeOpenAIAuthorizationCode(
    authorization.authorization_code,
    authorization.code_verifier,
    OPENAI_DEVICE_AUTH_CALLBACK_URL,
  );
}
