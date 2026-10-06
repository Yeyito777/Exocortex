import { afterAll, beforeAll, expect, test } from "bun:test";
import { DAYBREAK_MODEL_ID, DAYBREAK_RETIRED_MODEL, DAYBREAK_UNAVAILABLE } from "@exocortex/shared/daybreak";
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
import { clearConversationDefaults } from "@exocortex/shared/config";
import { setDaemonConversationDefaults } from "./conversation-defaults";
import { streamMessage } from "./api";

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
  clearConversationDefaults();
  adapters.forEach((adapter, i) => { adapter.models.fetch = fetchers[i]; });
  for (const convId of ids) {
    conversations.clearQueuedMessages(convId);
    clearActiveJob(convId);
    conversations.remove(convId);
    jsonPersistence.trashFile(convId);
  }
});

test("exact-model discovery resolves Blue, standard, and no treatment", () => {
  expect(cyberAccessProgramForSelection("openai", DAYBREAK_MODEL_ID)).toBe("daybreak_blue");
  expect(cyberAccessProgramForSelection("openai", "gpt-6-sol")).toBe("standard");
  expect(cyberAccessProgramForSelection("deepseek", "deepseek-v4-pro")).toBeUndefined();
  expect(() => cyberAccessProgramForSelection("openai", "gpt-6.1-sol-daybreak")).toThrow(DAYBREAK_RETIRED_MODEL);
  expect(() => cyberAccessProgramForSelection("openai", "gpt-6-luna-daybreak")).toThrow(DAYBREAK_RETIRED_MODEL);
});

test("daemon persists and broadcasts the model alias independently of speed and effort", async () => {
  const convId = id("toggle");
  await handle({} as never, {
    type: "new_conversation", convId, provider: "openai", model: DAYBREAK_MODEL_ID, effort: "max", fastMode: true,
  });
  expect(conversations.get(convId)).toMatchObject({ model: DAYBREAK_MODEL_ID, effort: "max", fastMode: true });
  expect(events.at(-1)).toMatchObject({ type: "conversation_updated", summary: { model: DAYBREAK_MODEL_ID } });
  await handle({} as never, { type: "set_model", convId, provider: "openai", model: "gpt-6-sol" });
  expect(conversations.getSummary(convId)?.model).toBe("gpt-6-sol");
  await handle({} as never, { type: "set_model", convId, provider: "openai", model: DAYBREAK_MODEL_ID });
  setActiveJob(convId, new AbortController(), Date.now());
  await handle({} as never, { type: "set_model", reqId: "busy", convId, provider: "openai", model: "gpt-6-sol" });
  expect(events.at(-1)).toMatchObject({ type: "error", reqId: "busy", message: expect.stringContaining("streaming") });
  expect(conversations.get(convId)?.model).toBe(DAYBREAK_MODEL_ID);
  clearActiveJob(convId);
  await handle({} as never, { type: "set_model", convId, provider: "openai", model: "gpt-6-luna" });
  expect(conversations.get(convId)).toMatchObject({ model: "gpt-6-luna", fastMode: true });
});

test("unsupported Daybreak aliases fail without mutation despite custom-model support", async () => {
  for (const model of ["gpt-6.1-sol-daybreak", "gpt-6-luna-daybreak", "gpt-daybreak-blue-latest"]) {
    const convId = id(model);
    await handle({} as never, { type: "new_conversation", convId, provider: "openai", model });
    expect(conversations.hasConversation(convId)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", message: DAYBREAK_RETIRED_MODEL });
  }
  const convId = id("invalid");
  conversations.create(convId, "openai", "gpt-6-sol");
  await handle({} as never, { type: "set_model", convId, provider: "openrouter", model: DAYBREAK_MODEL_ID });
  expect(conversations.get(convId)?.model).toBe("gpt-6-sol");
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
    provider: "openai", model: DAYBREAK_MODEL_ID,
    waitTarget: { type: "conversation", convId: dependency, label: "dependency" },
  });
  expect(conversations.get(convId)?.model).toBe(DAYBREAK_MODEL_ID);
  expect(conversations.getQueuedMessageById("queued-daybreak")).toMatchObject({ model: DAYBREAK_MODEL_ID });
  conversations.removeQueuedMessageById("queued-daybreak");
  clearActiveJob(dependency);
});

test("daemon defaults capture the alias through ordinary new-conversation selection", async () => {
  const defaults = { provider: "openai" as const, model: DAYBREAK_MODEL_ID, effort: "max" as const, fastMode: true };
  expect(setDaemonConversationDefaults(defaults)).toMatchObject({ defaults });
  const convId = id("default");
  await handle({} as never, { type: "new_conversation", convId });
  expect(conversations.get(convId)).toMatchObject(defaults);
  clearConversationDefaults();
});

test("JSON upgrades the old model selection and preserves canonical history", () => {
  const conv = createConversation(id("legacy"), "openai", "gpt-daybreak-blue-latest");
  conv.messages.push({ role: "assistant", content: "old answer", metadata: { model: conv.model, tokens: 1, startedAt: 1, endedAt: 2 } });
  jsonPersistence.save(conv);
  const loaded = jsonPersistence.load(conv.id)!;
  expect(loaded).toMatchObject({ model: DAYBREAK_MODEL_ID });
  expect(loaded.messages).toEqual(conv.messages);
  jsonPersistence.save(loaded);
  expect(jsonPersistence.load(conv.id)?.model).toBe(DAYBREAK_MODEL_ID);
});

test("turn admission and native manual compaction use the same explicit program", async () => {
  const convId = id("turn");
  conversations.create(convId, "openai", DAYBREAK_MODEL_ID, "", "low", true);
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
    { model: DAYBREAK_MODEL_ID, program: "daybreak_blue", compaction: false },
    { model: DAYBREAK_MODEL_ID, program: "daybreak_blue", compaction: true },
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

test("loss of catalog entitlement fails Daybreak turns; standard Sol is recoverable", async () => {
  const convId = id("lost-access");
  conversations.create(convId, "openai", DAYBREAK_MODEL_ID, "", "low");
  entitled = false;
  await refreshProviders(true);
  let calls = 0;
  const result = await orchestrateSendMessage(server as never, {} as never, undefined, convId, "hello", Date.now(), {
    onHeaders: () => {}, onComplete: () => {}, streamMessageFn: async () => { calls++; return answer; },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toBe(DAYBREAK_UNAVAILABLE);
  expect(calls).toBe(0);
  expect(conversations.get(convId)?.model).toBe(DAYBREAK_MODEL_ID);
  await handle({} as never, { type: "set_model", convId, provider: "openai", model: "gpt-6-sol" });
  expect(conversations.get(convId)?.model).toBe("gpt-6-sol");
  const rejectedId = id("no-entitlement");
  await handle({} as never, { type: "new_conversation", convId: rejectedId, provider: "openai", model: DAYBREAK_MODEL_ID });
  expect(conversations.hasConversation(rejectedId)).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "error", message: DAYBREAK_UNAVAILABLE });
  expect(() => setDaemonConversationDefaults({ provider: "openai", model: DAYBREAK_MODEL_ID, effort: "low", fastMode: false })).toThrow(DAYBREAK_UNAVAILABLE);
  await expect(streamMessage("openai", [], DAYBREAK_MODEL_ID, { onText: () => {}, onThinking: () => {} })).rejects.toThrow(DAYBREAK_UNAVAILABLE);
});
