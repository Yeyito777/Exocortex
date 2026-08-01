import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "./messages";
import {
  applyRealtimeDelegationEnvelope,
  buildRealtimeDelegationEnvelope,
} from "./orchestrator";

describe("realtime delegation context", () => {
  test("wraps the existing call transcript without appending another user item", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "Earlier question", metadata: null },
      { role: "assistant", content: "Earlier answer", metadata: null },
      {
        role: "user",
        content: "Please inspect <this> & report back.",
        metadata: {
          startedAt: 1,
          endedAt: 1,
          model: "gpt-5.6-sol",
          tokens: 0,
          kind: "realtime_transcript",
        },
      },
      {
        role: "assistant",
        content: "Sure, I’ll hand that over.",
        metadata: {
          startedAt: 2,
          endedAt: 2,
          model: "gpt-5.6-sol",
          tokens: 0,
          kind: "realtime_transcript",
        },
      },
    ];

    const contextualized = applyRealtimeDelegationEnvelope(
      messages,
      "Please inspect <this> & report back",
    );

    expect(contextualized).not.toBeNull();
    expect(contextualized).toHaveLength(messages.length);
    expect(contextualized?.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(contextualized?.at(-2)?.content).toBe("Sure, I’ll hand that over.");
    expect(contextualized?.at(-1)?.content).toBe(
      "<realtime_delegation>\n" +
      "  <input>Please inspect &lt;this&gt; &amp; report back</input>\n" +
      "</realtime_delegation>",
    );
    expect(messages.at(-2)?.content).toBe("Please inspect <this> & report back.");
  });

  test("does not reinterpret an unrelated ordinary user message", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "Please inspect it", metadata: null },
    ];
    expect(applyRealtimeDelegationEnvelope(messages, "Please inspect it")).toBeNull();
  });

  test("escapes handoff text in the model-only envelope", () => {
    expect(buildRealtimeDelegationEnvelope('read <a> & "b"')).toBe(
      "<realtime_delegation>\n" +
      "  <input>read &lt;a&gt; &amp; &quot;b&quot;</input>\n" +
      "</realtime_delegation>",
    );
  });
});
