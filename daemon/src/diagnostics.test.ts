import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { diagnosticsDir } from "@exocortex/shared/paths";
import { recordModelRequestDiagnostics, recordToolCallDiagnostics, resetDiagnosticsForTest } from "./diagnostics";

function readDiagnostics(kind: "model-requests" | "tool-calls"): Array<Record<string, unknown>> {
  const dir = join(diagnosticsDir(), kind);
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  return files.flatMap((file) => readFileSync(join(dir, file), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>));
}

describe("diagnostics", () => {
  beforeEach(() => resetDiagnosticsForTest());
  afterEach(() => resetDiagnosticsForTest());

  test("appends model request diagnostics with cache and tool-result metadata", () => {
    recordModelRequestDiagnostics(
      "openai",
      "gpt-5.4",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "context", input: { action: "summarize" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "context failed: missing reference", is_error: true }] },
      ],
      {
        text: "done",
        thinking: "",
        stopReason: "stop",
        blocks: [{ type: "text", text: "done" }],
        toolCalls: [{ id: "call_2", name: "bash", input: { command: "true" } }],
        inputTokens: 100,
        cachedInputTokens: 75,
        cacheMissInputTokens: 20,
        outputTokens: 5,
        billingServiceTier: "fast",
        requestDiagnostics: { usedIncremental: true, incrementalInputItems: 1, fullInputItems: 4 },
      },
      { source: "conversation", conversationId: "conv-1" },
    );

    const [record] = readDiagnostics("model-requests");
    expect(record.version).toBe(2);
    expect(record.type).toBe("model_request");
    expect(record.provider).toBe("openai");
    expect(record.conversationId).toBe("conv-1");
    expect(record.cachedInputTokens).toBe(75);
    expect(record.cacheMissInputTokens).toBe(20);
    expect(record.uncachedInputTokens).toBe(5);
    expect(record.unmeasuredInputTokens).toBe(0);
    expect(record.cacheHitRatio).toBe(0.75);
    expect(record.billingServiceTier).toBe("fast");
    expect(record.pricing).toBeNull();
    expect(record.toolCallsRequested).toEqual(["bash"]);
    expect(record.toolResultsIncluded).toEqual([{
      callId: "call_1",
      name: "context",
      outputChars: 33,
      outputBytes: 33,
      isError: true,
      errorReason: "context failed: missing reference",
      errorReasonTruncated: false,
    }]);
    expect(record.toolResultsIncludedCount).toBe(1);
    expect(record.toolResultsIncludedOmitted).toBe(0);
    expect(record.usedIncremental).toBe(true);
  });

  test("records only newly introduced tool results and bounds their per-request list", () => {
    const historical = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "old", name: "read", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "old", content: "old output" }] },
    ];
    const newMessages = Array.from({ length: 40 }, (_, index) => ({
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: `new-${index}`, content: `output-${index}` }],
    }));
    recordModelRequestDiagnostics(
      "openai",
      "gpt-5.4",
      [...historical, ...newMessages],
      { text: "done", thinking: "", stopReason: "stop", blocks: [], toolCalls: [] },
      undefined,
      newMessages,
    );

    const [record] = readDiagnostics("model-requests");
    expect(record.toolResultsIncludedCount).toBe(40);
    expect(record.toolResultsIncludedOmitted).toBe(8);
    expect(record.toolResultsIncluded).toHaveLength(32);
    expect((record.toolResultsIncluded as Array<{ callId: string }>)[0].callId).toBe("new-8");
    expect((record.toolResultsIncluded as Array<{ callId: string }>).some(result => result.callId === "old")).toBe(false);
  });

  test("removes expired daily diagnostics during the next append", () => {
    const dir = join(diagnosticsDir(), "model-requests");
    mkdirSync(dir, { recursive: true });
    const expired = join(dir, "main-2000-01-01.jsonl");
    writeFileSync(expired, "{}\n");

    recordModelRequestDiagnostics(
      "openai",
      "gpt-5.4",
      [],
      { text: "done", thinking: "", stopReason: "stop", blocks: [], toolCalls: [] },
    );

    expect(existsSync(expired)).toBe(false);
  });

  test("appends one tool-call diagnostics row per tool result", () => {
    recordToolCallDiagnostics({
      conversationId: "conv-1",
      round: 2,
      calls: [{ id: "call_1", name: "grep", input: { pattern: "cache" } }],
      results: [{ toolCallId: "call_1", toolName: "grep", output: "match", isError: false }],
      batchDurationMs: 42,
    });

    const [record] = readDiagnostics("tool-calls");
    expect(record.type).toBe("tool_call");
    expect(record.toolName).toBe("grep");
    expect(record.round).toBe(2);
    expect(record.outputChars).toBe(5);
    expect(record.batchDurationMs).toBe(42);
    expect(String(record.inputHash)).toStartWith("sha256:");
    expect(String(record.outputHash)).toStartWith("sha256:");
    expect(record.errorReason).toBeUndefined();
  });

  test("stores bounded error reasons for failed tool-call diagnostics", () => {
    const longReason = `failed: ${"x".repeat(2_500)}`;
    recordToolCallDiagnostics({
      conversationId: "conv-1",
      round: 3,
      calls: [{ id: "call_1", name: "bash", input: { command: "exit 1" } }],
      results: [{ toolCallId: "call_1", toolName: "bash", output: longReason, isError: true }],
      batchDurationMs: 7,
    });

    const [record] = readDiagnostics("tool-calls");
    expect(record.isError).toBe(true);
    expect(record.errorReason).toBe(longReason.slice(0, 2_000));
    expect(record.errorReasonTruncated).toBe(true);
  });
});
