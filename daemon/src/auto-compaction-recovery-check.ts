import type { streamMessage } from "./api";
import { invalidateCredentialsCache } from "./auth";
import { appendMessages, create, get, isStreaming, remove } from "./conversations";
import { createStoredUserMessage } from "./messages";
import { orchestrateSendMessage } from "./orchestrator";
import { getMaxContext } from "./providers/registry";

const convId = `auto-compact-recovery-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let compactionCalls = 0;
let conversationCalls = 0;
const subscriberEvents: Array<Record<string, unknown>> = [];

invalidateCredentialsCache("deepseek");
create(convId, "deepseek", "deepseek-v4-pro", "auto compact recovery test");
const conversation = get(convId)!;
appendMessages(convId, [
  createStoredUserMessage("earlier request", conversation.model, 100),
  { role: "assistant", content: "earlier answer", metadata: null },
]);
const limit = getMaxContext("deepseek", "deepseek-v4-pro")!;
// Past the automatic threshold, under the real window.
conversation.lastContextTokens = Math.floor(limit * 0.95);

const providerStream = (async (_provider, _messages, _model, _callbacks, options) => {
  if (options?.tracking?.source === "context_compaction") {
    compactionCalls += 1;
    return { text: "partial", thinking: "", stopReason: "max_tokens" as const, blocks: [], toolCalls: [] };
  }
  conversationCalls += 1;
  return {
    text: "answered anyway",
    thinking: "",
    stopReason: "stop" as const,
    blocks: [{ type: "text" as const, text: "answered anyway" }],
    toolCalls: [],
    inputTokens: 200,
    outputTokens: 10,
  };
}) as typeof streamMessage;

const server = {
  sendTo() {},
  broadcast() {},
  sendToSubscribers(_id: string, event: Record<string, unknown>) {
    subscriberEvents.push(event);
  },
  sendToSubscribersExcept() {},
  sendHistoryUpdatedToSubscribers() {},
  hasSubscribers() {
    return true;
  },
};

try {
  const outcome = await orchestrateSendMessage(
    server as never,
    {} as never,
    "req-send",
    convId,
    "new request",
    400,
    { onHeaders: () => {}, onComplete: () => {}, streamMessageFn: providerStream },
  );
  console.log(JSON.stringify({
    outcome: { ok: outcome.ok, error: outcome.error ?? null },
    compactionCalls,
    conversationCalls,
    warnings: subscriberEvents
      .filter((event) => event.type === "system_message" && event.color === "warning")
      .map((event) => event.text),
    transcriptWarning: conversation.messages.some((message) =>
      message.role === "system" && String(message.content).includes("Automatic context compaction failed")),
    lastUser: conversation.messages.filter((message) => message.role === "user").at(-1)?.content ?? null,
    lastAssistant: conversation.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? null,
    activeContext: conversation.activeContext ?? null,
    streaming: isStreaming(convId),
  }));
} finally {
  remove(convId);
  invalidateCredentialsCache("deepseek");
}
