// Subprocess check for claude-code-compaction.test.ts (see manual-compaction-check.ts).
import type { streamMessage } from "./api";
import { appendMessages, create, get, remove } from "./conversations";
import { createStoredUserMessage, type StoredMessage } from "./messages";
import { orchestrateSendMessage } from "./orchestrator";
import { ensureConversationWorkspace } from "./workspace-service";

const scenario = process.argv[2] as "resumed" | "fresh";
const convId = `claude-code-compaction-check-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let compactionCalls = 0;
let conversationCalls = 0;
let sentMessages = 0;
const subscriberEvents: Array<Record<string, unknown>> = [];

create(convId, "anthropic", "claude-opus-5-5", "claude code compaction test");
const conversation = get(convId)!;
const cwd = ensureConversationWorkspace(convId);
// About 1M estimated tokens of history: past Exocortex's 90% trigger.
const bulk = "x".repeat(4_000_000);
const history: StoredMessage[] = [
  createStoredUserMessage(`earlier request ${bulk}`, conversation.model, 100),
  {
    role: "assistant",
    content: "earlier answer",
    metadata: null,
    ...(scenario === "resumed" ? { providerData: { anthropic: { sessionId: "session-1", resumeAt: "entry-1", cwd } } } : {}),
  },
];
appendMessages(convId, history);
// Claude Code's real usage: over 90% of the window, under its own 967k trigger.
conversation.lastContextTokens = 950_000;

const providerStream = (async (_provider, messages, _model, callbacks, options) => {
  if (options?.tracking?.source === "context_compaction") {
    compactionCalls += 1;
    return { text: "checkpoint summary", thinking: "", stopReason: "stop" as const, blocks: [], toolCalls: [] };
  }
  conversationCalls += 1;
  sentMessages = messages.length;
  callbacks.onProviderCompaction?.({ trigger: "auto", preTokens: 968_000, postTokens: 41_000 });
  return {
    text: "answered",
    thinking: "",
    stopReason: "stop" as const,
    blocks: [{ type: "text" as const, text: "answered" }],
    toolCalls: [],
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
    sentMessages,
    activeContextKind: conversation.activeContext?.kind ?? null,
    notices: subscriberEvents.filter((event) => event.type === "system_message").map((event) => event.text),
    transcriptNotices: conversation.messages.filter((message) => message.role === "system").map((message) => message.content),
    contextUpdates: subscriberEvents.filter((event) => event.type === "context_update").map((event) => event.contextTokens),
    lastAssistant: conversation.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? null,
  }));
} finally {
  remove(convId);
}
