import type { streamMessage } from "./api";
import { invalidateCredentialsCache } from "./auth";
import { create, get, isStreaming, remove } from "./conversations";
import { CONTEXT_COMPACTION_FINISHED_KIND, createStoredUserMessage } from "./messages";
import { orchestrateCompactConversation } from "./orchestrator";

const convId = `manual-compact-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let providerCalls = 0;
let providerTrackingSource: string | null = null;
const subscriberEvents: Array<Record<string, unknown>> = [];
let historyUpdates = 0;
let onCompleteCalls = 0;

invalidateCredentialsCache("deepseek");
create(convId, "deepseek", "deepseek-v4-pro", "compact test");
const conversation = get(convId)!;
conversation.messages.push(
  createStoredUserMessage("keep this request", conversation.model, 100),
  { role: "assistant", content: "keep this answer", metadata: null },
);
conversation.lastContextTokens = 50_000;

const providerStream = (async (_provider, _messages, _model, _callbacks, options) => {
  providerCalls += 1;
  providerTrackingSource = options?.tracking?.source ?? null;
  return {
    text: "Goal, decisions, completed work, and next steps.",
    thinking: "",
    stopReason: "stop" as const,
    blocks: [{ type: "text" as const, text: "Goal, decisions, completed work, and next steps." }],
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
  sendHistoryUpdatedToSubscribers() {
    historyUpdates += 1;
  },
  hasSubscribers() {
    return true;
  },
};

try {
  const outcome = await orchestrateCompactConversation(
    server as never,
    {} as never,
    "req-compact",
    convId,
    400,
    {
      onHeaders: () => {},
      onComplete: () => { onCompleteCalls += 1; },
      streamMessageFn: providerStream,
    },
  );
  const active = conversation.activeContext;
  const hasCheckpoint = active?.messages.some((message) =>
    message.metadata?.system === true && message.metadata.kind === "context_checkpoint"
  ) ?? false;

  console.log(JSON.stringify({
    outcome: { ok: outcome.ok, blocks: outcome.blocks, tokens: outcome.tokens },
    providerCalls,
    providerTrackingSource,
    visibleAssistantMessages: conversation.messages.filter((message) => message.role === "assistant").length,
    completionMarker: conversation.messages.at(-1)?.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND,
    activeContext: {
      kind: active?.kind,
      provider: active?.provider,
      compactionCount: active?.compactionCount,
      transcriptHistoryCount: active?.transcriptHistoryCount,
      hasCheckpoint,
    },
    lastContextTokens: conversation.lastContextTokens,
    streaming: isStreaming(convId),
    eventTypes: subscriberEvents.map((event) => event.type),
    completedStatus: subscriberEvents.some((event) =>
      event.type === "context_compaction_status"
      && event.active === false
      && typeof event.completedAt === "number"
    ),
    historyUpdates,
    onCompleteCalls,
  }));
} finally {
  remove(convId);
  invalidateCredentialsCache("deepseek");
}
