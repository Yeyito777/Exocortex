import { describe, expect, test } from "bun:test";
import type { ConversationGoal, StoredMessage } from "./messages";
import type { streamMessage } from "./api";
import {
  decideGoalControllerAction,
  goalControllerToolDefs,
  projectGoalControllerHistory,
} from "./goal-controller";

function activeGoal(overrides: Partial<ConversationGoal> = {}): ConversationGoal {
  return {
    objective: "ship the implementation",
    status: "active",
    pausable: true,
    completable: true,
    createdAt: 1,
    updatedAt: 1,
    turns: 0,
    ...overrides,
  };
}

function result(toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>) {
  return {
    text: "",
    thinking: "",
    stopReason: toolCalls.length ? "tool_use" : "stop",
    blocks: [],
    toolCalls,
    inputTokens: 10,
    outputTokens: 2,
  };
}

describe("goal controller history projection", () => {
  test("keeps strict real-user/final-assistant text pairs and strips tool state", () => {
    const history: StoredMessage[] = [
      { role: "system_instructions", content: "secret instructions", metadata: null },
      { role: "user", content: "implement it", metadata: null },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "large reasoning", signature: "sig" },
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "tool-1", name: "bash", input: { command: "huge" } },
        ],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "very large output" }],
        metadata: null,
      },
      { role: "assistant", content: [{ type: "text", text: "Implementation complete; tests pass." }], metadata: null },
      { role: "system", content: "retry marker", metadata: null },
      {
        role: "user",
        content: "daemon notice",
        metadata: { startedAt: 2, endedAt: 2, model: "gpt-5.5", tokens: 0, system: true },
      },
      { role: "user", content: "what remains?", metadata: null },
      { role: "assistant", content: "Nothing remains.", metadata: null },
    ];

    expect(projectGoalControllerHistory(history)).toEqual([
      { role: "user", content: "implement it" },
      { role: "assistant", content: "Implementation complete; tests pass." },
      { role: "user", content: "what remains?" },
      { role: "assistant", content: "Nothing remains." },
    ]);
  });

  test("combines consecutive users, omits incomplete tails, and replaces image payloads", () => {
    const history: StoredMessage[] = [
      { role: "user", content: "first", metadata: null },
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "base64-secret" } }],
        metadata: null,
      },
      { role: "assistant", content: "combined answer", metadata: null },
      { role: "user", content: "unanswered", metadata: null },
    ];

    const projected = projectGoalControllerHistory(history);
    expect(projected).toEqual([
      {
        role: "user",
        content: "first\n\n[User attached an image; image omitted from goal-controller history.]",
      },
      { role: "assistant", content: "combined answer" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("base64-secret");
  });

  test("drops oldest complete pairs when the simplified budget is exceeded", () => {
    const history: StoredMessage[] = [
      { role: "user", content: "old user", metadata: null },
      { role: "assistant", content: "old assistant", metadata: null },
      { role: "user", content: "new user", metadata: null },
      { role: "assistant", content: "new assistant", metadata: null },
    ];

    expect(projectGoalControllerHistory(history, 20)).toEqual([
      { role: "user", content: "[Earlier simplified goal history omitted.]\n\nnew user" },
      { role: "assistant", content: "new assistant" },
    ]);
  });
});

describe("goal controller decision", () => {
  test("uses the source model settings and accepts one send_prompt tool", async () => {
    const requests: Array<{ messages: unknown; model: string; options: Record<string, unknown> }> = [];
    const fakeStream = (async (_provider, messages, model, _callbacks, options) => {
      requests.push({ messages, model, options: options as Record<string, unknown> });
      return result([{ id: "call-1", name: "send_prompt", input: { prompt: "Run the focused tests next." } }]);
    }) as typeof streamMessage;

    const decision = await decideGoalControllerAction(
      [
        { role: "user", content: "start", metadata: null },
        { role: "assistant", content: "inspection done", metadata: null },
      ],
      activeGoal(),
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        serviceTier: "fast",
        promptCacheKey: "conv:goal-controller",
        tracking: { source: "goal_controller", conversationId: "conv" },
        streamMessageFn: fakeStream,
      },
    );

    expect(decision).toEqual({ action: "send_prompt", prompt: "Run the focused tests next." });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "gpt-5.6-sol",
      options: {
        effort: "xhigh",
        serviceTier: "fast",
        promptCacheKey: "conv:goal-controller",
        tracking: { source: "goal_controller", conversationId: "conv" },
      },
    });
    expect((requests[0]!.options.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual([
      "send_prompt", "goal_pause", "goal_complete",
    ]);
  });

  test("retries one malformed response and requires exactly one valid lifecycle tool", async () => {
    let calls = 0;
    const fakeStream = (async () => {
      calls += 1;
      if (calls === 1) return result([]);
      return result([{ id: "call-2", name: "goal_pause", input: { reason: "Need the user's approval." } }]);
    }) as typeof streamMessage;

    await expect(decideGoalControllerAction([], activeGoal(), {
      provider: "openai",
      model: "gpt-5.5",
      effort: "medium",
      streamMessageFn: fakeStream,
    })).resolves.toEqual({ action: "pause", reason: "Need the user's approval." });
    expect(calls).toBe(2);
  });

  test("does not advertise or accept disallowed lifecycle actions", async () => {
    expect(goalControllerToolDefs(activeGoal({ pausable: false })).map(tool => tool.name)).toEqual([
      "send_prompt", "goal_complete",
    ]);
    expect(goalControllerToolDefs(activeGoal({ completable: false, pausable: false })).map(tool => tool.name)).toEqual([
      "send_prompt",
    ]);

    const fakeStream = (async () => result([
      { id: "bad", name: "goal_complete", input: { reason: "not allowed" } },
    ])) as typeof streamMessage;
    await expect(decideGoalControllerAction([], activeGoal({ completable: false, pausable: false }), {
      provider: "openai",
      model: "gpt-5.5",
      effort: "medium",
      streamMessageFn: fakeStream,
    })).rejects.toThrow("exactly one valid lifecycle tool");
  });
});
