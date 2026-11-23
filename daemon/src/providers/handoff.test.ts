import { describe, expect, test } from "bun:test";
import { buildConversationApiContext, needsPortableCheckpoint, portableCheckpoint } from "../context-compaction";
import { createConversation, historyPrefixHash, isValidActiveContext, type ActiveContext, type ApiMessage, type StoredMessage } from "../messages";
import type { streamMessage } from "../api";
import { buildClaudeUserContent } from "./anthropic/prompt";
import { buildGeminiPromptContent } from "./gemini/prompt";
import { buildOpenAIInput } from "./openai/request";
import { buildOpenAICompatibleMessages } from "./openai-compatible/request";
import { MAX_HANDOFF_IMAGES, MISSING_TOOL_RESULT, assistantProvider, hasOtherProviderTurns, pairToolCalls, renderHandoffParts } from "./handoff";

// A real 1x1 PNG, so image validation keeps it.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: PNG } };

function meta(model: string, provider?: string) {
  return { startedAt: 1, endedAt: 2, model, tokens: 0, ...(provider ? { generationThroughput: { provider, model, rates: [] } } : {}) } as never;
}

/** Claude Code, then GPT with a tool call and an image, then a new user message. */
function mixedHistory(): ApiMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "look at this" }, image] },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "claude private reasoning", signature: "sig" }, { type: "text", text: "A small square." }],
      metadata: meta("claude-opus-5-5", "anthropic"),
      providerData: { anthropic: { sessionId: "s1", resumeAt: "a1", cwd: "/work" } },
    },
    { role: "user", content: "read the note", metadata: meta("gpt-6-sol") },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "cat note" } }], metadata: meta("gpt-6-sol", "openai") },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "NOTE-42" }, image] }] },
    { role: "assistant", content: [{ type: "text", text: "The note says NOTE-42." }], metadata: meta("gpt-6-sol", "openai") },
    { role: "user", content: "what did the note say?" },
  ];
}

describe("who wrote an assistant message", () => {
  test("replay data first, then the turn's metadata", () => {
    const history = mixedHistory();
    expect(assistantProvider(history[1])).toBe("anthropic");
    expect(assistantProvider(history[3])).toBe("openai");
    expect(assistantProvider({ role: "assistant", content: "x", metadata: meta("gemini-4-neon") })).toBe("gemini");
    expect(assistantProvider({ role: "assistant", content: "x" })).toBeNull();
    expect(hasOtherProviderTurns(history.slice(2), "anthropic")).toBe(true);
    expect(hasOtherProviderTurns(history.slice(0, 2), "anthropic")).toBe(false);
  });
});

describe("handoff transcripts", () => {
  test("keep tool calls, results and images in order and leave out reasoning", () => {
    const { parts, omittedImages } = renderHandoffParts(mixedHistory().slice(0, -1));
    expect(omittedImages).toBe(0);
    expect(parts.map(part => part.type)).toEqual(["text", "image", "text", "image", "text"]);
    const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("");
    expect(text).toStartWith("User:\nlook at this");
    expect(text).toContain("[tool call bash call_1]\n{\"command\":\"cat note\"}");
    expect(text).toContain("[tool result call_1]\nNOTE-42");
    expect(text).toContain("Assistant:\nThe note says NOTE-42.");
    expect(text).not.toContain("claude private reasoning");
  });

  test("carry only the newest images", () => {
    const many: ApiMessage[] = Array.from({ length: MAX_HANDOFF_IMAGES + 3 }, (_, i) => ({ role: "user", content: [{ type: "text", text: `image ${i}` }, image] }));
    const { parts, omittedImages } = renderHandoffParts(many);
    expect(omittedImages).toBe(3);
    expect(parts.filter(part => part.type === "image")).toHaveLength(MAX_HANDOFF_IMAGES);
    const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("");
    expect(text.match(/\[image omitted\]/g)).toHaveLength(3);
    expect(text.indexOf("[image omitted]")).toBeLessThan(text.indexOf("image 3"));
  });

  test("reach Claude Code with the images as image blocks before the new message", () => {
    const content = buildClaudeUserContent(mixedHistory());
    expect(content.filter(block => block.type === "image")).toHaveLength(2);
    const first = content[0];
    expect(first.type === "text" && first.text).toStartWith("<conversation_history>");
    const last = content.at(-1)!;
    expect(last.type === "text" && last.text).toBe("what did the note say?");
    expect(JSON.stringify(content)).toContain("NOTE-42");
  });

  test("reach the Antigravity CLI the same way", () => {
    const content = buildGeminiPromptContent(mixedHistory());
    expect(content.filter(block => block.type === "image")).toHaveLength(2);
    expect(JSON.stringify(content)).toContain("[tool result call_1]\\nNOTE-42");
    expect(content.at(-1)).toEqual({ type: "text", text: "what did the note say?" });
  });
});

describe("tool calls paired for strict APIs", () => {
  test("history that already pairs up is returned as is", () => {
    const history = mixedHistory();
    expect(pairToolCalls(history)).toBe(history);
  });

  test("an unanswered call gets a placeholder and a stray result is dropped", () => {
    const history: ApiMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_A", name: "Bash", input: {} }, { type: "tool_use", id: "toolu_B", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "ok" }, { type: "tool_result", tool_use_id: "ghost", content: "?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_C", name: "Bash", input: {} }] },
      { role: "assistant", content: "interrupted, then a new turn" },
      { role: "user", content: "next" },
    ];
    const paired = pairToolCalls(history);
    expect(paired).toHaveLength(7);
    expect(paired[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_A", content: "ok" },
      { type: "tool_result", tool_use_id: "toolu_B", content: MISSING_TOOL_RESULT, is_error: true },
    ]);
    expect(paired[4]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_C", content: MISSING_TOOL_RESULT, is_error: true }] });
    expect(history).toHaveLength(6);

    const input = buildOpenAIInput(history) as Array<{ type: string; call_id?: string }>;
    const calls = input.filter(item => item.type === "function_call").map(item => item.call_id);
    const outputs = input.filter(item => item.type === "function_call_output").map(item => item.call_id);
    expect(outputs.sort()).toEqual(calls.sort());

    const chat = buildOpenAICompatibleMessages(history, undefined, { providerLabel: "Test", supportsImages: true } as never);
    const toolIds = chat.flatMap(message => message.role === "tool" ? [(message as { tool_call_id: string }).tool_call_id] : []);
    expect(toolIds.sort()).toEqual(["toolu_A", "toolu_B", "toolu_C"]);
  });

  test("results whose call an OpenAI compaction may hold are kept", () => {
    const history: ApiMessage[] = [
      { role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } } },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_hidden", content: "ok" }] },
    ];
    const input = buildOpenAIInput(history) as Array<{ type: string; call_id?: string }>;
    expect(input.some(item => item.type === "function_call_output" && item.call_id === "call_hidden")).toBe(true);
  });
});

describe("leaving an OpenAI-native checkpoint", () => {
  function transcript(): StoredMessage[] {
    return [
      { role: "user", content: "old question", metadata: null },
      { role: "assistant", content: "old answer", metadata: null },
      { role: "user", content: "new question", metadata: null },
    ];
  }
  function native(messages: StoredMessage[]): ActiveContext {
    return {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-6-sol",
      accountScope: "account-a",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } } },
      ],
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(messages, 2),
      compactionHistoryCount: 2,
      compactionPrefixHash: historyPrefixHash(messages, 2),
      windowId: "switch-test:1",
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
  }

  test("is needed only for another provider or account", () => {
    const active = native(transcript());
    expect(needsPortableCheckpoint(active, "anthropic", "claude-opus-5-5")).toBe(true);
    expect(needsPortableCheckpoint(active, "gemini", "gemini-4-neon")).toBe(true);
    expect(needsPortableCheckpoint(active, "openai", "gpt-6-luna", "account-b")).toBe(true);
    expect(needsPortableCheckpoint(active, "openai", "gpt-6-luna", "account-a")).toBe(false);
  });

  test("the checkpoint's own model rewrites it as plaintext any provider can replay", async () => {
    const conv = createConversation("switch-test", "anthropic", "claude-opus-5-5");
    conv.messages = transcript();
    conv.activeContext = native(conv.messages);
    expect(() => buildConversationApiContext(conv)).toThrow(/incompatible/);

    const requests: Array<{ provider: string; model: string; sawOpaque: boolean }> = [];
    const fakeStream: typeof streamMessage = async (provider, messages, model) => {
      requests.push({ provider, model, sawOpaque: messages.some(message => !!message.providerData?.openai?.compactionItems?.length) });
      return { text: "The user asked an old question; it was answered.", thinking: "", stopReason: "stop", blocks: [], toolCalls: [] };
    };
    const portable = await portableCheckpoint(conv.activeContext, { accountScope: "account-a", streamMessageFn: fakeStream });
    expect(requests).toEqual([{ provider: "openai", model: "gpt-6-sol", sawOpaque: true }]);
    expect(portable.kind).toBe("plaintext");
    expect(portable.accountScope).toBeUndefined();
    expect(portable.windowId).toBe("switch-test:1");
    expect(isValidActiveContext(portable, conv.messages)).toBe(true);

    conv.activeContext = portable;
    const replay = buildConversationApiContext(conv).messages;
    expect(JSON.stringify(replay)).toContain("The user asked an old question; it was answered.");
    expect(replay.at(-1)).toMatchObject({ role: "user", content: "new question" });
    expect(replay.some(message => message.providerData?.openai)).toBe(false);
  });
});
