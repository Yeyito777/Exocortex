import { describe, expect, test } from "bun:test";
import { interruptedRunWorkTimer } from "./work-timer";
import { CONTEXT_COMPACTION_FINISHED_KIND, createMessageMetadata, type StoredMessage } from "./messages";

const ai = (startedAt: number, endedAt: number | null, workTimerStartedAt: number | null = startedAt): StoredMessage => ({
  role: "assistant", content: "answer",
  metadata: { ...createMessageMetadata(startedAt, "gpt-5.5", { endedAt }), ...(workTimerStartedAt === null ? {} : { workTimerStartedAt }) },
});
const user = (): StoredMessage => ({
  role: "user", content: "request", metadata: createMessageMetadata(0, "gpt-5.5"),
});

describe("work timer", () => {
  test("passes isolated daemon lifecycle checks", () => {
    const child = Bun.spawnSync([process.execPath, "test", `${import.meta.dir}/work-timer-integration.cases.ts`], {
      cwd: `${import.meta.dir}/..`, env: process.env, stdout: "pipe", stderr: "pipe",
      timeout: 60_000, killSignal: "SIGKILL",
    });
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
  });

  test("a replay after a restart continues the interrupted run without charging the downtime", () => {
    // 110 s of work in the run before the daemon went down at 134 s.
    expect(interruptedRunWorkTimer([user(), ai(100_000, 134_000, 24_000)], 200_000)).toBe(90_000);
    // Tool results and notices between the work and the replay change nothing.
    expect(interruptedRunWorkTimer([
      user(), ai(100_000, 134_000, 24_000),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }], metadata: null },
      { role: "system", content: "notice", metadata: null },
    ], 200_000)).toBe(90_000);
    // A compaction that finished the interrupted work carries its timer too.
    expect(interruptedRunWorkTimer([user(), {
      role: "system", content: "Compaction finished",
      metadata: { ...createMessageMetadata(120_000, "gpt-5.5", { endedAt: 134_000 }), workTimerStartedAt: 24_000, kind: CONTEXT_COMPACTION_FINISHED_KIND },
    }], 200_000)).toBe(90_000);
  });

  test("a replay starts a fresh timer when the interrupted turn left no work to continue", () => {
    expect(interruptedRunWorkTimer([], 200_000)).toBe(200_000);
    // Died before its first output: never continue the previous run instead.
    expect(interruptedRunWorkTimer([ai(0, 134_000), user()], 200_000)).toBe(200_000);
    // History from before work timers, or work that never ended.
    expect(interruptedRunWorkTimer([user(), ai(100_000, 134_000, null)], 200_000)).toBe(200_000);
    expect(interruptedRunWorkTimer([user(), ai(100_000, null)], 200_000)).toBe(200_000);
  });
});
