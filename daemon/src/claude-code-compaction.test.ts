import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

async function runCheck(scenario: "resumed" | "fresh") {
  const daemonDir = resolve(import.meta.dir, "..");
  const child = Bun.spawn([process.execPath, "run", "src/claude-code-compaction-check.ts", scenario], {
    cwd: daemonDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const output = stdout.trim().split("\n").at(-1);
  expect(output).toBeTruthy();
  return JSON.parse(output!);
}

describe("Claude Code context compaction", () => {
  test("a resumed Claude Code session compacts itself; Exocortex does not pre-empt it", async () => {
    const result = await runCheck("resumed");
    expect(result.outcome).toEqual({ ok: true, error: null });
    expect(result.compactionCalls).toBe(0);
    expect(result.conversationCalls).toBe(1);
    expect(result.activeContextKind).toBeNull();
    // Claude Code's own compaction is shown, with its real token counts.
    const notice = "Claude Code automatically compacted its context (968,000 → 41,000 tokens).";
    expect(result.notices).toContain(notice);
    expect(result.transcriptNotices).toContain(notice);
    expect(result.contextUpdates).toContain(41_000);
    // A turn that moved to another Claude account says so, live and in the transcript.
    const switchNotice = 'Claude account switched from "main" to "max2": "main" is at a usage limit.';
    expect(result.notices).toContain(switchNotice);
    expect(result.transcriptNotices).toContain(switchNotice);
    expect(JSON.stringify(result.lastAssistant)).toContain("answered");
  }, 30_000);

  test("history a fresh Claude Code session must receive as one prompt is still compacted first", async () => {
    const result = await runCheck("fresh");
    expect(result.outcome).toEqual({ ok: true, error: null });
    expect(result.compactionCalls).toBeGreaterThanOrEqual(1);
    expect(result.conversationCalls).toBe(1);
    expect(result.activeContextKind).toBe("plaintext");
    expect(JSON.stringify(result.lastAssistant)).toContain("answered");
  }, 30_000);
});
