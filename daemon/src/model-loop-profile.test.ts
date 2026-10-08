import { expect, test } from "bun:test";
import { ModelLoopProfile } from "./model-loop-profile";

test("round checkpoints use a monotonic clock and never contain model/tool content", () => {
  let now = 100;
  let record: any;
  const profile = new ModelLoopProfile({ conversationId: "c", turnId: "t", round: 2, provider: "openai", model: "test" },
    () => now, value => { record = value; });
  now += 3;
  profile.mark("request_sent", { transport: "websocket", bytes: 123 });
  now += 2;
  profile.once("first_output");
  now += 1;
  profile.once("first_output");
  profile.mark("tools_end");
  now += 4;
  profile.finish("continue");
  expect(record.startedAtMonotonicMs).toBe(100);
  expect(record.checkpoints).toEqual([
    { phase: "request_sent", atMs: 3, transport: "websocket", bytes: 123 },
    { phase: "first_output", atMs: 5 },
    { phase: "tools_end", atMs: 6 },
    { phase: "round_end", atMs: 10 },
  ]);
  expect(record.outcome).toBe("continue");
  expect(record.turnId).toBe("t");
});
