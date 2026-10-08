import { expect, test } from "bun:test";
import { summarizeLoopRounds, type LoopRoundRecord } from "./model-loop-summary";

function round(n: number): LoopRoundRecord {
  return {
    conversationId: "c", turnId: "t", round: n, pid: 123, outcome: "continue",
    startedAtMonotonicMs: 1000 + n * 100,
    checkpoints: [
      { phase: "provider_start", atMs: 1 }, { phase: "request_sent", atMs: 3 },
      { phase: "first_response", atMs: 5 }, { phase: "first_output", atMs: 10 },
      { phase: "provider_end", atMs: 60 }, { phase: "tools_start", atMs: 61 },
      { phase: "tools_end", atMs: 90 }, { phase: "recovery_committed", atMs: 92 },
    ],
  };
}

test("handoff spans tool completion through next round's actual transport submission", () => {
  const summary = summarizeLoopRounds([round(1), round(0)]);
  expect(summary[0].toolToNextRequestMs).toBe(13);
  expect(summary[0].requestSetupMs).toBe(2);
  expect(summary[0].toolsMs).toBe(29);
  expect(summary[0].sentToFirstOutputMs).toBe(7);
  expect(summary[1].toolToNextRequestMs).toBeNull();
});

test("missing transport data, retries, separate turns and restarts are not clean samples", () => {
  const first = round(0);
  first.checkpoints.push({ phase: "retry", atMs: 40 });
  const second = round(1);
  second.pid = 456;
  const summary = summarizeLoopRounds([first, second]);
  expect(summary[0].requestSetupMs).toBeNull();
  expect(summary[0].toolToNextRequestMs).toBeNull();
  second.pid = first.pid;
  second.turnId = "another";
  expect(summarizeLoopRounds([first, second]).every(row => row.toolToNextRequestMs == null)).toBe(true);
  first.checkpoints = [];
  expect(summarizeLoopRounds([first])[0].sentToFirstResponseMs).toBeNull();
});

test("response acknowledgement and hidden output progress are not assistant-text TTFT", () => {
  const record = round(0);
  let summary = summarizeLoopRounds([record])[0];
  expect(summary.sentToFirstResponseMs).toBe(2);
  expect(summary.sentToFirstOutputMs).toBe(7);
  expect(summary.sentToFirstTextMs).toBeNull();
  expect(summary.sentToFirstThinkingMs).toBeNull();
  record.checkpoints.push({ phase: "first_thinking", atMs: 15 }, { phase: "first_text", atMs: 35 });
  summary = summarizeLoopRounds([record])[0];
  expect(summary.sentToFirstThinkingMs).toBe(12);
  expect(summary.sentToFirstTextMs).toBe(32);
  record.checkpoints.push({ phase: "retry", atMs: 40 });
  expect(summarizeLoopRounds([record])[0].sentToFirstTextMs).toBeNull();
});
