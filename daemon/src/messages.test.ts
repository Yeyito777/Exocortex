import { describe, expect, test } from "bun:test";
import {
  createStoredUserContextCheckpoint,
  currentReplayHistoryPrefix,
  historyPrefixHash,
  isValidActiveContextCached,
  type ActiveContext,
  type Conversation,
  type StoredMessage,
} from "./messages";

function countedContent(value: string, count: { value: number }): StoredMessage["content"] {
  return {
    toJSON() {
      count.value += 1;
      return value;
    },
  } as unknown as StoredMessage["content"];
}

function conversation(messages: StoredMessage[]): Conversation {
  return {
    id: "replay-prefix-cache",
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "high",
    fastMode: false,
    messages,
    createdAt: 1,
    updatedAt: 1,
    lastContextTokens: null,
    marked: false,
    pinned: false,
    muted: false,
    sortOrder: 0,
    folderId: null,
    title: "cache test",
    goal: null,
    subagentMaxDepth: null,
    subagentPolicy: null,
    toolPolicy: null,
  };
}

describe("replay history prefix cache", () => {
  test("extends an append-only checkpoint without serializing the historical prefix again", () => {
    const oldCalls = { value: 0 };
    const newCalls = { value: 0 };
    const messages: StoredMessage[] = [
      { role: "user", content: countedContent("old", oldCalls), metadata: null },
    ];
    const conv = conversation(messages);

    const first = createStoredUserContextCheckpoint(conv);
    expect(oldCalls.value).toBe(1);
    expect(createStoredUserContextCheckpoint(conv)).toEqual(first);
    expect(oldCalls.value).toBe(1);

    messages.push({ role: "assistant", content: countedContent("new", newCalls), metadata: null });
    const extended = createStoredUserContextCheckpoint(conv);
    expect(oldCalls.value).toBe(1);
    expect(newCalls.value).toBe(1);
    expect(extended.transcriptHistoryCount).toBe(2);
    expect(extended.transcriptPrefixHash).toBe(historyPrefixHash(messages, 2));
  });

  test("rejects cached state after a hashed top-level field changes", () => {
    const originalCalls = { value: 0 };
    const replacementCalls = { value: 0 };
    const messages: StoredMessage[] = [
      { role: "user", content: countedContent("before", originalCalls), metadata: null },
    ];

    const before = currentReplayHistoryPrefix(messages);
    messages[0].content = countedContent("after", replacementCalls);
    const after = currentReplayHistoryPrefix(messages);

    expect(before.hash).not.toBe(after.hash);
    expect(replacementCalls.value).toBe(1);
    expect(after.hash).toBe(historyPrefixHash(messages, 1));
  });

  test("rejects cached state after metadata changes replay eligibility", () => {
    const messages: StoredMessage[] = [
      { role: "user", content: "warning", metadata: null },
    ];

    const before = currentReplayHistoryPrefix(messages);
    messages[0].metadata = {
      startedAt: 1,
      endedAt: 1,
      model: "gpt-5.6-sol",
      tokens: 0,
      kind: "context_warning",
    };
    const after = currentReplayHistoryPrefix(messages);

    expect(before.historyCount).toBe(1);
    expect(after.historyCount).toBe(0);
    expect(after.hash).toBe(historyPrefixHash(messages, 0));
  });

  test("reuses the SHA state produced by cold active-context validation", () => {
    const calls = { value: 0 };
    const messages: StoredMessage[] = [
      { role: "user", content: countedContent("represented", calls), metadata: null },
    ];
    const prefixHash = historyPrefixHash(messages, 1);
    calls.value = 0;
    const active: ActiveContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 1,
      transcriptPrefixHash: prefixHash,
      compactionHistoryCount: 1,
      compactionPrefixHash: prefixHash,
      windowId: "replay-prefix-cache:1",
      windowNumber: 1,
      compactedAt: 1,
      compactionCount: 1,
    };

    expect(isValidActiveContextCached(active, messages)).toBe(true);
    expect(calls.value).toBe(1);
    currentReplayHistoryPrefix(messages);
    expect(calls.value).toBe(1);
  });
});
