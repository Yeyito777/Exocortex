import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "./messages";
import {
  applyRealtimeDelegationEnvelope,
  buildRealtimeDelegationEnvelope,
  REALTIME_DELEGATION_DEVELOPER_MESSAGE,
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
      "Inspect <this> and report the concrete findings",
    );

    expect(contextualized).not.toBeNull();
    expect(contextualized).toHaveLength(messages.length);
    expect(contextualized?.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(contextualized?.at(-2)?.content).toBe("Sure, I’ll hand that over.");
    expect(contextualized?.at(-1)?.content).toBe(
      "<realtime_delegation>\n" +
      "  <backend_task>Inspect &lt;this&gt; and report the concrete findings</backend_task>\n" +
      "  <original_user_utterance>Please inspect &lt;this&gt; &amp; report back</original_user_utterance>\n" +
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
    expect(buildRealtimeDelegationEnvelope('please read <a> & "b"', "read <a>")).toBe(
      "<realtime_delegation>\n" +
      "  <backend_task>read &lt;a&gt;</backend_task>\n" +
      "  <original_user_utterance>please read &lt;a&gt; &amp; &quot;b&quot;</original_user_utterance>\n" +
      "</realtime_delegation>",
    );
  });

  test("defines a backend-only delegation contract", () => {
    expect(REALTIME_DELEGATION_DEVELOPER_MESSAGE).toBe(
      "You are the backend worker for an active realtime voice session. " +
      "The user is speaking with a separate realtime voice model, which owns conversational acknowledgements, social dialogue, and spoken presentation. " +
      "Execute the <backend_task> inside the <realtime_delegation>; use <original_user_utterance> only as supporting context. " +
      "Do not answer conversational or social portions, imitate the live conversation, discuss your own experience, or add filler or status narration. " +
      "Return only the concrete findings or result needed to satisfy the backend portion, with no greeting or preamble.",
    );
  });
});
