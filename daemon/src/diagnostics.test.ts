import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
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
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "summary", is_error: false }] },
      ],
      {
        text: "done",
        thinking: "",
        stopReason: "stop",
        blocks: [{ type: "text", text: "done" }],
        toolCalls: [{ id: "call_2", name: "bash", input: { command: "true" } }],
        inputTokens: 100,
        cachedInputTokens: 75,
        outputTokens: 5,
        requestDiagnostics: { usedIncremental: true, incrementalInputItems: 1, fullInputItems: 4 },
      },
      { source: "conversation", conversationId: "conv-1" },
    );

    const [record] = readDiagnostics("model-requests");
    expect(record.type).toBe("model_request");
    expect(record.provider).toBe("openai");
    expect(record.conversationId).toBe("conv-1");
    expect(record.cachedInputTokens).toBe(75);
    expect(record.uncachedInputTokens).toBe(25);
    expect(record.cacheHitRatio).toBe(0.75);
    expect(record.toolCallsRequested).toEqual(["bash"]);
    expect(record.toolResultsIncluded).toEqual([{ callId: "call_1", name: "context", outputChars: 7, outputBytes: 7, isError: false }]);
    expect(record.usedIncremental).toBe(true);
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
  });
});

