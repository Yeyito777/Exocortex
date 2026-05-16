import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { execFileSync } from "node:child_process";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for condition");
}

function detectWorktreeName(repoRoot: string): string | null {
  const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
  if (resolve(repoRoot, gitDir) === resolve(repoRoot, gitCommonDir)) return null;
  return basename(gitDir);
}

function emptyAuthInfo() {
  return {
    configured: true,
    authenticated: true,
    status: "logged_in",
    email: null,
    displayName: null,
    organizationName: null,
    organizationType: null,
    organizationRole: null,
    workspaceRole: null,
    subscriptionType: null,
    rateLimitTier: null,
    scopes: [],
    expiresAt: null,
    updatedAt: null,
    source: null,
    accounts: [],
    currentAccount: null,
  };
}

class TerminalScreen {
  private rows: string[][];
  private row = 0;
  private col = 0;

  constructor(private readonly rowCount = 24, private readonly colCount = 80) {
    this.rows = Array.from({ length: rowCount }, () => Array(colCount).fill(" "));
  }

  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\x1b") {
        if (text[i + 1] === "[") {
          let j = i + 2;
          while (j < text.length && (text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e)) j++;
          if (j >= text.length) break;
          this.handleCsi(text.slice(i + 2, j), text[j]);
          i = j + 1;
          continue;
        }
        if (text[i + 1] === "]") {
          const bel = text.indexOf("\x07", i + 2);
          const st = text.indexOf("\x1b\\", i + 2);
          const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
          i = end === -1 ? text.length : end + (end === st ? 2 : 1);
          continue;
        }
        i += 2;
        continue;
      }

      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.row = Math.min(this.row + 1, this.rowCount - 1);
        i++;
        continue;
      }
      if (ch >= " ") {
        if (this.row >= 0 && this.row < this.rowCount && this.col >= 0 && this.col < this.colCount) {
          this.rows[this.row][this.col] = ch;
        }
        this.col = Math.min(this.col + 1, this.colCount - 1);
      }
      i++;
    }
  }

  private handleCsi(params: string, final: string): void {
    const cleanParams = params.replace(/^\?/, "");
    const numbers = cleanParams.split(";").map(part => part === "" ? NaN : Number.parseInt(part, 10));
    if (final === "H" || final === "f") {
      this.row = Math.max(0, Math.min((Number.isFinite(numbers[0]) ? numbers[0] : 1) - 1, this.rowCount - 1));
      this.col = Math.max(0, Math.min((Number.isFinite(numbers[1]) ? numbers[1] : 1) - 1, this.colCount - 1));
    } else if (final === "G") {
      this.col = Math.max(0, Math.min((Number.isFinite(numbers[0]) ? numbers[0] : 1) - 1, this.colCount - 1));
    } else if (final === "K") {
      const mode = Number.isFinite(numbers[0]) ? numbers[0] : 0;
      if (mode === 2) this.rows[this.row].fill(" ");
      else if (mode === 1) this.rows[this.row].fill(" ", 0, this.col + 1);
      else this.rows[this.row].fill(" ", this.col);
    } else if (final === "J") {
      const mode = Number.isFinite(numbers[0]) ? numbers[0] : 0;
      if (mode === 2) for (const row of this.rows) row.fill(" ");
    } else if (final === "A") {
      this.row = Math.max(0, this.row - (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    } else if (final === "B") {
      this.row = Math.min(this.rowCount - 1, this.row + (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    } else if (final === "C") {
      this.col = Math.min(this.colCount - 1, this.col + (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    } else if (final === "D") {
      this.col = Math.max(0, this.col - (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    }
  }

  plainRows(): string[] {
    return this.rows.map(row => row.join(""));
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null, onChunk?: (text: string) => void): Promise<() => string> {
  if (!stream) return () => "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        output += text;
        onChunk?.(text);
      }
    } catch {
      // Process termination can reject a pending pipe read; collected output is
      // still useful for assertions/diagnostics.
    }
  })();
  return () => output;
}

describe("voice recall real TUI flow", () => {
  let cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanupFns.reverse()) await cleanup();
    cleanupFns = [];
  });

  test("Enter-recalling a submitted transcription ignores the Enter release and keeps completion in the prompt", async () => {
    const repoRoot = resolve(import.meta.dir, "../..");
    const tempRoot = mkdtempSync(join(tmpdir(), "exo-voice-recall-e2e-"));
    cleanupFns.push(() => rmSync(tempRoot, { recursive: true, force: true }));

    const configDir = join(tempRoot, "config");
    const worktreeName = detectWorktreeName(repoRoot);
    const runtimeDir = worktreeName
      ? join(configDir, "runtime", worktreeName)
      : join(configDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const socketPath = join(runtimeDir, "exocortexd.sock");

    const fakeBin = join(tempRoot, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeRecorder = join(fakeBin, "pw-record");
    writeFileSync(fakeRecorder, `#!/usr/bin/env bash
set -euo pipefail
out="\${@: -1}"
printf 'fake wav bytes' > "$out"
trap 'exit 0' INT TERM
while true; do sleep 1; done
`);
    chmodSync(fakeRecorder, 0o755);

    const commands: any[] = [];
    const sockets = new Set<Socket>();
    let lineBuffer = "";
    let server: Server | null = null;
    await new Promise<void>((resolveListen, rejectListen) => {
      server = createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding("utf8");
        const send = (event: object) => socket.write(`${JSON.stringify(event)}\n`);
        send({
          type: "tools_available",
          providers: [{
            id: "openai",
            label: "OpenAI",
            defaultModel: "gpt-5.5",
            allowsCustomModels: true,
            supportsFastMode: true,
            models: [{
              id: "gpt-5.5",
              label: "GPT-5.5",
              maxContext: 272_000,
              supportedEfforts: [{ effort: "high", description: "High" }],
              defaultEffort: "high",
              supportsImages: true,
            }],
          }],
          tools: [],
          authByProvider: { openai: true, deepseek: false },
          authInfoByProvider: { openai: emptyAuthInfo(), deepseek: { ...emptyAuthInfo(), configured: false, authenticated: false, status: "not_logged_in" } },
        });
        send({ type: "conversations_list", conversations: [], folders: [] });

        socket.on("data", (chunk) => {
          lineBuffer += chunk;
          let idx: number;
          while ((idx = lineBuffer.indexOf("\n")) !== -1) {
            const line = lineBuffer.slice(0, idx).trim();
            lineBuffer = lineBuffer.slice(idx + 1);
            if (!line) continue;
            const command = JSON.parse(line);
            commands.push(command);
            if (command.type === "ping") send({ type: "pong" });
          }
        });
        socket.on("close", () => sockets.delete(socket));
      });
      server.once("error", rejectListen);
      server.listen(socketPath, () => resolveListen());
    });
    cleanupFns.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolveClose => server?.close(() => resolveClose()));
    });

    const proc = Bun.spawn(["bun", "run", "tui/src/main.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXOCORTEX_CONFIG_DIR: configDir,
        EXOCORTEX_TEST: "1",
        NODE_ENV: "test",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanupFns.push(() => {
      proc.stdin?.write("\x03");
      proc.kill("SIGTERM");
    });
    const screen = new TerminalScreen();
    const stdoutText = await readStream(proc.stdout, chunk => screen.feed(chunk));
    const stderrText = await readStream(proc.stderr);

    await waitFor(() => commands.some(command => command.type === "ping"));

    // Start hold-to-talk from normal mode, release to begin transcribing in the
    // prompt, then press Enter to submit that still-running transcription into
    // chat history.  This matches the real workflow that regressed more closely
    // than pressing Enter while the recorder is still active.
    proc.stdin.write("\x1b");
    await delay(30);
    proc.stdin.write("\x1b[32;1:1u");
    await delay(650);
    proc.stdin.write("\x1b[32;1:3u");
    const transcriptionCommand = await waitFor(() => commands.find(command => command.type === "transcribe_audio"));
    proc.stdin.write("\r");
    await delay(120);

    // Reproduce the user's recall path: open Ctrl-W, then press Enter.  Real
    // kitty-keyboard terminals send both a press and a release event; the release
    // must not submit the recalled still-transcribing prompt job back to history.
    proc.stdin.write("\x17");
    await waitFor(() => screen.plainRows().some(row => row.includes("Edit message:")));
    proc.stdin.write("\x1b[13;1:1u");
    await delay(20);
    proc.stdin.write("\x1b[13;1:3u");
    await delay(120);

    const sendsBeforeCompletion = commands.filter(command =>
      command.type === "send_message" || command.type === "new_conversation" || command.type === "queue_message"
    );
    expect(sendsBeforeCompletion).toEqual([]);

    for (const socket of sockets) {
      socket.write(`${JSON.stringify({ type: "transcription_result", reqId: transcriptionCommand.reqId, text: "recalled transcript" })}\n`);
    }
    await delay(250);

    const sendsAfterCompletion = commands.filter(command =>
      command.type === "send_message" || command.type === "new_conversation" || command.type === "queue_message"
    );
    const rows = screen.plainRows();
    const transcriptRows = rows
      .map((row, index) => ({ row: row.trimEnd(), index }))
      .filter(({ row }) => row.includes("recalled transcript"));
    expect(sendsAfterCompletion).toEqual([]);
    expect(stdoutText()).toContain("recalled transcript");
    expect(transcriptRows).toHaveLength(1);
    expect(transcriptRows[0].index).toBeGreaterThanOrEqual(17);
    expect(stderrText()).not.toContain("Fatal:");
  }, 10_000);
});
