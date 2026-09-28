import { describe, expect, test } from "bun:test";
import { workTimerForTurn } from "./work-timer";
import { CONTEXT_COMPACTION_FINISHED_KIND, createMessageMetadata, USER_MESSAGE_AUTOMATION_KINDS, type StoredMessage } from "./messages";

const ai = (startedAt: number, endedAt: number, workTimerStartedAt = startedAt): StoredMessage => ({
  role: "assistant", content: "answer",
  metadata: { ...createMessageMetadata(startedAt, "gpt-5.5", { endedAt }), workTimerStartedAt },
});
const user = (): StoredMessage => ({
  role: "user", content: "request", metadata: createMessageMetadata(0, "gpt-5.5"),
});

describe("work stretch timer", () => {
  test("passes isolated daemon lifecycle checks", () => {
    const child = Bun.spawnSync([process.execPath, "test", `${import.meta.dir}/work-timer-integration.cases.ts`], {
      cwd: `${import.meta.dir}/..`, env: process.env, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
  });
  test("starts with the request and resets on a new human message, even within the buffer", () => {
    expect(workTimerForTurn([], 0)).toBe(0);
    expect(workTimerForTurn([ai(0, 134_000), user()], 137_000)).toBe(137_000);
  });

  test.each([...USER_MESSAGE_AUTOMATION_KINDS])("does not reset for %s", (kind) => {
    const notification = user();
    notification.metadata!.automation = { kind };
    const origin = workTimerForTurn([ai(0, 134_000), notification], 137_000);
    expect(origin).toBe(3_000);
    // 134 seconds of earlier work plus 40 seconds now, excluding the idle gap.
    expect(177_000 - origin).toBe(174_000);
  });

  test("continues across compaction, system notices, tool results and metadata-free rounds", () => {
    expect(workTimerForTurn([
      ai(0, 134_000),
      { role: "system", content: "Compaction finished", metadata: null },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }], metadata: null },
      { role: "assistant", content: "partial", metadata: null },
    ], 137_000)).toBe(3_000);
  });

  test("preserves accumulated time through repeated continuations and persistence", () => {
    const previous = ai(137_000, 177_000, 3_000);
    expect(workTimerForTurn(JSON.parse(JSON.stringify([previous])), 180_000)).toBe(6_000);
    expect(220_000 - workTimerForTurn([previous], 180_000)).toBe(214_000);
  });

  test("a long standalone compaction is work, not an idle gap", () => {
    expect(workTimerForTurn([
      ai(0, 134_000),
      { role: "system", content: "Compaction finished", metadata: {
        ...createMessageMetadata(737_000, "gpt-5.5", { endedAt: 737_000 }),
        workTimerStartedAt: 3_000, kind: CONTEXT_COMPACTION_FINISHED_KIND,
      } },
    ], 740_000)).toBe(6_000);
  });

  test("closes exactly at five idle minutes, not five minutes of work", () => {
    expect(workTimerForTurn([ai(0, 3_600_000)], 3_899_999)).toBe(299_999);
    expect(workTimerForTurn([ai(0, 3_600_000)], 3_900_000)).toBe(3_900_000);
    expect(workTimerForTurn([ai(0, 3_600_000)], 9_000_000)).toBe(9_000_000);
  });

  test("short replay/restart interruptions retain work, long interruptions do not", () => {
    const history: StoredMessage[] = [ai(0, 134_000), { role: "system", content: "✗ Daemon restarted", metadata: null }];
    expect(workTimerForTurn(history, 137_000)).toBe(3_000);
    expect(workTimerForTurn(history, 434_000)).toBe(434_000);
  });

  test("supports legacy metadata and guards against backwards clocks", () => {
    const previous = ai(0, 134_000);
    delete previous.metadata!.workTimerStartedAt;
    expect(workTimerForTurn([previous], 137_000)).toBe(3_000);
    expect(workTimerForTurn([previous], 133_000)).toBe(133_000);
  });
});
