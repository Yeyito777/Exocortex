import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("automatic context compaction failure", () => {
  test("warns and continues the turn instead of failing it", async () => {
    const daemonDir = resolve(import.meta.dir, "..");
    const child = Bun.spawn([process.execPath, "run", "src/auto-compaction-recovery-check.ts"], {
      cwd: daemonDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DEEPSEEK_API_KEY: "test-auto-compaction-key" },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const output = stdout.trim().split("\n").at(-1);
    expect(output).toBeTruthy();
    const result = JSON.parse(output!);

    expect(result.outcome).toEqual({ ok: true, error: null });
    expect(result.compactionCalls).toBe(1);
    expect(result.conversationCalls).toBe(1);
    expect(result.warnings).toEqual([
      expect.stringContaining("Automatic context compaction failed; continuing without it. Plaintext compaction did not complete"),
    ]);
    expect(result.transcriptWarning).toBe(true);
    expect(JSON.stringify(result.lastUser)).toContain("new request");
    expect(JSON.stringify(result.lastAssistant)).toContain("answered anyway");
    expect(result.activeContext).toBeNull();
    expect(result.streaming).toBe(false);
  });
});
