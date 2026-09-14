import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execCommand, writeStdin, unifiedExecInternalsForTest as internals } from "./unified-exec";
import { readBackgroundTaskRecord, removeBackgroundTaskRecord } from "../background-task-state";
import { beginDaemonShutdown, resetDaemonShutdownModeForTest } from "../daemon-lifecycle";
import type { BackgroundTaskCompletion, ToolExecutionContext } from "./types";
import { waitForConversationTask } from "../conversation-activity";

const context: ToolExecutionContext = { conversationId: "unified-exec-test", provider: "openai", cwd: tmpdir() };
const run = (cmd: string, extra: Record<string, unknown> = {}, ctx = context, signal?: AbortSignal) => execCommand.execute({ cmd, shell: "/bin/bash", login: false, yield_time_ms: 1000, ...extra }, ctx, signal);

afterAll(async () => {
  internals.stopAll();
  await Promise.all([...internals.sessions.values()].map(s => s.done));
  await Promise.all([...internals.sessions.values()].map(s => rm(s.outputPath, { force: true })));
});

describe.skipIf(process.platform === "win32")("Codex unified exec", () => {
  test("returns exit status, stderr, and output with explicit working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-exec-"));
    try {
      const result = await run("pwd; printf problem >&2; exit 7", { workdir: dir });
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.output);
      expect(body.exit_code).toBe(7);
      expect(body.session_id).toBeUndefined();
      expect(body.output).toContain(dir);
      expect(body.output).toContain("problem");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("supports incremental stdin, ownership checks, task tracking, recovery, and final output", async () => {
    const activities: Array<{ id: string; active: boolean }> = [];
    const completions: BackgroundTaskCompletion[] = [];
    const ctx = { ...context, setBackgroundTaskActive: (id: string, active: boolean) => { activities.push({ id, active }); }, onBackgroundTaskComplete: (done: BackgroundTaskCompletion) => { completions.push(done); } };
    const initial = await run("read -r first; printf 'first:%s\\n' \"$first\"; read -r second; printf 'second:%s\\n' \"$second\"", { yield_time_ms: 0 }, ctx);
    expect(initial.isError).toBe(false);
    const body = JSON.parse(initial.output);
    const session = internals.sessions.get(body.session_id)!;
    expect(session).toBeDefined();
    expect(readBackgroundTaskRecord(session.recordPath!)?.toolName).toBe("exec_command");
    expect(activities).toContainEqual({ id: body.task_id, active: true });
    const forbidden = await writeStdin.execute({ session_id: body.session_id, chars: "wrong\n" }, { conversationId: "other" });
    expect(forbidden.isError).toBe(true);
    const first = await writeStdin.execute({ session_id: body.session_id, chars: "one\n", yield_time_ms: 100 }, ctx);
    expect(JSON.parse(first.output).output).toContain("first:one");
    const second = await writeStdin.execute({ session_id: body.session_id, chars: "two\n", yield_time_ms: 1000 }, ctx);
    const final = JSON.parse(second.output);
    expect(final.exit_code).toBe(0);
    expect(final.output).toContain("second:two");
    expect(final.output).not.toContain("first:one");
    expect(completions).toHaveLength(0); // collected directly, not a duplicate notification
    expect(await waitForConversationTask(body.task_id)).toMatchObject({
      status: "completed", exitCode: 0, outputPath: session.outputPath,
    });
    expect(activities.at(-1)).toEqual({ id: body.task_id, active: false });
    expect((await writeStdin.execute({ session_id: body.session_id, chars: "late\n" }, ctx)).isError).toBe(true);
    const finished = await writeStdin.execute({ session_id: body.session_id, yield_time_ms: 0 }, ctx);
    expect(JSON.parse(finished.output).exit_code).toBe(0);
  });

  test("allocates a real PTY and supports interactive input", async () => {
    const initial = await run("test -t 0 && printf 'PTY-ready\\n'; read -r value; printf 'got:%s\\n' \"$value\"", { tty: true, yield_time_ms: 100 });
    expect(initial.isError).toBe(false);
    const body = JSON.parse(initial.output);
    expect(body.output).toContain("PTY-ready");
    const response = await writeStdin.execute({ session_id: body.session_id, chars: "hello\n", yield_time_ms: 1000 }, context);
    expect(response.isError).toBe(false);
    expect(JSON.parse(response.output).exit_code).toBe(0);
    expect(JSON.parse(response.output).output).toContain("got:hello");
  });

  test("notifies about unobserved completion and stops exact tasks through their callback", async () => {
    const completions: BackgroundTaskCompletion[] = [];
    let stopTask: ((suppress: boolean) => boolean) | undefined;
    const ctx: ToolExecutionContext = { ...context,
      onBackgroundTaskComplete: value => { completions.push(value); },
      setBackgroundTaskActive: (_id, active, details) => { if (active) stopTask = details?.stop; },
    };
    const first = JSON.parse((await run(`read -r value; ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 30)'`, { yield_time_ms: 0 }, ctx)).output);
    await writeStdin.execute({ session_id: first.session_id, chars: "finish\n", yield_time_ms: 0 }, ctx);
    await internals.sessions.get(first.session_id)!.done;
    expect(completions).toHaveLength(1);
    expect(completions[0].exitCode).toBe(0);

    const second = JSON.parse((await run("read -r forever", { yield_time_ms: 0 }, ctx)).output);
    expect(stopTask?.(true)).toBe(true);
    await internals.sessions.get(second.session_id)!.done;
    expect(internals.sessions.get(second.session_id)!.closed).toBe(true);
    expect(completions).toHaveLength(1); // intentional-stop notification suppressed
  });

  test("validates parameters before spawning or sending input", async () => {
    const count = internals.sessions.size;
    for (const extra of [{ yield_time_ms: -1 }, { max_output_tokens: 0 }, { tty: "true" }, { sandbox_permissions: "require_escalated" }]) {
      expect((await run("touch should-not-run", extra)).isError).toBe(true);
    }
    expect(internals.sessions.size).toBe(count);
  });

  test("preserves completed task records for restart handoff", async () => {
    const completions: BackgroundTaskCompletion[] = [];
    const ctx = { ...context, onBackgroundTaskComplete: (value: BackgroundTaskCompletion) => { completions.push(value); } };
    const initial = JSON.parse((await run("read -r value; printf done", { yield_time_ms: 0 }, ctx)).output);
    const session = internals.sessions.get(initial.session_id)!;
    try {
      beginDaemonShutdown("restart");
      session.runner.stdin.write(JSON.stringify({ type: "input", chars: "finish\n" }) + "\n");
      await session.done;
      expect(completions).toHaveLength(0);
      expect(readBackgroundTaskRecord(session.recordPath!)?.state).toBe("completed");
      expect(readBackgroundTaskRecord(session.recordPath!)?.completion?.exitCode).toBe(0);
    } finally {
      resetDaemonShutdownModeForTest();
      removeBackgroundTaskRecord(session.recordPath!);
    }
  });

  test.skipIf(process.platform !== "linux")("runner failure kills its detached command and retains recovery evidence", async () => {
    const initial = JSON.parse((await run(`${JSON.stringify(process.execPath)} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`, { yield_time_ms: 100 })).output);
    const session = internals.sessions.get(initial.session_id)!;
    try {
      session.runner.kill("SIGKILL");
      await session.done;
      expect(session.runnerFailed).toBe(true);
      expect(readBackgroundTaskRecord(session.recordPath!)).not.toBeNull();
      await new Promise(resolve => setTimeout(resolve, 350)); // process-group SIGKILL grace period
      const stat = await readFile(`/proc/${session.pid}/stat`, "utf8").catch(() => "");
      expect(stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
    } finally { removeBackgroundTaskRecord(session.recordPath!); }
  });

  test("output budget spills without discarding the full captured output", async () => {
    const result = await run("printf '%1000s' x", { max_output_tokens: 20 });
    const body = JSON.parse(result.output);
    expect(body.truncated).toBe(true);
    expect(body.output.length).toBeLessThanOrEqual(80);
    expect((await readFile(body.output_path, "utf8")).length).toBe(1000);
  });

  test("abort stops an active process rather than leaving it waiting for input", async () => {
    const controller = new AbortController();
    const pending = run("read -r forever", { yield_time_ms: 30_000 }, context, controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try { expect((await pending).isError).toBe(true); } finally { clearTimeout(timer); }
    const session = [...internals.sessions.values()].at(-1)!;
    await session.done;
    expect(session.closed).toBe(true);
  });
});
