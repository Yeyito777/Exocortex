import { describe, expect, test } from "bun:test";
import {
  AUTO_COMPACTION_FRACTION,
  buildConversationApiContext,
  compactContextMessages,
  estimateContextTokens,
  isActiveContextCompatible,
  shouldAutoCompact,
} from "./context-compaction";
import {
  createConversation,
  historyPrefixHash,
  isValidActiveContext,
  type ActiveContext,
  type StoredMessage,
} from "./messages";
import type { streamMessage } from "./api";

function history(): StoredMessage[] {
  return [
    { role: "system_instructions", content: "be precise", metadata: null },
    { role: "user", content: "old question", metadata: null },
    { role: "assistant", content: "old answer", metadata: null },
    { role: "system", content: "visible retry marker", metadata: null },
    { role: "user", content: "new question", metadata: null },
  ];
}

function activeContext(messages: StoredMessage[]): ActiveContext {
  return {
    version: 1,
    kind: "openai_native",
    provider: "openai",
    model: "gpt-5.6-sol",
    accountScope: "account-a",
    messages: [
      { role: "user", content: "old question" },
      {
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      },
    ],
    transcriptHistoryCount: 2,
    transcriptPrefixHash: historyPrefixHash(messages, 2),
    windowId: "compact-test:1",
    windowNumber: 1,
    compactedAt: 123,
    compactionCount: 1,
  };
}

describe("automatic context compaction state", () => {
  test("replays a checkpoint plus only the history tail while preserving transcript-only entries", () => {
    const conv = createConversation("compact-test", "openai", "gpt-5.6-sol");
    conv.messages = history();
    conv.activeContext = activeContext(conv.messages);

    const replay = buildConversationApiContext(conv, "account-a");

    expect(replay.usedActiveContext).toBe(true);
    expect(replay.messages.map((message) => message.content)).toEqual([
      "old question",
      [],
      "new question",
    ]);
    expect(conv.messages).toHaveLength(5);
    expect(conv.messages[0].role).toBe("system_instructions");
    expect(conv.messages[3].role).toBe("system");
  });

  test("history cursor remains valid when system instructions are inserted before it", () => {
    const messages = history().slice(1);
    const active = activeContext(messages);
    messages.unshift({ role: "system_instructions", content: "added later", metadata: null });

    expect(isValidActiveContext(active, messages)).toBe(true);
  });

  test("keeps legacy pressure notices visible but stops replaying their removed-tool instructions", () => {
    const conv = createConversation("legacy-warning", "openai", "gpt-5.6-sol");
    conv.messages = [
      { role: "user", content: "real prompt", metadata: null },
      {
        role: "user",
        content: "Use context list, stage, compact",
        metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.6-sol", tokens: 0, system: true, kind: "context_warning" },
      },
    ];

    expect(buildConversationApiContext(conv, "account-a").messages.map((message) => message.content)).toEqual(["real prompt"]);
    expect(conv.messages).toHaveLength(2);
  });

  test("rejects a checkpoint after represented transcript history is edited", () => {
    const messages = history();
    const active = activeContext(messages);
    messages[1] = { role: "user", content: "edited old question", metadata: null };

    expect(isValidActiveContext(active, messages)).toBe(false);
  });

  test("rejects malformed native and plaintext checkpoint payloads", () => {
    const messages = history();
    const native = activeContext(messages);
    native.messages[1].providerData = { openai: { compactionItems: [] } };
    expect(isValidActiveContext(native, messages)).toBe(false);

    native.messages[1].providerData = {
      openai: { compactionItems: [{ encryptedContent: "one" }, { encryptedContent: "two" }] },
    };
    expect(isValidActiveContext(native, messages)).toBe(false);

    const plaintext: ActiveContext = {
      ...activeContext(messages),
      kind: "plaintext",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      accountScope: undefined,
      messages: [{ role: "user", content: "unmarked summary" }],
    };
    expect(isValidActiveContext(plaintext, messages)).toBe(false);
  });

  test("rejects malformed blocks and orphaned tool results in derived replay", () => {
    const messages = history();
    const native = activeContext(messages);
    native.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "missing-call", content: "orphan" }],
    });
    expect(isValidActiveContext(native, messages)).toBe(false);

    native.messages = [{
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "read", input: {} }],
      providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
    }];
    expect(isValidActiveContext(native, messages)).toBe(false);

    native.messages = [{ role: "user", content: [{ type: "text", text: 42 } as never] }];
    expect(isValidActiveContext(native, messages)).toBe(false);

    native.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "read", input: {} }],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      },
      { role: "user", content: "intervening prompt" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "late" }] },
    ];
    expect(isValidActiveContext(native, messages)).toBe(false);

    native.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "read", input: {} }],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call-1",
          content: [{ type: "bogus", payload: "silently dropped" }],
        }],
      },
    ];
    expect(isValidActiveContext(native, messages)).toBe(false);
  });

  test("native checkpoints require the same OpenAI model and account; plaintext is portable only without scoped replay", () => {
    const active = activeContext(history());
    expect(isActiveContextCompatible(active, "openai", "gpt-5.6-sol", "account-a")).toBe(true);
    expect(isActiveContextCompatible(active, "openai", "gpt-5.6-sol", "account-b")).toBe(false);
    expect(isActiveContextCompatible(active, "openai", "gpt-5.5", "account-a")).toBe(false);
    expect(isActiveContextCompatible(active, "deepseek", "deepseek-v4-pro")).toBe(false);

    active.kind = "plaintext";
    expect(isActiveContextCompatible(active, "deepseek", "deepseek-v4-pro")).toBe(false);
    active.messages = [{
      role: "user",
      content: "portable summary",
      metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.6-sol", tokens: 0, system: true, kind: "context_checkpoint" },
    }];
    expect(isActiveContextCompatible(active, "deepseek", "deepseek-v4-pro")).toBe(true);

    active.messages.push({
      role: "assistant",
      content: [],
      providerData: {
        openai: {
          reasoningItems: [{ id: "reasoning-1", encryptedContent: "scoped", summaries: ["visible summary"] }],
        },
      },
    });
    expect(isActiveContextCompatible(active, "openai", "gpt-5.6-sol", "account-a")).toBe(true);
    expect(isActiveContextCompatible(active, "openai", "gpt-5.6-sol", "account-b")).toBe(false);
    expect(isActiveContextCompatible(active, "deepseek", "deepseek-v4-pro")).toBe(false);
  });

  test("sanitizes scoped reasoning in a never-compacted transcript after an account or model switch", () => {
    const conv = createConversation("ordinary-switch", "openai", "gpt-5.6-sol");
    conv.messages = [
      { role: "user", content: "question", metadata: null },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "safe visible summary", signature: "sig" }],
        metadata: null,
        providerData: {
          openai: {
            replayScope: { model: "gpt-5.6-sol", accountScope: "account-a" },
            reasoningItems: [{ id: "reasoning-old", encryptedContent: "account-a-secret", summaries: ["safe visible summary"] }],
          },
        },
      },
    ];
    const canonicalBeforeProjection = structuredClone(conv.messages);

    const matching = buildConversationApiContext(conv, "account-a");
    expect(matching.messages[1].providerData?.openai.reasoningItems?.[0]?.encryptedContent).toBe("account-a-secret");

    const switchedAccount = buildConversationApiContext(conv, "account-b");
    expect(switchedAccount.messages[1].providerData).toBeUndefined();
    expect(switchedAccount.messages[1].content).toEqual([
      { type: "text", text: "[Prior assistant reasoning summary]\nsafe visible summary" },
    ]);
    expect(conv.messages).toEqual(canonicalBeforeProjection);

    conv.model = "gpt-5.5";
    expect(buildConversationApiContext(conv, "account-a").messages[1].providerData).toBeUndefined();
  });

  test("conservatively sanitizes legacy unscoped reasoning without a proving checkpoint", () => {
    const conv = createConversation("legacy-unscoped", "openai", "gpt-5.6-sol");
    conv.messages = [{
      role: "assistant",
      content: [],
      metadata: null,
      providerData: {
        openai: {
          reasoningItems: [{ id: "legacy", encryptedContent: "unknown-account", summaries: ["legacy summary"] }],
        },
      },
    }];

    const replay = buildConversationApiContext(conv, "account-a");
    expect(replay.messages[0].providerData).toBeUndefined();
    expect(replay.messages[0].content).toEqual([
      { type: "text", text: "[Prior assistant reasoning summary]\nlegacy summary" },
    ]);
  });

  test("sanitizes a clean portable checkpoint tail when its response scope changed", () => {
    const conv = createConversation("portable-tail", "openai", "gpt-5.6-sol");
    conv.messages = history();
    const checkpoint: ActiveContext = {
      ...activeContext(conv.messages),
      kind: "plaintext",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      accountScope: undefined,
      messages: [{
        role: "user",
        content: "portable checkpoint",
        metadata: { startedAt: 1, endedAt: 1, model: "deepseek-v4-pro", tokens: 0, system: true, kind: "context_checkpoint" },
      }],
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 2),
    };
    conv.activeContext = checkpoint;
    conv.messages[4] = {
      role: "assistant",
      content: [],
      metadata: null,
      providerData: {
        openai: {
          replayScope: { model: "gpt-5.6-sol", accountScope: "account-a" },
          reasoningItems: [{ id: "tail", encryptedContent: "old-account", summaries: ["tail summary"] }],
        },
      },
    };

    const replay = buildConversationApiContext(conv, "account-b");
    expect(replay.usedActiveContext).toBe(true);
    expect(replay.messages.at(-1)?.providerData).toBeUndefined();
    expect(replay.messages.at(-1)?.content).toEqual([
      { type: "text", text: "[Prior assistant reasoning summary]\ntail summary" },
    ]);
  });

  test("falls back to the retained full transcript when a native checkpoint is incompatible", () => {
    const conv = createConversation("switch-provider", "openai", "gpt-5.6-sol");
    conv.messages = history();
    conv.messages[2].content = [{ type: "thinking", thinking: "visible old reasoning", signature: "sig" }];
    conv.messages[2].providerData = {
      openai: {
        reasoningItems: [{ id: "reasoning-old", encryptedContent: "account-a-secret", summaries: ["visible old reasoning"] }],
      },
    };
    conv.activeContext = activeContext(conv.messages);
    conv.provider = "deepseek";
    conv.model = "deepseek-v4-pro";

    const replay = buildConversationApiContext(conv);
    expect(replay.usedActiveContext).toBe(false);
    expect(replay.messages.map((message) => message.content)).toEqual([
      "old question",
      [{ type: "text", text: "[Prior assistant reasoning summary]\nvisible old reasoning" }],
      "new question",
    ]);
    expect(replay.messages.every((message) => message.providerData === undefined)).toBe(true);
  });

  test("uses the Codex-style ninety percent automatic threshold", () => {
    expect(AUTO_COMPACTION_FRACTION).toBe(0.9);
    expect(shouldAutoCompact(89_999, 100_000)).toBe(false);
    expect(shouldAutoCompact(90_000, 100_000)).toBe(true);
  });

  test("charges opaque native checkpoints in replay token estimates", () => {
    const estimated = estimateContextTokens([{
      role: "assistant",
      content: [],
      providerData: { openai: { compactionItems: [{ encryptedContent: "x".repeat(40_000) }] } },
    }], "openai");

    expect(estimated).toBeGreaterThanOrEqual(10_000);
  });

  test("installs exactly one native OpenAI checkpoint and retains original user requests", async () => {
    let sawCompactionRequest = false;
    const fakeStream: typeof streamMessage = async (_provider, _messages, _model, _callbacks, options) => {
      sawCompactionRequest = options?.compaction === true;
      return {
        text: "",
        thinking: "",
        stopReason: "stop",
        blocks: [],
        toolCalls: [],
        inputTokens: 330_000,
        outputTokens: 1,
        compactionItems: [{ id: "cmp_1", encryptedContent: "opaque" }],
        assistantProviderData: {
          openai: {
            replayScope: { model: "gpt-5.6-sol", accountScope: "verified-account" },
            compactionItems: [{ id: "cmp_1", encryptedContent: "opaque" }],
          },
        },
      };
    };

    const result = await compactContextMessages([
      { role: "user", content: "original request" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "large output" }] },
    ], {
      provider: "openai",
      model: "gpt-5.6-sol",
      accountScope: "pre-verification-account",
      reason: "pre_turn",
      streamMessageFn: fakeStream,
    });

    expect(sawCompactionRequest).toBe(true);
    expect(result.kind).toBe("openai_native");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe("original request");
    expect(result.messages[1].providerData?.openai.compactionItems).toEqual([
      { id: "cmp_1", encryptedContent: "opaque" },
    ]);
    expect(result.messages[1].providerData?.openai.replayScope?.accountScope).toBe("verified-account");
    expect(result.accountScope).toBe("verified-account");
  });

  test("accepts one completed native checkpoint alongside ignored function-call output", async () => {
    const fakeStream: typeof streamMessage = async () => ({
      text: "",
      thinking: "",
      stopReason: "tool_use",
      blocks: [],
      toolCalls: [{ id: "ignored", name: "read", input: { file_path: "/tmp/a" } }],
      compactionItems: [{ encryptedContent: "valid-checkpoint" }],
    });

    const result = await compactContextMessages([{ role: "user", content: "compact me" }], {
      provider: "openai",
      model: "gpt-5.6-sol",
      reason: "tool_round",
      streamMessageFn: fakeStream,
    });

    expect(result.kind).toBe("openai_native");
    expect(result.messages.at(-1)?.providerData?.openai.compactionItems).toEqual([
      { encryptedContent: "valid-checkpoint" },
    ]);
  });

  test("rejects duplicate streamed checkpoint completions even when they collapse to one map slot", async () => {
    let request = 0;
    let fallbackWarning = "";
    const fakeStream: typeof streamMessage = async (_provider, _messages, _model, _callbacks, options) => {
      request += 1;
      if (options?.compaction) {
        return {
          text: "",
          thinking: "",
          stopReason: "stop",
          blocks: [],
          toolCalls: [],
          compactionItems: [{ encryptedContent: "last-map-value" }],
          compactionDoneCount: 2,
          responseCompleted: true,
        };
      }
      return {
        text: "faithful plaintext fallback",
        thinking: "",
        stopReason: "stop",
        blocks: [{ type: "text", text: "faithful plaintext fallback" }],
        toolCalls: [],
      };
    };

    const result = await compactContextMessages([{ role: "user", content: "original" }], {
      provider: "openai",
      model: "gpt-5.6-sol",
      contextLimit: 400_000,
      onPlaintextFallback: (warning) => {
        fallbackWarning = warning;
      },
      streamMessageFn: fakeStream,
    });

    expect(request).toBe(5);
    expect(result.kind).toBe("plaintext");
    expect(fallbackWarning).toContain("OpenAI server-side context compaction failed");
    expect(fallbackWarning).toContain("after exhausting its retries");
    expect(fallbackWarning).toContain("falling back to a model-generated plaintext checkpoint");
    expect(fallbackWarning).toContain("expected exactly 1");
  });

  test("retries malformed native checkpoint responses three times before succeeding", async () => {
    let request = 0;
    let fallbackWarning = "";
    let resets = 0;
    const retryAttempts: number[] = [];
    const fakeStream: typeof streamMessage = async () => {
      request += 1;
      if (request < 4) {
        return {
          text: "",
          thinking: "",
          stopReason: "stop",
          blocks: [],
          toolCalls: [],
          compactionItems: [],
          compactionDoneCount: 0,
          responseCompleted: true,
        };
      }
      return {
        text: "",
        thinking: "",
        stopReason: "stop",
        blocks: [],
        toolCalls: [],
        compactionItems: [{ encryptedContent: "valid-fourth-attempt" }],
        compactionDoneCount: 1,
        responseCompleted: true,
      };
    };

    const result = await compactContextMessages([{ role: "user", content: "original" }], {
      provider: "openai",
      model: "gpt-5.6-sol",
      contextLimit: 400_000,
      turnSession: {
        close() {},
        resetAfterCompaction: async () => {
          resets += 1;
        },
      },
      onPlaintextFallback: (warning) => {
        fallbackWarning = warning;
      },
      onNativeRetry: (attempt) => {
        retryAttempts.push(attempt);
      },
      streamMessageFn: fakeStream,
    });

    expect(request).toBe(4);
    expect(resets).toBe(3);
    expect(retryAttempts).toEqual([1, 2, 3]);
    expect(result.kind).toBe("openai_native");
    expect(result.messages.at(-1)?.providerData?.openai.compactionItems).toEqual([
      { encryptedContent: "valid-fourth-attempt" },
    ]);
    expect(fallbackWarning).toBe("");
  });

  test("shares the four-request cap across transport and malformed-response retries", async () => {
    const nativeBudgetSnapshots: number[] = [];
    const retryAttempts: number[] = [];
    let nativeCalls = 0;
    const fakeStream: typeof streamMessage = async (_provider, _messages, _model, _callbacks, options) => {
      if (!options?.compaction) {
        return {
          text: "plaintext after shared budget",
          thinking: "",
          stopReason: "stop",
          blocks: [{ type: "text", text: "plaintext after shared budget" }],
          toolCalls: [],
        };
      }

      nativeCalls += 1;
      const budget = options.requestBudget!;
      if (nativeCalls === 1) {
        // The custom stream seam represents one request itself (already charged
        // by context-compaction). Charge one additional simulated transport
        // retry before returning a malformed completed response.
        budget.attempts += 1;
      }
      nativeBudgetSnapshots.push(budget.attempts);
      return {
        text: "",
        thinking: "",
        stopReason: "stop",
        blocks: [],
        toolCalls: [],
        compactionItems: [],
        compactionDoneCount: 0,
        responseCompleted: true,
      };
    };

    const result = await compactContextMessages([{ role: "user", content: "original" }], {
      provider: "openai",
      model: "gpt-5.6-sol",
      contextLimit: 400_000,
      onNativeRetry: (attempt) => retryAttempts.push(attempt),
      streamMessageFn: fakeStream,
    });

    expect(nativeCalls).toBe(3);
    expect(nativeBudgetSnapshots).toEqual([2, 3, 4]);
    expect(retryAttempts).toEqual([2, 3]);
    expect(result.kind).toBe("plaintext");
  });

  test("creates a portable plaintext checkpoint for non-OpenAI providers", async () => {
    const fakeStream: typeof streamMessage = async () => ({
      text: "Goal, decisions, completed work, and next steps.",
      thinking: "",
      stopReason: "stop",
      blocks: [{ type: "text", text: "Goal, decisions, completed work, and next steps." }],
      toolCalls: [],
      inputTokens: 50_000,
      outputTokens: 100,
    });

    const result = await compactContextMessages([
      { role: "user", content: "portable request" },
      { role: "assistant", content: "work in progress" },
    ], {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reason: "provider_switch",
      streamMessageFn: fakeStream,
    });

    expect(result.kind).toBe("plaintext");
    expect(result.messages.at(-1)?.metadata).toMatchObject({ system: true, kind: "context_checkpoint" });
    expect(String(result.messages.at(-1)?.content)).toContain("Goal, decisions, completed work, and next steps.");
  });

  test("does not accept a nonempty but incomplete plaintext checkpoint", async () => {
    const fakeStream: typeof streamMessage = async () => ({
      text: "partial checkpoint",
      thinking: "",
      stopReason: "max_tokens",
      blocks: [{ type: "text", text: "partial checkpoint" }],
      toolCalls: [],
      inputTokens: 50_000,
      outputTokens: 12_000,
    });

    await expect(compactContextMessages([
      { role: "user", content: "do not lose this" },
    ], {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reason: "pre_turn",
      streamMessageFn: fakeStream,
    })).rejects.toThrow("Plaintext compaction did not complete");
  });

  test("hierarchically summarizes every oversized plaintext segment without dropping the prefix", async () => {
    let calls = 0;
    const fakeStream: typeof streamMessage = async (_provider, requestMessages) => {
      calls += 1;
      const input = requestMessages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
      const preserved = ["EARLY_REQUIRED_MARKER", "LATE_REQUIRED_MARKER"]
        .filter((marker) => input.includes(marker));
      return {
        text: `checkpoint call ${calls}: ${preserved.join(" ")}`,
        thinking: "",
        stopReason: "stop",
        blocks: [{ type: "text", text: `checkpoint call ${calls}: ${preserved.join(" ")}` }],
        toolCalls: [],
        inputTokens: 1_000,
        outputTokens: 20,
      };
    };

    const result = await compactContextMessages([
      { role: "user", content: `EARLY_REQUIRED_MARKER\n${"a".repeat(70_000)}` },
      { role: "assistant", content: `middle\n${"b".repeat(70_000)}` },
      { role: "user", content: `LATE_REQUIRED_MARKER\n${"c".repeat(70_000)}` },
    ], {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      contextLimit: 10_000,
      reason: "pre_turn",
      streamMessageFn: fakeStream,
    });

    expect(calls).toBeGreaterThan(2);
    expect(String(result.messages.at(-1)?.content)).toContain("EARLY_REQUIRED_MARKER");
    expect(String(result.messages.at(-1)?.content)).toContain("LATE_REQUIRED_MARKER");
  });

  test("adaptively resegments when the provider rejects a high-density summary input", async () => {
    let calls = 0;
    const fakeStream: typeof streamMessage = async (_provider, requestMessages) => {
      calls += 1;
      const input = requestMessages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
      if (input.length > 15_000) throw new Error("maximum context length exceeded");
      const markers = ["DENSE_EARLY", "DENSE_LATE"].filter((marker) => input.includes(marker));
      return {
        text: `adaptive summary ${markers.join(" ")}`,
        thinking: "",
        stopReason: "stop",
        blocks: [],
        toolCalls: [],
      };
    };

    const result = await compactContextMessages([{
      role: "user",
      content: `DENSE_EARLY${"界".repeat(80_000)}DENSE_LATE`,
    }], {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      contextLimit: 1_000_000,
      reason: "context_error",
      streamMessageFn: fakeStream,
    });

    expect(calls).toBeGreaterThan(4);
    expect(String(result.messages.at(-1)?.content)).toContain("DENSE_EARLY");
    expect(String(result.messages.at(-1)?.content)).toContain("DENSE_LATE");
  });

  test("fails atomically instead of deleting images from oversized hierarchical input", async () => {
    let calls = 0;
    const fakeStream: typeof streamMessage = async () => {
      calls += 1;
      throw new Error("should not be called");
    };

    await expect(compactContextMessages([{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "text", text: "x".repeat(100_000) },
      ],
    }], {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      contextLimit: 10_000,
      reason: "context_error",
      streamMessageFn: fakeStream,
    })).rejects.toThrow("without losing image contents");
    expect(calls).toBe(0);
  });
});
