import { expect, test } from "bun:test";
import { readOpenAIEventsForTest } from "./stream";

function replay(events: Record<string, unknown>[], reference = false) {
  const emitted: unknown[] = [];
  const result = readOpenAIEventsForTest(events, {
    onText: text => emitted.push(["text", text]),
    onThinking: text => emitted.push(["thinking", text]),
    onBlockStart: type => emitted.push(["start", type]),
    onBlocksUpdate: blocks => emitted.push(["sync", structuredClone(blocks)]),
  }, reference);
  return { emitted, result };
}

test("tail fast paths match canonical rebuild for randomized parts, order, corrections and raw/summary switches", () => {
  let seed = 12345;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sample = 0; sample < 100; sample++) {
    const events: Record<string, unknown>[] = [
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "m" } },
      { type: "response.output_item.added", output_index: 2, item: { type: "reasoning", id: "r2" } },
    ];
    const values = ["hello", " ", "", "**Heading**", "<!-- -->", "\n", "world", "**Heading**\n<!-- -->"];
    for (let i = 0; i < 100; i++) {
      const output_index = random(3);
      const reasoning = output_index !== 1;
      const kind = reasoning ? (random(2) ? "reasoning_summary_text" : "reasoning_text") : "output_text";
      const done = random(4) === 0;
      events.push({
        type: `response.${kind}.${done ? "done" : "delta"}`, output_index,
        content_index: [0, 1, 2, -1, 0.5][random(5)], summary_index: [0, 1, 2, -1, 0.5][random(5)],
        [done ? "text" : "delta"]: values[random(values.length)],
      });
    }
    events.push({ type: "response.completed", response: { output: [] } });
    expect(replay(events)).toEqual(replay(events, true));
  }
});

test("published canonical sync snapshots remain immutable after later tail appends", () => {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m" } },
    { type: "response.output_text.delta", output_index: 0, delta: "old" },
    { type: "response.output_text.done", output_index: 0, text: "new" },
    { type: "response.output_text.delta", output_index: 0, delta: " tail" },
  ];
  let snapshot: any;
  const result = readOpenAIEventsForTest(events, { onBlocksUpdate: blocks => { snapshot = blocks; } });
  expect(snapshot).toEqual([{ type: "text", text: "new" }]);
  expect(result.text).toBe("new tail");
});
