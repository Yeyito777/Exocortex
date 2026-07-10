import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bash, executeBashBackgroundable, intentionalBackgroundTaskStopPidsForTest, spillAndPreviewForTest } from "./bash";
import type { BackgroundTaskCompletion } from "./types";

function makeLargeOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    lines.push(`line ${i.toString().padStart(4, "0")} ${"x".repeat(80)}`);
  }
  return lines.join("\n");
}

describe("bash spill preview", () => {
  test("includes spill path instructions when temp write succeeds", () => {
    const written: Array<{ path: string; contents: string }> = [];
    const output = spillAndPreviewForTest(makeLargeOutput(), false, (path, contents) => {
      written.push({ path, contents });
    });

    expect(written).toHaveLength(1);
    expect(output).toContain("Full output: ");
    expect(output).toContain("Use the read tool with offset/limit to browse.");
    expect(output).toContain("lines omitted");
  });

  test("honors a smaller inline output budget", () => {
    const written: Array<{ path: string; contents: string }> = [];
    const full = makeLargeOutput();
    const output = spillAndPreviewForTest(full, false, (path, contents) => {
      written.push({ path, contents });
    }, 4_000);

    expect(written).toHaveLength(1);
    expect(written[0].contents).toBe(full);
    expect(output.length).toBeLessThan(6_000);
    expect(output).toContain("Full output: ");
    expect(output).toContain("line 0000");
    expect(output).toContain("line 0599");
  });

  test("degrades gracefully when temp write fails", () => {
    const output = spillAndPreviewForTest(makeLargeOutput(), true, () => {
      throw new Error("EDQUOT: quota exceeded");
    });

    expect(output).toContain("Full output could not be written to a temp file");
    expect(output).toContain("EDQUOT: quota exceeded");
    expect(output).toContain("byte-truncated at 1MB");
    expect(output).not.toContain("Use the read tool with offset/limit to browse.");
  });
});

describe("bash inline output budget", () => {
  test("spills medium output at the default budget", async () => {
    const result = await executeBashBackgroundable(
      { command: "yes x | head -c 13000" },
      undefined,
      60_000,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Full output: ");
    expect(result.output).toContain("Use the read tool with offset/limit to browse.");
  });

  test("allows larger inline output when max_output_chars is raised", async () => {
    const result = await executeBashBackgroundable(
      { command: "yes x | head -c 13000", max_output_chars: 20_000 },
      undefined,
      60_000,
    );

    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("Full output: ");
    expect(result.output.length).toBe(13_000);
  });
});

describe("bash manual backgrounding", () => {
  test("registered backgrounder resolves a running command immediately", async () => {
    let background: (() => boolean) | null = null;

    const promise = executeBashBackgroundable(
      { command: "echo start; sleep 0.2; echo done", await: 60 },
      undefined,
      60_000,
      {
        toolCallId: "call-bash-1",
        registerBackgrounder: (backgrounder) => {
          background = backgrounder?.background ?? null;
        },
      },
    );

    for (let i = 0; i < 20 && !background; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(background).toBeTruthy();
    expect(background!()).toBe(true);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Command backgrounded on user request");
    expect(result.output).toContain("Output is being written to:");
    expect(background).toBeNull();

    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    expect(spillPath).toBeTruthy();

    await new Promise(resolve => setTimeout(resolve, 300));
    const spilled = readFileSync(spillPath!, "utf8");
    expect(spilled).toContain("start");
    expect(spilled).toContain("done");
  });
});

describe("bash explicit backgrounding", () => {
  test("background=true returns immediately while output continues into the spill file", async () => {
    const markerPath = join(tmpdir(), `exocortex-bash-background-marker-${process.pid}-${Date.now()}`);
    const promise = executeBashBackgroundable({
      command: `printf 'start\\n'; sleep 0.3; printf 'done\\n'; touch '${markerPath}'`,
      background: true,
    }, undefined, 60_000);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Command backgrounded immediately by request");
    expect(result.output).toContain("Output is being written to:");
    expect(existsSync(markerPath)).toBe(false);

    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    expect(spillPath).toBeTruthy();

    for (let i = 0; i < 50 && !existsSync(markerPath); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(markerPath)).toBe(true);
    let spilled = "";
    for (let i = 0; i < 50; i++) {
      spilled = existsSync(spillPath!) ? readFileSync(spillPath!, "utf8") : "";
      if (spilled.includes("done")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(spilled).toContain("start");
    expect(spilled).toContain("done");

    rmSync(markerPath, { force: true });
    rmSync(spillPath!, { force: true });
  });

  test("reports the detached process lifecycle to its conversation context", async () => {
    const activity: Array<{ id: string; active: boolean; details?: { title: string; startedAt: number } }> = [];
    const completions: BackgroundTaskCompletion[] = [];
    const result = await executeBashBackgroundable({
      command: "sleep 0.1",
      background: true,
    }, undefined, 60_000, {
      conversationId: "parent-conversation",
      setBackgroundTaskActive: (id, active, details) => activity.push({ id, active, details }),
      onBackgroundTaskComplete: (completion) => completions.push(completion),
    });

    expect(result.isError).toBe(false);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      active: true,
      details: { title: "sleep 0.1", startedAt: expect.any(Number) },
    });
    expect(activity[0].id).toMatch(/^bash:\d+$/);

    for (let i = 0; i < 50 && activity.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(activity).toEqual([
      { id: activity[0].id, active: true, details: activity[0].details },
      { id: activity[0].id, active: false, details: undefined },
    ]);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      taskId: activity[0].id,
      toolName: "bash",
      title: "sleep 0.1",
      exitCode: 0,
      signal: null,
      outputPath: expect.any(String),
    });
    expect(completions[0].endedAt).toBeGreaterThanOrEqual(completions[0].startedAt);

    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    if (spillPath) rmSync(spillPath, { force: true });
  });

  test("does not notify the model about a background task it deliberately stops", async () => {
    const completions: BackgroundTaskCompletion[] = [];
    const activity: boolean[] = [];
    const context = {
      conversationId: "intentional-stop-conversation",
      setBackgroundTaskActive: (_id: string, active: boolean) => activity.push(active),
      onBackgroundTaskComplete: (completion: BackgroundTaskCompletion) => completions.push(completion),
    };
    const background = await executeBashBackgroundable({
      command: "sleep 30",
      background: true,
    }, undefined, 60_000, context);
    const pid = Number(background.output.match(/PID (\d+)/)?.[1]);
    const spillPath = background.output.match(/Output is being written to: (\S+)/)?.[1];

    expect(pid).toBeGreaterThan(0);
    const stopped = await executeBashBackgroundable({ command: `kill ${pid}` }, undefined, 60_000, context);
    expect(stopped.isError).toBe(false);

    for (let index = 0; index < 50 && !activity.includes(false); index++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(activity).toEqual([true, false]);
    expect(completions).toHaveLength(0);
    if (spillPath) rmSync(spillPath, { force: true });
  });

  test("rejects conflicting background and await parameters before spawning", async () => {
    const result = await executeBashBackgroundable({
      command: "echo should-not-run",
      background: true,
      await: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot be combined");
  });

  test("directs await=0 callers to the explicit background parameter", async () => {
    const result = await executeBashBackgroundable({ command: "echo should-not-run", await: 0 });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Use 'background: true'");
  });

  test("exposes and summarizes the background flag", () => {
    expect((bash.inputSchema.properties as Record<string, unknown>).background).toBeDefined();
    expect(bash.summarize({ command: "sleep 30", background: true }).detail).toBe("sleep 30 --background");
  });
});

describe("bash intentional background-task stop detection", () => {
  test("recognizes direct kill commands and signal variants", () => {
    expect(intentionalBackgroundTaskStopPidsForTest("kill 1234")).toEqual([1234]);
    expect(intentionalBackgroundTaskStopPidsForTest("kill -TERM 1234; rm -f output.tmp")).toEqual([1234]);
    expect(intentionalBackgroundTaskStopPidsForTest("/bin/kill -9 1234 5678")).toEqual([1234, 5678]);
    expect(intentionalBackgroundTaskStopPidsForTest("kill -- -1234")).toEqual([1234]);
    expect(intentionalBackgroundTaskStopPidsForTest("taskkill /T /F /PID 1234")).toEqual([1234]);
  });

  test("does not treat status probes or incidental text as stop commands", () => {
    expect(intentionalBackgroundTaskStopPidsForTest("kill -0 1234 && echo running || echo exited")).toEqual([]);
    expect(intentionalBackgroundTaskStopPidsForTest("echo kill 1234")).toEqual([]);
  });
});
