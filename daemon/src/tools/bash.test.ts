import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runtimeDir } from "@exocortex/shared/paths";
import { spawn } from "child_process";
import { bash, executeBashBackgroundable, spillAndPreview } from "./bash";
import { setLoadedExternalToolsForTest } from "../external-tools";
import type { LoadedTool } from "../external-tools-types";

const isWindows = process.platform === "win32";

function platformCommand(posix: string, windows: string): string {
  return isWindows ? windows : posix;
}

const mediumOutputCommand = platformCommand(
  "yes x | head -c 13000",
  "[Console]::Write(('x' * 13000))",
);

function makeLargeOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    lines.push(`line ${i.toString().padStart(4, "0")} ${"x".repeat(80)}`);
  }
  return lines.join("\n");
}

describe("bash and external tools", () => {
  // Credentials used to be spliced into the command text after an external
  // tool's name. A comment apostrophe flipped the splicer's quote tracking,
  // so the token landed inside quoted data (files, commit messages).
  test.skipIf(isWindows)("runs commands mentioning an external tool exactly as written", async () => {
    const image = {
      manifest: { name: "image", bin: "./bin/image", systemHint: "", display: { label: "Image", color: "#fff" }, auth: { providers: ["openai"] } },
      binDir: "/nonexistent/bin", toolDir: "/nonexistent",
    } as unknown as LoadedTool;
    const restore = setLoadedExternalToolsForTest([image]);
    try {
      const command = "# Let's write the notes\necho 'x\nimage of a cat\n'";
      const result = await executeBashBackgroundable({ command });
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("image of a cat");
      expect(result.output).not.toContain("exocortex-auth");
    } finally {
      restore();
    }
  });
});

describe("bash timeouts longer than a timer can wait", () => {
  test.skipIf(isWindows)("a 30-day timeout lets the command finish instead of killing it at once", async () => {
    const result = await executeBashBackgroundable({ command: "sleep 0.3; echo finished", timeout_seconds: 30 * 86_400 }, undefined, 60_000, { cwd: tmpdir() });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("finished");
  }, 20_000);
});

describe("bash timeouts with escaped descendants", () => {
  test.skipIf(isWindows)("a timed-out command returns on time even when a setsid descendant holds its output open", async () => {
    const marker = `exo-setsid-${process.pid}-${Date.now()}`;
    const started = Date.now();
    try {
      const result = await executeBashBackgroundable(
        { command: `setsid bash -c 'exec -a ${marker} sleep 6' & sleep 100`, timeout_seconds: 1, await: 60 },
        undefined, 60_000, { cwd: tmpdir() },
      );
      expect(result.output).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      spawn("pkill", ["-f", marker]);
    }
  }, 20_000);

  // Under systemd each call is its own unit, stopped when its runner exits.
  test.skipIf(isWindows || !process.env.INVOCATION_ID)("abort ends the call's unit even when a setsid descendant holds its output open", async () => {
    const marker = `exo-setsid-abort-${process.pid}-${Date.now()}`;
    const units = () => Bun.spawnSync(["systemctl", "--user", "list-units", "--all", "--no-legend", "--plain", `exocortex-bash-${process.pid}-*`])
      .stdout.toString().trim().split("\n").filter(Boolean);
    const before = units().length;
    const controller = new AbortController();
    try {
      const pending = executeBashBackgroundable(
        { command: `setsid bash -c 'exec -a ${marker} sleep 30' & sleep 100`, await: 60 },
        controller.signal, 60_000, { cwd: tmpdir() },
      );
      await Bun.sleep(500);
      controller.abort();
      await pending;
      let after = units().length;
      for (let i = 0; i < 40 && after > before; i++) { await Bun.sleep(100); after = units().length; }
      expect(after).toBe(before);
    } finally {
      spawn("pkill", ["-f", marker]);
    }
  }, 20_000);
});

describe("backgrounded bash output", () => {
  async function capture(command: string, input: Record<string, unknown> = { background: true }) {
    const result = await executeBashBackgroundable({ command, ...input }, undefined, 60_000, { cwd: tmpdir() });
    const path = /Output is being written to: (\S+)/.exec(result.output)?.[1];
    expect(path).toBeDefined();
    let text = "";
    for (let i = 0; i < 600 && !text.includes("[process exited"); i++) {
      await Bun.sleep(100);
      text = existsSync(path!) ? readFileSync(path!, "utf8") : "";
    }
    rmSync(path!, { force: true });
    return { path: path!, text };
  }

  test.skipIf(isWindows)("is captured on disk, keeps the newest output past 64 MiB, and the process runs on", async () => {
    // ~110 MB of numbered lines: past the cap more than once.
    const { path, text } = await capture("seq 1 14000000; echo still-running");
    // Under the runtime directory (on disk in production; tests root it in a temp dir).
    expect(path.startsWith(join(runtimeDir(), "tool-output"))).toBe(true);
    const lines = text.split("\n");
    expect(lines[0]).toBe("[earlier output dropped: kept the last 32 MiB; the process keeps running]");
    // The kept part starts on a whole line and runs, in order, to the newest output.
    const first = Number(lines[1]);
    expect(first).toBeGreaterThan(1);
    expect(lines[2]).toBe(String(first + 1));
    expect(text).toContain("\n14000000\nstill-running\n");
    expect(text).toContain("[process exited successfully]");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1_048_576 + 200);
  }, 120_000);

  test.skipIf(isWindows)("output a backgrounded command writes under the cap is kept whole", async () => {
    const { text } = await capture("sleep 0.5; seq 1 1000");
    expect(text.startsWith("1\n2\n")).toBe(true);
    expect(text).toContain("\n1000\n");
    expect(text).not.toContain("earlier output dropped");
  }, 60_000);

  test.skipIf(isWindows)("foreground output keeps its 1 MB cap", async () => {
    const result = await executeBashBackgroundable({ command: "head -c 3000000 /dev/zero | tr '\\0' x" }, undefined, 60_000, { cwd: tmpdir() });
    expect(result.output).toContain("byte-truncated at 1MB");
    expect(result.output).not.toContain("earlier output dropped");
  }, 60_000);
});

describe("bash spill preview", () => {
  test("includes spill path instructions when temp write succeeds", () => {
    const written: Array<{ path: string; contents: string }> = [];
    const output = spillAndPreview(makeLargeOutput(), false, (path, contents) => {
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
    const output = spillAndPreview(full, false, (path, contents) => {
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
    const output = spillAndPreview(makeLargeOutput(), true, () => {
      throw new Error("EDQUOT: quota exceeded");
    });

    expect(output).toContain("Full output could not be written to a temp file");
    expect(output).toContain("EDQUOT: quota exceeded");
    expect(output).toContain("byte-truncated at 1MB");
    expect(output).not.toContain("Use the read tool with offset/limit to browse.");
  });
});

describe("bash inline output budget", () => {
  test("exposes the invoking conversation and current daemon socket", async () => {
    const result = await executeBashBackgroundable(
      { command: platformCommand("printf '%s|%s' \"$EXOCORTEX_PARENT_CONV_ID\" \"$EXOCORTEX_SOCKET\"", "[Console]::Write('{0}|{1}', $env:EXOCORTEX_PARENT_CONV_ID, $env:EXOCORTEX_SOCKET)") },
      undefined,
      undefined,
      { conversationId: "conversation-123" },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("conversation-123|");
    expect(result.output).toContain(isWindows ? "exocortexd" : "exocortexd.sock");
  });

  test("passes literal stdin and internal environment overrides to the command", async () => {
    const result = await executeBashBackgroundable({
      command: platformCommand("IFS= read -r line; printf '%s|%s' \"$line\" \"$SOFT_WAKE_MARKER\"", "[Console]::Write(([Console]::In.ReadLine() + '|' + $env:SOFT_WAKE_MARKER))"),
      stdin: "literal $HOME and `echo nope`\n",
      env: { SOFT_WAKE_MARKER: "notification-event" },
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe("literal $HOME and `echo nope`|notification-event");
  });

  test("spills medium output at the default budget", async () => {
    const result = await executeBashBackgroundable(
      { command: mediumOutputCommand },
      undefined,
      60_000,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Full output: ");
    expect(result.output).toContain("Use the read tool with offset/limit to browse.");
    const spillPath = result.output.match(/Full output: (\S+)/)?.[1];
    if (spillPath) rmSync(spillPath, { force: true });
  });

  test("allows larger inline output when max_output_chars is raised", async () => {
    const result = await executeBashBackgroundable(
      { command: mediumOutputCommand, max_output_chars: 20_000 },
      undefined,
      60_000,
    );

    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("Full output: ");
    expect(result.output.length).toBe(13_000);
  });

  test("can discard oversized automation output without retaining a spill path", async () => {
    const result = await executeBashBackgroundable({
      command: mediumOutputCommand,
      discard_output_file: true,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("discarded by automation output policy");
    expect(result.output).not.toContain("Full output:");
  });
});
