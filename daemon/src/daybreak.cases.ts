import { afterAll, beforeAll, expect, test } from "bun:test";
import { DAYBREAK_UNAVAILABLE } from "@exocortex/shared/daybreak";
import * as conversations from "./conversations";
import * as jsonPersistence from "./json-persistence";
import { createConversation } from "./messages";
import { getProviderAdapters } from "./providers/catalog";
import { selectOpenAIModelsForTest } from "./providers/openai/models";
import { cyberAccessProgramForSelection, refreshProviders } from "./providers/registry";
import { createHandler } from "./handler";
import { clearActiveJob, setActiveJob } from "./streaming";
import { orchestrateCompactConversation, orchestrateSendMessage } from "./orchestrator";
import { runAgentLoop } from "./agent";
import type { streamMessage } from "./api";

const ids: string[] = [];
const adapters = getProviderAdapters();
const fetchers = adapters.map(adapter => adapter.models.fetch);
let entitled = true;
const id = (_name: string) => { const value = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; ids.push(value); return value; };
const events: Array<Record<string, unknown>> = [];
const server = {
  sendTo: (_client: unknown, event: Record<string, unknown>) => { events.push(event); },
  broadcast: (event: Record<string, unknown>) => { events.push(event); },
  sendToSubscribers: (_id: string, event: Record<string, unknown>) => { events.push(event); },
  sendToSubscribersExcept: () => {},
  sendHistoryUpdatedToSubscribers: () => {},
  subscribe: () => {}, unsubscribe: () => {},
  hasSubscribers: () => false, hasLegacyHistorySubscribers: () => false,
};
const handle = createHandler(server as never);
const answer = {
  text: "OK", thinking: "", stopReason: "stop", blocks: [{ type: "text" as const, text: "OK" }],
  toolCalls: [], inputTokens: 10, outputTokens: 1,
};

beforeAll(async () => {
  for (const adapter of adapters) {
    adapter.models.fetch = async () => adapter.id === "openai"
      ? selectOpenAIModelsForTest([
        { slug: "gpt-6-sol", available_access_programs: { cyber: entitled ? ["standard", "daybreak_blue"] : ["standard"] } },
        { slug: "gpt-6.1-sol", available_access_programs: { cyber: ["standard"] } },
        { slug: "gpt-6-luna", available_access_programs: { cyber: ["standard", "daybreak_blue"] } },
      ])
      : adapter.models.fallbackModels;
  }
  await refreshProviders(true);
});

afterAll(() => {
  adapters.forEach((adapter, i) => { adapter.models.fetch = fetchers[i]; });
  for (const convId of ids) {
    conversations.clearQueuedMessages(convId);
    clearActiveJob(convId);
    conversations.remove(convId);
    jsonPersistence.trashFile(convId);
  }
});

test("exact-model discovery resolves Blue, standard, and no treatment", () => {
  expect(cyberAccessProgramForSelection("openai", "gpt-6-sol", true)).toBe("daybreak_blue");
  expect(cyberAccessProgramForSelection("openai", "gpt-6-sol", false)).toBe("standard");
  expect(cyberAccessProgramForSelection("deepseek", "deepseek-v4-pro")).toBeUndefined();
  expect(() => cyberAccessProgramForSelection("openai", "gpt-6.1-sol", true)).toThrow(DAYBREAK_UNAVAILABLE);
  expect(() => cyberAccessProgramForSelection("openai", "gpt-6-luna", true)).toThrow(DAYBREAK_UNAVAILABLE);
});

test("daemon persists and broadcasts the toggle independently of speed and effort", async () => {
  const convId = id("toggle");
  await handle({} as never, {
    type: "new_conversation", convId, provider: "openai", model: "gpt-6-sol", effort: "max", fastMode: true, daybreak: true,
  });
  expect(conversations.get(convId)).toMatchObject({ model: "gpt-6-sol", effort: "max", fastMode: true, daybreak: true });
  expect(events.at(-1)).toMatchObject({ type: "conversation_updated", summary: { daybreak: true } });
  await handle({} as never, { type: "set_daybreak", convId, enabled: false });
  expect(conversations.getSummary(convId)?.daybreak).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "conversation_updated", summary: expect.objectContaining({ daybreak: false }) }));
  await handle({} as never, { type: "set_daybreak", convId, enabled: true });
  setActiveJob(convId, new AbortController(), Date.now());
  await handle({} as never, { type: "set_daybreak", reqId: "busy", convId, enabled: false });
  expect(events.at(-1)).toMatchObject({ type: "error", reqId: "busy", message: expect.stringContaining("while streaming") });
  expect(conversations.get(convId)?.daybreak).toBe(true);
  clearActiveJob(convId);
  await handle({} as never, { type: "set_model", convId, provider: "openai", model: "gpt-6-luna" });
  expect(conversations.get(convId)).toMatchObject({ model: "gpt-6-luna", fastMode: true, daybreak: false });
  await handle({} as never, { type: "set_daybreak", reqId: "luna", convId, enabled: true });
  expect(events.at(-1)).toMatchObject({ type: "error", reqId: "luna", message: DAYBREAK_UNAVAILABLE });
});

test("invalid enabled values and unsupported creation fail without mutation", async () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-luna", "unknown"]) {
    const convId = id(model);
    await handle({} as never, { type: "new_conversation", convId, provider: "openai", model, daybreak: true });
    expect(conversations.hasConversation(convId)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", message: DAYBREAK_UNAVAILABLE });
  }
  const convId = id("invalid");
  conversations.create(convId, "openai", "gpt-6-sol");
  await handle({} as never, { type: "set_daybreak", convId, enabled: "yes" as never });
  expect(conversations.get(convId)?.daybreak).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "error" });
});

test("queued drafts capture Daybreak atomically instead of inheriting later UI settings", async () => {
  const convId = id("queued");
  const dependency = id("dependency");
  conversations.create(dependency, "openai", "gpt-6-sol");
  setActiveJob(dependency, new AbortController(), Date.now());
  await handle({} as never, {
    type: "queue_message", convId, queueId: "queued-daybreak", text: "queued test",
    timing: "message-end", source: "global-idle", target: "new-conversation",
    provider: "openai", model: "gpt-6-sol", daybreak: true,
    waitTarget: { type: "conversation", convId: dependency, label: "dependency" },
  });
  expect(conversations.get(convId)?.daybreak).toBe(true);
  expect(conversations.getQueuedMessageById("queued-daybreak")).toMatchObject({ daybreak: true, model: "gpt-6-sol" });
  conversations.removeQueuedMessageById("queued-daybreak");
  clearActiveJob(dependency);
});

test("JSON upgrades the old model selection and preserves canonical history", () => {
  const conv = createConversation(id("legacy"), "openai", "gpt-daybreak-blue-latest");
  conv.messages.push({ role: "assistant", content: "old answer", metadata: { model: conv.model, tokens: 1, startedAt: 1, endedAt: 2 } });
  jsonPersistence.save(conv);
  const loaded = jsonPersistence.load(conv.id)!;
  expect(loaded).toMatchObject({ model: "gpt-6-sol", daybreak: true });
  expect(loaded.messages).toEqual(conv.messages);
  jsonPersistence.save(loaded);
  expect(jsonPersistence.load(conv.id)?.daybreak).toBe(true);
});

test("turn admission and native manual compaction use the same explicit program", async () => {
  const convId = id("turn");
  conversations.create(convId, "openai", "gpt-6-sol", "", "low", true, null, false, true);
  const calls: Array<{ model: string; program: unknown; compaction: boolean }> = [];
  const fakeStream: typeof streamMessage = async (_provider, _messages, model, _callbacks, options) => {
    calls.push({ model, program: options?.cyberAccessProgram, compaction: options?.compaction === true });
    return options?.compaction
      ? { ...answer, text: "", blocks: [], compactionItems: [{ encryptedContent: "opaque" }], compactionDoneCount: 1, responseCompleted: true }
      : answer;
  };
  const callbacks = { onHeaders: () => {}, onComplete: () => {}, streamMessageFn: fakeStream };
  const sent = await orchestrateSendMessage(server as never, {} as never, undefined, convId, "hello", Date.now(), callbacks);
  expect(sent.ok, sent.error).toBe(true);
  const compacted = await orchestrateCompactConversation(server as never, {} as never, undefined, convId, Date.now(), callbacks);
  expect(compacted.ok, compacted.error).toBe(true);
  expect(calls).toEqual([
    { model: "gpt-6-sol", program: "daybreak_blue", compaction: false },
    { model: "gpt-6-sol", program: "daybreak_blue", compaction: true },
  ]);
});

test("tool rounds retain the access program", async () => {
  let calls = 0;
  await runAgentLoop([{ role: "user", content: "inspect" }], "openai", "gpt-6-sol", {
    onBlockStart: () => {}, onTextChunk: () => {}, onThinkingChunk: () => {}, onSignature: () => {},
    onToolCall: () => {}, onToolResult: () => {}, onTokensUpdate: () => {}, onContextUpdate: () => {}, onHeaders: () => {},
  }, {
    cyberAccessProgram: "daybreak_blue",
    streamMessageFn: async (_provider, _messages, _model, _callbacks, options) => {
      expect(options?.cyberAccessProgram).toBe("daybreak_blue");
      calls++;
      return calls === 1 ? { ...answer, stopReason: "tool_use", toolCalls: [{ id: "inspect", name: "inspect", input: {} }] } : answer;
    },
    executor: async () => [{ toolCallId: "inspect", toolName: "inspect", output: "safe test", isError: false }],
  });
  expect(calls).toBe(2);
});

test("loss of catalog entitlement fails enabled turns, while off is always recoverable", async () => {
  const convId = id("lost-access");
  conversations.create(convId, "openai", "gpt-6-sol", "", "low", false, null, false, true);
  entitled = false;
  await refreshProviders(true);
  let calls = 0;
  const result = await orchestrateSendMessage(server as never, {} as never, undefined, convId, "hello", Date.now(), {
    onHeaders: () => {}, onComplete: () => {}, streamMessageFn: async () => { calls++; return answer; },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toBe(DAYBREAK_UNAVAILABLE);
  expect(calls).toBe(0);
  expect(conversations.get(convId)?.daybreak).toBe(true);
  await handle({} as never, { type: "set_daybreak", convId, enabled: false });
  expect(conversations.get(convId)?.daybreak).toBe(false);
});
