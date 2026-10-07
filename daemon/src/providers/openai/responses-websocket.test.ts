import { describe, expect, test } from "bun:test";
import { codexRateLimitHeadersForTest, readOpenAIResponsesWebSocket } from "./responses-websocket";
import { readOpenAIEventsForTest } from "./stream";
import type { OpenAIWebSocketConnection } from "./websocket";
import { clearActiveJob, getStaleStreams, setActiveJob, touchActivity } from "../../streaming";

describe("OpenAI websocket rate-limit events", () => {
  test("preserves window duration metadata", () => {
    const headers = codexRateLimitHeadersForTest({
      type: "codex.rate_limits",
      rate_limits: {
        primary: {
          used_percent: 53,
          window_minutes: 10080,
          reset_at: 1784499577,
        },
        secondary: null,
      },
    });

    expect(headers).not.toBeNull();
    expect(headers!.get("x-codex-primary-used-percent")).toBe("53");
    expect(headers!.get("x-codex-primary-window-minutes")).toBe("10080");
    expect(headers!.get("x-codex-primary-reset-at")).toBe("1784499577");
    expect(headers!.get("x-codex-secondary-used-percent")).toBeNull();
  });
});

describe("OpenAI tool-input activity", () => {
  for (const [itemType, eventType] of [
    ["function_call", "response.function_call_arguments.delta"],
    ["custom_tool_call", "response.custom_tool_call_input.delta"],
  ] as const) {
    test(`${eventType} keeps the app watchdog fresh without emitting a partial call`, async () => {
      const convId = `ws-activity-${itemType}`;
      const originalNow = Date.now;
      let now = originalNow();
      let activity = 0;
      let visibleOutput = 0;
      let index = 0;
      let staleBeforeCompletion = true;
      const events = [
        { type: "response.created", response: { id: "synthetic-response" } },
        { type: "response.output_item.added", output_index: 0,
          item: { type: itemType, call_id: "call-1", name: "test-tool" } },
        ...Array.from({ length: 16 }, (_, i) => ({
          type: eventType, output_index: 0, delta: i === 0 ? '{"x":"' : i === 15 ? '"}' : "a",
        })),
        { type: "response.output_item.done", output_index: 0,
          item: { type: itemType, call_id: "call-1", name: "test-tool" } },
        { type: "response.completed", response: { output: [] } },
      ];
      const socket = {
        async sendText() {},
        async nextMessage(timeoutMs: number) {
          expect(timeoutMs).toBe(300_000);
          if (index >= 2 && index < 18) now += 60_000;
          if (index === 18) {
            staleBeforeCompletion = getStaleStreams().some(([id]) => id === convId);
          }
          return { type: "text", text: JSON.stringify(events[index++]) };
        },
      } as unknown as OpenAIWebSocketConnection;
      try {
        Date.now = () => now;
        setActiveJob(convId, new AbortController(), now);
        const result = await readOpenAIResponsesWebSocket(socket, {}, {
          onText() { visibleOutput++; },
          onThinking() { visibleOutput++; },
          onToolCall() { visibleOutput++; },
          onActivity() { activity++; touchActivity(convId); },
        }, { stallTimeoutMs: 300_000 });
        expect(activity).toBe(16);
        expect(visibleOutput).toBe(0);
        expect(staleBeforeCompletion).toBe(false);
        expect(result.toolCalls).toHaveLength(1);
      } finally {
        Date.now = originalNow;
        clearActiveJob(convId);
      }
    });

    test(`${eventType} does not count empty, whitespace, malformed, or orphan traffic as progress`, () => {
      let activity = 0;
      readOpenAIEventsForTest([
        { type: eventType, output_index: 99, delta: "orphan" },
        { type: "response.output_item.added", output_index: 0,
          item: { type: itemType, call_id: "call-1", name: "test-tool" } },
        { type: eventType, output_index: 0, delta: "" },
        { type: eventType, output_index: 0, delta: " \r\n\t" },
        { type: eventType, output_index: 0, delta: null },
        { type: eventType, output_index: 0, delta: 123 },
        { type: "response.in_progress" },
      ], { onActivity() { activity++; } });
      expect(activity).toBe(0);
    });
  }
});
