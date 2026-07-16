import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

interface ManualCompactionCheckResult {
  outcome: { ok: boolean; blocks: unknown[]; tokens: number };
  providerCalls: number;
  providerTrackingSource: string | null;
  visibleAssistantMessages: number;
  completionMarker: boolean;
  activeContext: {
    kind?: string;
    provider?: string;
    compactionCount?: number;
    transcriptHistoryCount?: number;
    hasCheckpoint: boolean;
  };
  lastContextTokens: number | null;
  streaming: boolean;
  eventTypes: string[];
  completedStatus: boolean;
  historyUpdates: number;
  onCompleteCalls: number;
}

describe("manual conversation compaction", () => {
  test("installs one checkpoint without requesting an assistant response", async () => {
    const daemonDir = resolve(import.meta.dir, "..");
    const child = Bun.spawn([process.execPath, "run", "src/manual-compaction-check.ts"], {
      cwd: daemonDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DEEPSEEK_API_KEY: "test-manual-compaction-key" },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const output = stdout.trim().split("\n").at(-1);
    expect(output).toBeTruthy();
    const result = JSON.parse(output!) as ManualCompactionCheckResult;

    expect(result.outcome).toMatchObject({ ok: true, blocks: [], tokens: 0 });
    expect(result.providerCalls).toBe(1);
    expect(result.providerTrackingSource).toBe("context_compaction");
    expect(result.visibleAssistantMessages).toBe(1);
    expect(result.completionMarker).toBe(true);
    expect(result.activeContext).toEqual({
      kind: "plaintext",
      provider: "deepseek",
      compactionCount: 1,
      transcriptHistoryCount: 2,
      hasCheckpoint: true,
    });
    expect(result.lastContextTokens).toBeNull();
    expect(result.streaming).toBe(false);
    expect(result.eventTypes).toEqual(expect.arrayContaining([
      "streaming_started",
      "context_compaction_status",
      "streaming_stopped",
    ]));
    expect(result.eventTypes).not.toContain("message_complete");
    expect(result.completedStatus).toBe(true);
    expect(result.historyUpdates).toBe(1);
    expect(result.onCompleteCalls).toBe(1);
  });
});
