/**
 * Tests for prompt cache breakpoint injection (cache.ts).
 *
 * Covers injectToolBreakpoints and injectMessageBreakpoints:
 * breakpoint placement correctness, content block selection,
 * string-to-array conversion, mutation safety, and return-value
 * identity (new vs. same reference).
 */

import { describe, test, expect } from "bun:test";
import { injectToolBreakpoints, injectMessageBreakpoints } from "./cache";
import type { ApiMessage, ApiContentBlock } from "./messages";

// ── Test helpers ──────────────────────────────────────────────────────

const EPHEMERAL = { type: "ephemeral" } as const;

function textBlock(text: string): ApiContentBlock {
  return { type: "text", text };
}

function userMsg(content: string | ApiContentBlock[]): ApiMessage {
  return { role: "user", content };
}

function assistantMsg(content: string | ApiContentBlock[]): ApiMessage {
  return { role: "assistant", content };
}

/** Return the content blocks of a result message, asserting they are an array. */
function blocks(msg: ApiMessage): ApiContentBlock[] {
  expect(Array.isArray(msg.content)).toBe(true);
  return msg.content as ApiContentBlock[];
}

// ── injectToolBreakpoints ─────────────────────────────────────────────

describe("injectToolBreakpoints", () => {
  // ── Empty input ──────────────────────────────────────────────────────

  test("empty array — returns same reference (early-exit, no allocation)", () => {
    const tools: unknown[] = [];
    expect(injectToolBreakpoints(tools)).toBe(tools);
  });

  // ── Return-value identity ────────────────────────────────────────────

  test("non-empty — returns a new array, not the input reference", () => {
    const tools = [{ name: "bash" }];
    expect(injectToolBreakpoints(tools)).not.toBe(tools);
  });

  test("each item in the result is a shallow copy, not the original object", () => {
    const tools = [{ name: "bash" }, { name: "read_file" }];
    const result = injectToolBreakpoints(tools);
    expect(result[0]).not.toBe(tools[0]);
    expect(result[1]).not.toBe(tools[1]);
  });

  // ── Breakpoint placement ─────────────────────────────────────────────

  test("single tool — last (only) tool gets cache_control: ephemeral", () => {
    const tools = [{ name: "bash", description: "run shell commands" }];
    const result = injectToolBreakpoints(tools);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "bash",
      description: "run shell commands",
      cache_control: EPHEMERAL,
    });
  });

  test("two tools — only the last one gets cache_control", () => {
    const tools = [{ name: "bash" }, { name: "read_file" }];
    const result = injectToolBreakpoints(tools);
    expect(result[0]).not.toHaveProperty("cache_control");
    expect(result[1]).toMatchObject({ cache_control: EPHEMERAL });
  });

  test("multiple tools — only the last one gets cache_control", () => {
    const tools = [
      { name: "bash" },
      { name: "read_file" },
      { name: "write_file" },
      { name: "grep" },
    ];
    const result = injectToolBreakpoints(tools);
    expect(result[0]).not.toHaveProperty("cache_control");
    expect(result[1]).not.toHaveProperty("cache_control");
    expect(result[2]).not.toHaveProperty("cache_control");
    expect(result[3]).toMatchObject({ cache_control: EPHEMERAL });
  });

  // ── Mutation safety ──────────────────────────────────────────────────

  test("originals not mutated — no cache_control appears on source objects", () => {
    const tools = [{ name: "bash" }, { name: "read_file" }, { name: "write_file" }];
    injectToolBreakpoints(tools);
    for (const t of tools) {
      expect(t).not.toHaveProperty("cache_control");
    }
  });

  test("existing tool properties are preserved on all copied items", () => {
    const tools = [
      { name: "bash", input_schema: { type: "object", properties: {} } },
      { name: "read_file", input_schema: { type: "object", properties: {} } },
    ];
    const result = injectToolBreakpoints(tools);
    expect(result[0]).toMatchObject({ name: "bash", input_schema: { type: "object" } });
    expect(result[1]).toMatchObject({ name: "read_file", input_schema: { type: "object" } });
  });
});

// ── injectMessageBreakpoints ──────────────────────────────────────────

describe("injectMessageBreakpoints", () => {
  // ── Empty input ──────────────────────────────────────────────────────

  test("empty array — returns same reference (early-exit, no allocation)", () => {
    const msgs: ApiMessage[] = [];
    expect(injectMessageBreakpoints(msgs)).toBe(msgs);
  });

  // ── Return-value identity ────────────────────────────────────────────

  test("non-empty — returns a new array, not the input reference", () => {
    const msgs = [userMsg("hello")];
    expect(injectMessageBreakpoints(msgs)).not.toBe(msgs);
  });

  test("each message object in the result is a new object, not the original", () => {
    const msgs = [userMsg("ask"), assistantMsg("answer")];
    const result = injectMessageBreakpoints(msgs);
    expect(result[0]).not.toBe(msgs[0]);
    expect(result[1]).not.toBe(msgs[1]);
  });

  test("roles are preserved on all result messages", () => {
    const msgs = [userMsg("ask"), assistantMsg("answer"), userMsg("again")];
    const result = injectMessageBreakpoints(msgs);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
  });

  // ── Fresh breakpoint — always on the last message ────────────────────

  describe("fresh breakpoint — always placed on the last message", () => {
    test("single message with string content — converted to a single marked text block", () => {
      const msgs = [userMsg("hello world")];
      const result = injectMessageBreakpoints(msgs);
      const content = blocks(result[0]);
      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({
        type: "text",
        text: "hello world",
        cache_control: EPHEMERAL,
      });
    });

    test("single assistant message with string content — also converted", () => {
      const msgs = [assistantMsg("thinking out loud")];
      const result = injectMessageBreakpoints(msgs);
      const content = blocks(result[0]);
      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({
        type: "text",
        text: "thinking out loud",
        cache_control: EPHEMERAL,
      });
    });

    test("single message with one array block — that block gets cache_control", () => {
      const msgs = [userMsg([textBlock("hello")])];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[0])[0]).toMatchObject({
        type: "text",
        text: "hello",
        cache_control: EPHEMERAL,
      });
    });

    test("single message with multiple blocks — only the last block is marked", () => {
      const msgs = [userMsg([textBlock("first"), textBlock("second"), textBlock("third")])];
      const result = injectMessageBreakpoints(msgs);
      const content = blocks(result[0]);
      expect(content[0]).not.toHaveProperty("cache_control");
      expect(content[1]).not.toHaveProperty("cache_control");
      expect(content[2]).toMatchObject({ cache_control: EPHEMERAL });
    });

    test("last message with empty array content — no crash, content stays empty", () => {
      const msgs = [userMsg("text"), assistantMsg([])];
      expect(() => injectMessageBreakpoints(msgs)).not.toThrow();
      const result = injectMessageBreakpoints(msgs);
      expect(result[1].content).toEqual([]);
    });

    test("fresh breakpoint applies to last message regardless of its role", () => {
      // Last message is assistant
      const msgs = [userMsg("ask"), assistantMsg([textBlock("answer")])];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[1])[0]).toMatchObject({ cache_control: EPHEMERAL });
    });

    test("fresh marks the very last block of a multi-block last message", () => {
      const msgs = [
        userMsg([textBlock("context"), textBlock("the actual question")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      const content = blocks(result[0]);
      expect(content[0]).not.toHaveProperty("cache_control");
      expect(content[1]).toMatchObject({ type: "text", text: "the actual question", cache_control: EPHEMERAL });
    });
  });

  // ── Stable breakpoint — second-to-last user message (length >= 3) ────

  describe("stable breakpoint — second-to-last user message (only when length >= 3)", () => {
    test("one message — no stable breakpoint (length < 3)", () => {
      const msgs = [userMsg([textBlock("solo")])];
      const result = injectMessageBreakpoints(msgs);
      // Only one block; it gets fresh. No stable placed (not enough messages).
      // Verify that exactly one message is touched with cache_control.
      expect(blocks(result[0])[0]).toMatchObject({ cache_control: EPHEMERAL });
    });

    test("two messages [user, assistant] — no stable breakpoint placed", () => {
      const msgs = [userMsg("ask"), assistantMsg("answer")];
      const result = injectMessageBreakpoints(msgs);
      // Fresh: last message (index 1) gets marked.
      // Stable: NOT placed (length < 3). First message should remain unchanged.
      expect(result[0].content).toBe("ask"); // still a string — not converted
    });

    test("[user, assistant, user] — fresh on last (index 2), stable on first (index 0)", () => {
      const msgs = [
        userMsg([textBlock("first ask")]),
        assistantMsg([textBlock("first answer")]),
        userMsg([textBlock("second ask")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[2])[0]).toMatchObject({ cache_control: EPHEMERAL });   // fresh
      expect(blocks(result[0])[0]).toMatchObject({ cache_control: EPHEMERAL });   // stable
      expect(blocks(result[1])[0]).not.toHaveProperty("cache_control");           // untouched
    });

    test("[user, assistant, user, assistant, user] — fresh on index 4, stable on index 2", () => {
      const msgs = [
        userMsg([textBlock("q1")]),
        assistantMsg([textBlock("a1")]),
        userMsg([textBlock("q2")]),
        assistantMsg([textBlock("a2")]),
        userMsg([textBlock("q3")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[4])[0]).toMatchObject({ cache_control: EPHEMERAL });   // fresh
      expect(blocks(result[2])[0]).toMatchObject({ cache_control: EPHEMERAL });   // stable
      expect(blocks(result[0])[0]).not.toHaveProperty("cache_control");
      expect(blocks(result[1])[0]).not.toHaveProperty("cache_control");
      expect(blocks(result[3])[0]).not.toHaveProperty("cache_control");
    });

    test("three consecutive user messages — stable on middle (index 1), fresh on last (index 2)", () => {
      const msgs = [
        userMsg([textBlock("q1")]),
        userMsg([textBlock("q2")]),
        userMsg([textBlock("q3")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[2])[0]).toMatchObject({ cache_control: EPHEMERAL });   // fresh
      expect(blocks(result[1])[0]).toMatchObject({ cache_control: EPHEMERAL });   // stable
      expect(blocks(result[0])[0]).not.toHaveProperty("cache_control");
    });

    test("[user, user, assistant] — stable on first user (index 0), fresh on last assistant", () => {
      const msgs = [
        userMsg([textBlock("q1")]),
        userMsg([textBlock("q2")]),
        assistantMsg([textBlock("answer")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[2])[0]).toMatchObject({ cache_control: EPHEMERAL });   // fresh (assistant)
      expect(blocks(result[0])[0]).toMatchObject({ cache_control: EPHEMERAL });   // stable (first user)
      expect(blocks(result[1])[0]).not.toHaveProperty("cache_control");
    });

    test("only one user in 3+ message array — findSecondLastUserMessage returns -1, no stable", () => {
      // [assistant, assistant, user] — only one user message exists
      const msgs = [
        assistantMsg([textBlock("a1")]),
        assistantMsg([textBlock("a2")]),
        userMsg([textBlock("q1")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[2])[0]).toMatchObject({ cache_control: EPHEMERAL });   // fresh only
      expect(blocks(result[0])[0]).not.toHaveProperty("cache_control");
      expect(blocks(result[1])[0]).not.toHaveProperty("cache_control");
    });

    test("no user messages in 3+ message array — neither fresh nor stable mark a user block", () => {
      const msgs = [
        assistantMsg([textBlock("a1")]),
        assistantMsg([textBlock("a2")]),
        assistantMsg([textBlock("a3")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      expect(blocks(result[2])[0]).toMatchObject({ cache_control: EPHEMERAL });   // fresh on last
      expect(blocks(result[0])[0]).not.toHaveProperty("cache_control");
      expect(blocks(result[1])[0]).not.toHaveProperty("cache_control");
    });

    test("stable marks only the last block of a multi-block second-to-last user message", () => {
      const msgs = [
        userMsg([textBlock("context"), textBlock("question")]),
        assistantMsg([textBlock("answer")]),
        userMsg([textBlock("follow-up")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      const stableContent = blocks(result[0]);
      expect(stableContent[0]).not.toHaveProperty("cache_control");          // not the first block
      expect(stableContent[1]).toMatchObject({ cache_control: EPHEMERAL });  // last block marked
    });

    test("stable on second-to-last user with string content — converted to marked array", () => {
      const msgs = [
        userMsg("first question"),
        assistantMsg([textBlock("answer")]),
        userMsg([textBlock("follow-up")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      // result[0] was a string; markLastBlock should have converted it to an array.
      expect(Array.isArray(result[0].content)).toBe(true);
      expect(blocks(result[0])[0]).toMatchObject({
        type: "text",
        text: "first question",
        cache_control: EPHEMERAL,
      });
    });
  });

  // ── Mutation safety ───────────────────────────────────────────────────

  describe("mutation safety — originals never modified", () => {
    test("original messages with string content stay as strings after injection", () => {
      const msgs = [
        userMsg("hello"),
        assistantMsg("world"),
        userMsg("again"),
      ];
      injectMessageBreakpoints(msgs);
      expect(msgs[0].content).toBe("hello");
      expect(msgs[1].content).toBe("world");
      expect(msgs[2].content).toBe("again");
    });

    test("original content blocks in array messages are not mutated", () => {
      const block1 = textBlock("first question");
      const block2 = textBlock("answer");
      const block3 = textBlock("second question");
      const msgs = [
        userMsg([block1]),
        assistantMsg([block2]),
        userMsg([block3]),
      ];
      injectMessageBreakpoints(msgs);
      expect(block1).not.toHaveProperty("cache_control");
      expect(block2).not.toHaveProperty("cache_control");
      expect(block3).not.toHaveProperty("cache_control");
    });

    test("original message objects' content property is not reassigned", () => {
      // Even if the result message has string-to-array conversion,
      // the original message.content must remain the original value.
      const msgs = [
        userMsg("q1"),
        assistantMsg("a1"),
        userMsg("q2"),
      ];
      const originalContents = msgs.map(m => m.content);
      injectMessageBreakpoints(msgs);
      msgs.forEach((m, i) => expect(m.content).toBe(originalContents[i]));
    });

    test("result blocks are independent shallow copies — mutating result does not affect originals", () => {
      const block = textBlock("hello");
      const msgs = [userMsg([block])];
      const result = injectMessageBreakpoints(msgs);
      const resultBlock = blocks(result[0])[0] as Record<string, unknown>;
      resultBlock.arbitrary_extra = "mutated";
      expect(block).not.toHaveProperty("arbitrary_extra");
    });

    test("mutating result message object does not affect original message", () => {
      const msgs = [userMsg("text")];
      const result = injectMessageBreakpoints(msgs);
      (result[0] as unknown as Record<string, unknown>).extra = "injected";
      expect(msgs[0]).not.toHaveProperty("extra");
    });
  });

  // ── Multi-round tool-use cascade ──────────────────────────────────────

  describe("multi-round tool-use cascade", () => {
    test("tool_result user messages count as user messages for the stable breakpoint", () => {
      // Round 1: user asks → assistant uses tool → tool_result message (role: user) → assistant replies
      // Round 2: user follows up
      // Stable should land on the tool_result message (second-to-last user).
      const toolResultBlock: ApiContentBlock = {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "ls output",
      };
      const msgs: ApiMessage[] = [
        userMsg([textBlock("run ls")]),
        assistantMsg([{ type: "tool_use", id: "tool_1", name: "bash", input: { cmd: "ls" } }]),
        { role: "user", content: [toolResultBlock] },       // tool_result container (user role)
        assistantMsg([textBlock("done, here is the output")]),
        userMsg([textBlock("thanks")]),
      ];
      const result = injectMessageBreakpoints(msgs);
      // Fresh: result[4] (user "thanks")
      expect(blocks(result[4])[0]).toMatchObject({ cache_control: EPHEMERAL });
      // Stable: result[2] (tool_result user message — second-to-last user)
      expect(blocks(result[2])[0]).toMatchObject({ cache_control: EPHEMERAL });
      // Untouched
      expect(blocks(result[0])[0]).not.toHaveProperty("cache_control");
      expect(blocks(result[1])[0]).not.toHaveProperty("cache_control");
      expect(blocks(result[3])[0]).not.toHaveProperty("cache_control");
    });

    test("stable breakpoint from this round will be the anchor for the next round", () => {
      // Simulate what happens when this result is fed back as the new input
      // for a subsequent round: the previously-fresh last message becomes
      // the new second-to-last user, and a new user message is appended.
      const msgs: ApiMessage[] = [
        userMsg([textBlock("q1")]),
        assistantMsg([textBlock("a1")]),
        userMsg([textBlock("q2")]),
      ];
      const round1 = injectMessageBreakpoints(msgs);
      // Simulate the new round: append a new user message
      const round2Input: ApiMessage[] = [
        ...round1.map(m => ({
          role: m.role,
          // Strip cache_control for clean input (as the agent loop would do)
          content: typeof m.content === "string"
            ? m.content
            : (m.content as ApiContentBlock[]).map(b => {
                const { cache_control: _, ...rest } = b as Record<string, unknown>;
                return rest as ApiContentBlock;
              }),
        })),
        userMsg([textBlock("q3")]),
      ];
      const round2 = injectMessageBreakpoints(round2Input);
      // Fresh: last message (q3) at index 3
      expect(blocks(round2[3])[0]).toMatchObject({ cache_control: EPHEMERAL });
      // Stable: second-to-last user message — q2 at index 2
      expect(blocks(round2[2])[0]).toMatchObject({ cache_control: EPHEMERAL });
    });
  });
});
