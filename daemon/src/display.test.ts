/**
 * Tests for display.ts — buildDisplayData.
 *
 * Covers all block types, the tool-result folding logic, system message
 * color assignment, image extraction, multi-turn interleaving, metadata
 * propagation, and edge cases.
 */

import { describe, test, expect } from "bun:test";
import { buildDisplayData } from "./display";
import type { StoredMessage, ApiContentBlock } from "./messages";
import type { MessageMetadata } from "./messages";
import type { ToolSummarizerFn } from "./display";

// ── Test helpers ────────────────────────────────────────────────────

/** Default summarizer for tests: detail = JSON.stringify(input). */
const summarizer: ToolSummarizerFn = (name, input) => ({
  label: name,
  detail: JSON.stringify(input),
});

/** Summarizer that returns an empty detail string to exercise the label fallback. */
const labelOnlySummarizer: ToolSummarizerFn = (name, _input) => ({
  label: name,
  detail: "",
});

/** Convenience: build with default convId / model / effort / fastMode / no contextTokens. */
function build(
  messages: StoredMessage[],
  opts?: {
    convId?: string;
    contextTokens?: number | null;
    sum?: ToolSummarizerFn;
  },
) {
  return buildDisplayData(
    opts?.convId ?? "conv-1",
    "anthropic",
    "sonnet",
    "high",
    false,
    messages,
    opts?.contextTokens ?? null,
    opts?.sum ?? summarizer,
  );
}

/** Typed helper so TypeScript infers discriminated union correctly. */
function aiEntry(entry: ReturnType<typeof build>["entries"][number]) {
  if (entry.type !== "ai") throw new Error(`Expected ai entry, got ${entry.type}`);
  return entry;
}

function userEntry(entry: ReturnType<typeof build>["entries"][number]) {
  if (entry.type !== "user") throw new Error(`Expected user entry, got ${entry.type}`);
  return entry;
}

function systemEntry(entry: ReturnType<typeof build>["entries"][number]) {
  if (entry.type !== "system") throw new Error(`Expected system entry, got ${entry.type}`);
  return entry;
}

// ── Metadata ────────────────────────────────────────────────────────

const META: MessageMetadata = {
  startedAt: 1_000_000,
  endedAt: 1_001_000,
  model: "sonnet",
  tokens: 42,
};

// ── buildDisplayData — top-level shape ─────────────────────────────

describe("buildDisplayData — return shape", () => {
  test("passes through convId, model, effort, contextTokens", () => {
    const result = buildDisplayData("my-conv", "anthropic", "haiku", "low", false, [], 77_000, summarizer);
    expect(result.convId).toBe("my-conv");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("haiku");
    expect(result.effort).toBe("low");
    expect(result.contextTokens).toBe(77_000);
  });

  test("contextTokens null when not provided", () => {
    const result = build([]);
    expect(result.contextTokens).toBeNull();
  });

  test("empty messages → empty entries", () => {
    expect(build([]).entries).toHaveLength(0);
  });
});

// ── User messages ───────────────────────────────────────────────────

describe("user messages", () => {
  test("plain string content → user entry with text", () => {
    const { entries } = build([{ role: "user", content: "Hello!", metadata: null }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ type: "user", text: "Hello!" });
  });

  test("array content without tool_results or images → JSON.stringify fallback", () => {
    const content: ApiContentBlock[] = [{ type: "text", text: "hi" }];
    const { entries } = build([{ role: "user", content, metadata: null }]);
    expect(entries).toHaveLength(1);
    expect(userEntry(entries[0]).text).toBe(JSON.stringify(content));
  });

  test("user message with image → extracts text and image", () => {
    const b64 = "aGVsbG8="; // base64("hello") — 8 chars, 1 padding → sizeBytes = 5
    const content: ApiContentBlock[] = [
      { type: "text", text: "Look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
    ];
    const { entries } = build([{ role: "user", content, metadata: null }]);
    expect(entries).toHaveLength(1);
    const u = userEntry(entries[0]);
    expect(u.text).toBe("Look at this");
    expect(u.images).toHaveLength(1);
    expect(u.images![0]).toEqual({ mediaType: "image/png", base64: b64, sizeBytes: 5 });
  });

  test("user message with image only (no text) → text is empty string", () => {
    const b64 = "Zm9v"; // base64("foo") — 4 chars, 0 padding → sizeBytes = 3
    const content: ApiContentBlock[] = [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
    ];
    const { entries } = build([{ role: "user", content, metadata: null }]);
    const u = userEntry(entries[0]);
    expect(u.text).toBe("");
    expect(u.images).toHaveLength(1);
    expect(u.images![0].sizeBytes).toBe(3);
  });

  test("user message with image: sizeBytes accounts for double-padding ==", () => {
    const b64 = "dGVzdA=="; // base64("test") — 8 chars, 2 padding → sizeBytes = 4
    const content: ApiContentBlock[] = [
      { type: "image", source: { type: "base64", media_type: "image/gif", data: b64 } },
    ];
    const { entries } = build([{ role: "user", content, metadata: null }]);
    expect(userEntry(entries[0]).images![0].sizeBytes).toBe(4);
  });

  test("user message with multiple images → images array preserved in order", () => {
    const b64a = "Zm9v"; // 3 bytes
    const b64b = "YmFy"; // base64("bar") — 4 chars, 0 padding → 3 bytes
    const content: ApiContentBlock[] = [
      { type: "text", text: "two pics" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64a } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64b } },
    ];
    const { entries } = build([{ role: "user", content, metadata: null }]);
    const u = userEntry(entries[0]);
    expect(u.images).toHaveLength(2);
    expect(u.images![0].mediaType).toBe("image/png");
    expect(u.images![1].mediaType).toBe("image/jpeg");
  });

  test("user message flushes a pending ai entry first", () => {
    const msgs: StoredMessage[] = [
      { role: "assistant", content: "partial AI", metadata: null },
      { role: "user", content: "hello", metadata: null },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("ai");
    expect(entries[1].type).toBe("user");
  });
});

// ── Assistant messages ──────────────────────────────────────────────

describe("assistant messages", () => {
  test("string content → ai entry with single text block", () => {
    const { entries } = build([{ role: "assistant", content: "World", metadata: null }]);
    expect(entries).toHaveLength(1);
    const ai = aiEntry(entries[0]);
    expect(ai.blocks).toEqual([{ type: "text", text: "World" }]);
    expect(ai.metadata).toBeNull();
  });

  test("array content with text block → text block in ai entry", () => {
    const content: ApiContentBlock[] = [{ type: "text", text: "Array text" }];
    const { entries } = build([{ role: "assistant", content, metadata: null }]);
    const ai = aiEntry(entries[0]);
    expect(ai.blocks).toEqual([{ type: "text", text: "Array text" }]);
  });

  test("thinking block → thinking block type with thinking text", () => {
    const content: ApiContentBlock[] = [
      { type: "thinking", thinking: "Let me reason...", signature: "sig-xyz" },
      { type: "text", text: "Conclusion" },
    ];
    const { entries } = build([{ role: "assistant", content, metadata: null }]);
    const ai = aiEntry(entries[0]);
    expect(ai.blocks).toHaveLength(2);
    expect(ai.blocks[0]).toEqual({ type: "thinking", text: "Let me reason..." });
    expect(ai.blocks[1]).toEqual({ type: "text", text: "Conclusion" });
  });

  test("tool_use block → tool_call block with summarizer result", () => {
    const input = { command: "ls -la" };
    const content: ApiContentBlock[] = [
      { type: "tool_use", id: "tu-abc", name: "bash", input },
    ];
    const { entries } = build([{ role: "assistant", content, metadata: null }]);
    const ai = aiEntry(entries[0]);
    expect(ai.blocks).toHaveLength(1);
    expect(ai.blocks[0]).toEqual({
      type: "tool_call",
      toolCallId: "tu-abc",
      toolName: "bash",
      input,
      summary: JSON.stringify(input), // detail is non-empty → used
    });
  });

  test("tool_use summary: uses detail when non-empty", () => {
    const input = { path: "/tmp/f" };
    const content: ApiContentBlock[] = [
      { type: "tool_use", id: "tu-1", name: "read", input },
    ];
    const { entries } = build([{ role: "assistant", content, metadata: null }]);
    expect(aiEntry(entries[0]).blocks[0]).toMatchObject({
      summary: JSON.stringify(input),
    });
  });

  test("tool_use summary: falls back to label when detail is empty string", () => {
    const content: ApiContentBlock[] = [
      { type: "tool_use", id: "tu-1", name: "glob", input: { pattern: "*.ts" } },
    ];
    const { entries } = build(
      [{ role: "assistant", content, metadata: null }],
      { sum: labelOnlySummarizer },
    );
    expect(aiEntry(entries[0]).blocks[0]).toMatchObject({ summary: "glob" });
  });

  test("summarizer is called with correct name and input", () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const trackingSummarizer: ToolSummarizerFn = (name, input) => {
      calls.push({ name, input });
      return { label: name, detail: "" };
    };
    const input = { q: "foo" };
    const content: ApiContentBlock[] = [
      { type: "tool_use", id: "tu-1", name: "search", input },
    ];
    build([{ role: "assistant", content, metadata: null }], { sum: trackingSummarizer });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: "search", input });
  });

  test("metadata is stamped on the ai entry", () => {
    const { entries } = build([{ role: "assistant", content: "Hi", metadata: META }]);
    expect(aiEntry(entries[0]).metadata).toEqual(META);
  });

  test("metadata null when assistant message has no metadata", () => {
    const { entries } = build([{ role: "assistant", content: "Hi", metadata: null }]);
    expect(aiEntry(entries[0]).metadata).toBeNull();
  });

  test("consecutive assistant messages → merged into a single ai entry", () => {
    const meta2: MessageMetadata = { startedAt: 2_000, endedAt: 3_000, model: "sonnet", tokens: 99 };
    const msgs: StoredMessage[] = [
      { role: "assistant", content: "Part A", metadata: META },
      { role: "assistant", content: "Part B", metadata: meta2 },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(1);
    const ai = aiEntry(entries[0]);
    expect(ai.blocks).toHaveLength(2);
    expect(ai.blocks[0]).toEqual({ type: "text", text: "Part A" });
    expect(ai.blocks[1]).toEqual({ type: "text", text: "Part B" });
    // Last metadata wins
    expect(ai.metadata).toEqual(meta2);
  });

  test("assistant message flushes ai entry when a user message follows", () => {
    const msgs: StoredMessage[] = [
      { role: "assistant", content: "answer", metadata: null },
      { role: "user", content: "follow-up", metadata: null },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("ai");
    expect(entries[1].type).toBe("user");
  });
});

// ── Tool-result folding ─────────────────────────────────────────────

describe("tool-result folding", () => {
  test("user tool_result following assistant tool_use → folded into same ai entry", () => {
    const msgs: StoredMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "bash", input: { cmd: "ls" } }],
        metadata: null,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "file1\nfile2", is_error: false },
        ],
        metadata: null,
      },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(1);
    const ai = aiEntry(entries[0]);
    expect(ai.blocks).toHaveLength(2);
    expect(ai.blocks[0].type).toBe("tool_call");
    expect(ai.blocks[1]).toEqual({
      type: "tool_result",
      toolCallId: "tu-1",
      toolName: "",
      output: "file1\nfile2",
      isError: false,
    });
  });

  test("tool_result with is_error: true → isError: true on block", () => {
    const msgs: StoredMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "bash", input: {} }],
        metadata: null,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "Permission denied", is_error: true },
        ],
        metadata: null,
      },
    ];
    const { entries } = build(msgs);
    const block = aiEntry(entries[0]).blocks[1];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.isError).toBe(true);
      expect(block.output).toBe("Permission denied");
    }
  });

  test("tool_result with is_error missing → isError: false", () => {
    const msgs: StoredMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "bash", input: {} }],
        metadata: null,
      },
      {
        role: "user",
        // Omit is_error entirely
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" } as ApiContentBlock],
        metadata: null,
      },
    ];
    const { entries } = build(msgs);
    const block = aiEntry(entries[0]).blocks[1];
    if (block.type === "tool_result") {
      expect(block.isError).toBe(false);
    }
  });

  test("tool_result content as array of text parts → joined with newline", () => {
    const msgs: StoredMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "bash", input: {} }],
        metadata: null,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: [
              { type: "text", text: "line1" },
              { type: "text", text: "line2" },
            ],
            is_error: false,
          },
        ],
        metadata: null,
      },
    ];
    const { entries } = build(msgs);
    const block = aiEntry(entries[0]).blocks[1];
    if (block.type === "tool_result") {
      expect(block.output).toBe("line1\nline2");
    }
  });

  test("tool_result content array: non-text parts are filtered out", () => {
    const msgs: StoredMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "bash", input: {} }],
        metadata: null,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: [
              { type: "text", text: "stdout" },
              { type: "image", data: "img-data" }, // non-text, filtered
            ] as unknown[],
            is_error: false,
          },
        ],
        metadata: null,
      },
    ];
    const { entries } = build(msgs);
    const block = aiEntry(entries[0]).blocks[1];
    if (block.type === "tool_result") {
      expect(block.output).toBe("stdout");
    }
  });

  test("mixed tool_result + text in user message → all folded (context-pressure hint)", () => {
    const msgs: StoredMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "bash", input: {} }],
        metadata: null,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "output", is_error: false },
          { type: "text", text: "⚠ Context usage: 85%" },
        ],
        metadata: null,
      },
    ];
    const { entries } = build(msgs);
    // Still one entry — everything folded
    expect(entries).toHaveLength(1);
    const ai = aiEntry(entries[0]);
    // tool_call + tool_result + text
    expect(ai.blocks).toHaveLength(3);
    expect(ai.blocks[1].type).toBe("tool_result");
    expect(ai.blocks[2]).toEqual({ type: "text", text: "⚠ Context usage: 85%" });
  });

  test("orphaned tool_result (no preceding assistant) → falls through to user entry", () => {
    const content: ApiContentBlock[] = [
      { type: "tool_result", tool_use_id: "tu-orphan", content: "orphan", is_error: false },
    ];
    const { entries } = build([{ role: "user", content, metadata: null }]);
    expect(entries).toHaveLength(1);
    // No currentAI → falls through to the final user entry path (JSON.stringify)
    expect(userEntry(entries[0]).text).toBe(JSON.stringify(content));
  });

  test("subsequent assistant after tool round-trip → merged into same ai entry", () => {
    // user → assistant(tool_use) → user(tool_result) → assistant(text)
    const meta: MessageMetadata = { startedAt: 1000, endedAt: 2000, model: "sonnet", tokens: 50 };
    const msgs: StoredMessage[] = [
      { role: "user", content: "Run ls", metadata: null },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running now." },
          { type: "tool_use", id: "tu-1", name: "bash", input: { cmd: "ls" } },
        ],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "a.txt", is_error: false }],
        metadata: null,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        metadata: meta,
      },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(2); // user + one merged ai
    const ai = aiEntry(entries[1]);
    expect(ai.blocks).toHaveLength(4); // text + tool_call + tool_result + text
    expect(ai.blocks[0]).toEqual({ type: "text", text: "Running now." });
    expect(ai.blocks[1].type).toBe("tool_call");
    expect(ai.blocks[2].type).toBe("tool_result");
    expect(ai.blocks[3]).toEqual({ type: "text", text: "Done." });
    expect(ai.metadata).toEqual(meta);
  });
});

// ── System messages ─────────────────────────────────────────────────

describe("system messages", () => {
  test("content starting with ⟳ → color: warning", () => {
    const { entries } = build([
      { role: "system", content: "⟳ Retrying (attempt 2/3)…", metadata: null },
    ]);
    expect(entries).toHaveLength(1);
    expect(systemEntry(entries[0])).toEqual({
      type: "system",
      text: "⟳ Retrying (attempt 2/3)…",
      color: "warning",
    });
  });

  test("content not starting with ⟳ → color: error", () => {
    const { entries } = build([
      { role: "system", content: "API error: rate limit exceeded", metadata: null },
    ]);
    expect(systemEntry(entries[0])).toEqual({
      type: "system",
      text: "API error: rate limit exceeded",
      color: "error",
    });
  });

  test("system message flushes a pending ai entry", () => {
    const msgs: StoredMessage[] = [
      { role: "assistant", content: "thinking...", metadata: null },
      { role: "system", content: "Stream interrupted", metadata: null },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("ai");
    expect(entries[1].type).toBe("system");
  });

  test("system message after user message", () => {
    const msgs: StoredMessage[] = [
      { role: "user", content: "hello", metadata: null },
      { role: "system", content: "⟳ Resuming…", metadata: null },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("user");
    expect(entries[1]).toEqual({ type: "system", text: "⟳ Resuming…", color: "warning" });
  });

  test("system message with array content → JSON.stringify text", () => {
    const content: ApiContentBlock[] = [{ type: "text", text: "system detail" }];
    const { entries } = build([{ role: "system", content, metadata: null }]);
    expect(systemEntry(entries[0]).text).toBe(JSON.stringify(content));
    expect(systemEntry(entries[0]).color).toBe("error"); // JSON.stringify doesn't start with ⟳
  });

  test("system message between two ai turns → entries in order", () => {
    const msgs: StoredMessage[] = [
      { role: "assistant", content: "a1", metadata: null },
      { role: "system", content: "notice", metadata: null },
      { role: "assistant", content: "a2", metadata: null },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("ai");
    expect(entries[1].type).toBe("system");
    expect(entries[2].type).toBe("ai");
  });
});

// ── Multi-turn interleaving ─────────────────────────────────────────

describe("multi-turn interleaving", () => {
  test("user → ai → user → ai produces 4 entries in correct order", () => {
    const msgs: StoredMessage[] = [
      { role: "user", content: "Q1", metadata: null },
      { role: "assistant", content: "A1", metadata: null },
      { role: "user", content: "Q2", metadata: null },
      { role: "assistant", content: "A2", metadata: META },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ type: "user", text: "Q1" });
    expect(aiEntry(entries[1]).blocks).toEqual([{ type: "text", text: "A1" }]);
    expect(entries[2]).toEqual({ type: "user", text: "Q2" });
    const ai2 = aiEntry(entries[3]);
    expect(ai2.blocks).toEqual([{ type: "text", text: "A2" }]);
    expect(ai2.metadata).toEqual(META);
  });

  test("two complete agentic tool-use turns interleaved correctly", () => {
    // Turn 1: user → assistant(tool_use) → user(tool_result) → assistant(text)
    // Turn 2: user → assistant(text)
    const msgs: StoredMessage[] = [
      { role: "user", content: "First question", metadata: null },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "bash", input: {} }],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "result1", is_error: false }],
        metadata: null,
      },
      { role: "assistant", content: "Answer 1", metadata: null },
      { role: "user", content: "Second question", metadata: null },
      { role: "assistant", content: "Answer 2", metadata: META },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(4); // user + ai-with-tools + user + ai
    expect(entries[0]).toEqual({ type: "user", text: "First question" });
    const ai1 = aiEntry(entries[1]);
    expect(ai1.blocks).toHaveLength(3); // tool_call + tool_result + text
    expect(entries[2]).toEqual({ type: "user", text: "Second question" });
    expect(aiEntry(entries[3]).blocks).toEqual([{ type: "text", text: "Answer 2" }]);
  });

  test("ai entry produced at end of messages (flushAI)", () => {
    // Trailing assistant message at end of message list must be flushed
    const msgs: StoredMessage[] = [
      { role: "user", content: "ping", metadata: null },
      { role: "assistant", content: "pong", metadata: null },
    ];
    const { entries } = build(msgs);
    expect(entries).toHaveLength(2);
    expect(entries[1].type).toBe("ai");
  });
});

// ── Block order preservation ────────────────────────────────────────

describe("block ordering within an ai entry", () => {
  test("mixed thinking + text + tool_use preserved in source order", () => {
    const input = { x: 1 };
    const content: ApiContentBlock[] = [
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "text", text: "I'll use a tool." },
      { type: "tool_use", id: "tu-1", name: "bash", input },
    ];
    const { entries } = build([{ role: "assistant", content, metadata: null }]);
    const blocks = aiEntry(entries[0]).blocks;
    expect(blocks[0]).toEqual({ type: "thinking", text: "hmm" });
    expect(blocks[1]).toEqual({ type: "text", text: "I'll use a tool." });
    expect(blocks[2]).toMatchObject({ type: "tool_call", toolName: "bash" });
  });

  test("multiple tool_use blocks each get their own tool_call block", () => {
    const content: ApiContentBlock[] = [
      { type: "tool_use", id: "tu-1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_use", id: "tu-2", name: "read", input: { path: "/etc/hosts" } },
    ];
    const { entries } = build([{ role: "assistant", content, metadata: null }]);
    const blocks = aiEntry(entries[0]).blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "tool_call", toolCallId: "tu-1", toolName: "bash" });
    expect(blocks[1]).toMatchObject({ type: "tool_call", toolCallId: "tu-2", toolName: "read" });
  });
});
