import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { create } from "./conversations";
import { resetExperimentalFeaturesForTest } from "./experimental";
import type { StoredMessage } from "./messages";
import {
  clearNextMessageSuggestion,
  resetNextMessageSuggestionsForTest,
  sanitizeSuggestion,
  sendNextMessageSuggestion,
  startNextMessageSuggestion,
  suggestionContext,
} from "./next-message-suggestions";

const user = (text: string, metadata: Partial<NonNullable<StoredMessage["metadata"]>> = {}): StoredMessage =>
  ({ role: "user", content: text, metadata: Object.keys(metadata).length ? metadata as never : null });
const assistant = (text: string): StoredMessage =>
  ({ role: "assistant", content: [{ type: "thinking", thinking: "hidden", signature: "" }, { type: "text", text }], metadata: null });

function useFlag(on: boolean): void {
  writeExocortexConfig(on ? { experimental: { nextMessageSuggestions: true } } : {});
  resetExperimentalFeaturesForTest();
}

function fakeServer(subscribed = true) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    server: {
      hasSubscribers: () => subscribed,
      sendToSubscribers: (_convId: string, event: Record<string, unknown>) => { sent.push(event); },
      sendTo: (_client: unknown, event: Record<string, unknown>) => { sent.push(event); },
    } as never,
  };
}

let nextId = 0;
function conversation(messages: StoredMessage[]) {
  const conv = create(`nms-${process.pid}-${nextId++}`, "anthropic", "claude-opus-5-5");
  conv.messages.push(...messages);
  return conv;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => useFlag(true));
afterEach(() => {
  resetNextMessageSuggestionsForTest();
  useFlag(false);
});

describe("suggestionContext", () => {
  test("labels human, assistant and automated turns, dropping thinking", () => {
    const context = suggestionContext({ messages: [
      user("fix the login bug"),
      assistant("Fixed it. Want me to run the tests?"),
      user("[subagent finished]", { subagentNotificationId: "n1" }),
      assistant("The subagent is done too."),
    ] });
    expect(context).toContain("USER: fix the login bug");
    expect(context).toContain("NOTICE: [subagent finished]");
    expect(context).toContain("ASSISTANT: The subagent is done too.");
    expect(context).not.toContain("hidden");
  });

  test("needs a final assistant reply and a human message", () => {
    expect(suggestionContext({ messages: [assistant("hi"), user("hello")] })).toBeNull();
    expect(suggestionContext({ messages: [user("[wake]", { automation: { kind: "chrono" } as never }), assistant("done")] })).toBeNull();
  });

  test("keeps the end of a long final reply, where the question is", () => {
    const context = suggestionContext({ messages: [user("go"), assistant(`${"x".repeat(10_000)} Should I push?`)] })!;
    expect(context).toContain("Should I push?");
    expect(context.length).toBeLessThan(4_000);
  });
});

describe("sanitizeSuggestion", () => {
  test("keeps a plain one-line message, stripping quotes and labels", () => {
    expect(sanitizeSuggestion('"commit and push it"')).toBe("commit and push it");
    expect(sanitizeSuggestion("Suggestion: run the tests")).toBe("run the tests");
  });

  test("rejects silence, the assistant's voice, praise and multi-line replies", () => {
    for (const raw of ["NONE", "none.", "", "Let me check that", "I'll do it", "looks good!", "thanks", "a\nb", "x".repeat(200)]) {
      expect(sanitizeSuggestion(raw)).toBeNull();
    }
  });
});

describe("startNextMessageSuggestion", () => {
  test("sends the cheap model's prediction to subscribers and replays it on load", async () => {
    const complete = mock(async () => ({ text: "yes, push it", inputTokens: 900, outputTokens: 5 }));
    resetNextMessageSuggestionsForTest(complete as never);
    const conv = conversation([user("fix it"), assistant("Fixed. Push?")]);
    const { sent, server } = fakeServer();
    startNextMessageSuggestion(server, conv.id);
    await settle();
    expect(complete).toHaveBeenCalledTimes(1);
    const [system, , options] = complete.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(system).toContain("next message");
    expect(options).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", tracking: { source: "next_message_suggestion", conversationId: conv.id } });
    expect(sent).toEqual([{ type: "next_message_suggestion", convId: conv.id, text: "yes, push it" }]);

    sendNextMessageSuggestion(server, {} as never, conv.id);
    expect(sent.at(-1)).toEqual({ type: "next_message_suggestion", convId: conv.id, text: "yes, push it" });

    clearNextMessageSuggestion(server, conv.id);
    expect(sent.at(-1)).toEqual({ type: "next_message_suggestion", convId: conv.id, text: null });
    sendNextMessageSuggestion(server, {} as never, conv.id);
    expect(sent.at(-1)).toEqual({ type: "next_message_suggestion", convId: conv.id, text: null });
  });

  test("does nothing when off, for subagents, or with nobody watching", async () => {
    const complete = mock(async () => ({ text: "go" }));
    resetNextMessageSuggestionsForTest(complete as never);
    const { sent, server } = fakeServer();

    useFlag(false);
    startNextMessageSuggestion(server, conversation([user("a"), assistant("b")]).id);
    sendNextMessageSuggestion(server, {} as never, "anything");
    useFlag(true);

    const child = conversation([user("a"), assistant("b")]);
    child.subagentPolicy = { parentConversationId: "parent" } as never;
    startNextMessageSuggestion(server, child.id);

    startNextMessageSuggestion(fakeServer(false).server, conversation([user("a"), assistant("b")]).id);
    await settle();
    expect(complete).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test("drops a prediction that a new turn or message overtook", async () => {
    let resolve!: (value: { text: string }) => void;
    resetNextMessageSuggestionsForTest((() => new Promise(r => { resolve = r; })) as never);
    const conv = conversation([user("a"), assistant("b")]);
    const { sent, server } = fakeServer();
    startNextMessageSuggestion(server, conv.id);
    conv.messages.push(user("typed meanwhile"));
    resolve({ text: "stale" });
    await settle();
    expect(sent).toEqual([]);
  });
});
