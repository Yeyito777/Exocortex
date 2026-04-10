import { createHash, randomBytes, randomUUID } from "crypto";
import { loadProviderAuth, type StoredAuth } from "../../store";
import { ANTHROPIC_BASE_URL } from "./constants";
import { injectToolBreakpoints, injectMessageBreakpoints } from "./cache";
import { DEFAULT_EFFORT, type ModelId, type EffortLevel, type ApiMessage, type ApiContentBlock } from "../../messages";

const API_VERSION = "2023-06-01";
const CLAUDE_CODE_VERSION = "2.1.81";
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
const BETA_FLAGS = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,effort-2025-11-24";
const BILLING_SALT = "59cf53e54c78";
const ANTHROPIC_PROVIDER_ID = "anthropic";

let userId: string | null = null;
const sessionId = randomUUID();

const MODEL_IDS: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-opus-4-6": "claude-opus-4-6",
};

function versionHash(messages: ApiMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  let text = "";
  if (firstUser) {
    const content = firstUser.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: ApiContentBlock) => b.type === "text");
      if (tb && "text" in tb) text = tb.text;
    }
  }
  const chars = [4, 7, 20].map((i) => text[i] || "0").join("");
  return createHash("sha256").update(`${BILLING_SALT}${chars}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);
}

function billingHeader(messages: ApiMessage[]): string {
  const hash = versionHash(messages);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${hash}; cc_entrypoint=cli; cch=00000;`;
}

function getMetadataUserId(): string {
  if (userId) return userId;
  const auth = loadProviderAuth<StoredAuth>(ANTHROPIC_PROVIDER_ID);
  const accountUuid = auth?.profile?.accountUuid ?? "";
  const userHash = randomBytes(32).toString("hex");
  userId = `user_${userHash}_account_${accountUuid}_session_${sessionId}`;
  return userId;
}

function supportsAdaptive(model: ModelId): boolean {
  return model === "sonnet" || model === "opus" || model === "claude-sonnet-4-6" || model === "claude-opus-4-6";
}

function supportsEffort(model: ModelId): boolean {
  return model === "opus" || model === "claude-opus-4-6";
}

function sanitizeAssistantContentForAnthropic(content: ApiContentBlock[]): ApiContentBlock[] {
  return content.filter((block) => block.type !== "thinking" || Boolean(block.signature.trim()));
}

export function sanitizeMessagesForAnthropic(messages: ApiMessage[]): ApiMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") return [message];

    const content = sanitizeAssistantContentForAnthropic(message.content);
    if (content.length === 0) return [];
    return [{ ...message, content }];
  });
}

export function buildAnthropicRequest(
  accessToken: string,
  messages: ApiMessage[],
  model: ModelId,
  maxTokens: number,
  system?: string,
  tools?: unknown[],
  effort: EffortLevel = DEFAULT_EFFORT,
): { url: string; init: RequestInit } {
  const adaptive = supportsAdaptive(model);
  const thinking = adaptive
    ? { type: "adaptive" }
    : { type: "enabled", budget_tokens: 10000 };
  const sanitizedMessages = sanitizeMessagesForAnthropic(messages);

  const body: Record<string, unknown> = {
    model: MODEL_IDS[model] ?? model,
    messages: injectMessageBreakpoints(sanitizedMessages),
    max_tokens: maxTokens,
    thinking,
    stream: true,
    metadata: { user_id: getMetadataUserId() },
  };
  if (supportsEffort(model)) body.output_config = { effort };
  if (tools && tools.length > 0) body.tools = injectToolBreakpoints(tools);
  const systemBlocks: unknown[] = [{ type: "text", text: billingHeader(messages) }];
  if (system) {
    systemBlocks.push({ type: "text", text: system, cache_control: { type: "ephemeral" } });
  }
  body.system = systemBlocks;

  return {
    url: `${ANTHROPIC_BASE_URL}/v1/messages?beta=true`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": BETA_FLAGS,
        "Content-Type": "application/json",
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "x-app": "cli",
      },
      body: JSON.stringify(body),
    } satisfies RequestInit,
  };
}
