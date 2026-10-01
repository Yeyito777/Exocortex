import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { TerminalScreen } from "./testhelpers/terminalscreen";
import type { Command, Event, ProviderAuthInfo, TranscribeAudioCommand } from "./protocol";
import type { ConversationSummary } from "./messages";

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

function providerAuthInfo(overrides: Partial<ProviderAuthInfo> = {}): ProviderAuthInfo {
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
    ...overrides,
  };
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

function writeFakeRecorder(fakeBin: string): void {
  mkdirSync(fakeBin, { recursive: true });
  for (const command of ["pw-record", "ffmpeg"]) {
    const fakeRecorder = join(fakeBin, command);
    writeFileSync(fakeRecorder, `#!/usr/bin/env bash
set -euo pipefail
out="\${@: -1}"
printf 'fake wav bytes' > "$out"
trap 'exit 0' INT TERM
while true; do sleep 0.05; done
`);
    chmodSync(fakeRecorder, 0o755);
  }
}

function toolsAvailableEvent(): Extract<Event, { type: "tools_available" }> {
  return {
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
    authByProvider: { openai: true, deepseek: false, opencode: true, openrouter: false },
    authInfoByProvider: {
      openai: providerAuthInfo(),
      deepseek: providerAuthInfo({ configured: false, authenticated: false, status: "not_logged_in" }),
      opencode: providerAuthInfo({ displayName: "Public preview", source: "public" }),
      openrouter: providerAuthInfo(),
    },
  };
}

function isTranscribeAudioCommand(command: Command): command is TranscribeAudioCommand {
  return command.type === "transcribe_audio";
}

function isUserMessageDispatchCommand(command: Command): boolean {
  return command.type === "send_message"
    || command.type === "new_conversation"
    || command.type === "queue_message";
}

interface FakeDaemon {
  commands: Command[];
  broadcast(event: Event): void;
  dropConnections(): void;
  close(): Promise<void>;
}

async function startFakeDaemon(socketPath: string): Promise<FakeDaemon> {
  const commands: Command[] = [];
  const conversations = new Map<string, ConversationSummary>();
  const sockets = new Set<Socket>();
  const writeEvent = (socket: Socket, event: Event) => {
    if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(event)}\n`);
  };
  const bootstrap = (socket: Socket) => {
    writeEvent(socket, toolsAvailableEvent());
    writeEvent(socket, { type: "conversations_list", conversations: [...conversations.values()], folders: [] });
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("end", () => sockets.delete(socket));
    bootstrap(socket);

    let lineBuffer = "";
    socket.on("data", (chunk) => {
      lineBuffer += chunk;
      let idx: number;
      while ((idx = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;
        const command = JSON.parse(line) as Command;
        commands.push(command);
        if (command.type === "ping") {
          writeEvent(socket, { type: "pong", reqId: command.reqId });
          bootstrap(socket);
        } else if (command.type === "load_conversation") {
          const conversation = conversations.get(command.convId);
          if (conversation) writeEvent(socket, {
            type: "conversation_loaded", reqId: command.reqId, convId: conversation.id,
            provider: conversation.provider, model: conversation.model, effort: conversation.effort,
            fastMode: conversation.fastMode, entries: [], contextTokens: 0, toolOutputsIncluded: true,
          });
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => resolveListen());
  });

  return {
    commands,
    broadcast(event: Event): void {
      if (event.type === "conversation_created") {
        conversations.set(event.convId, {
          id: event.convId, provider: event.provider, model: event.model, effort: event.effort, fastMode: event.fastMode,
          title: "Voice fixture", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
          marked: false, pinned: false, streaming: false, unread: false, sortOrder: 0,
        });
      } else if (event.type === "streaming_started") {
        const conversation = conversations.get(event.convId);
        if (conversation) conversation.streaming = true;
      }
      for (const socket of sockets) writeEvent(socket, event);
    },
    dropConnections(): void {
      for (const socket of sockets) socket.destroy();
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    },
  };
}

describe("voice recall real TUI flow", () => {
  let cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanupFns.reverse()) await cleanup();
    cleanupFns = [];
  });

  async function launchVoiceTui(route: "local" | "ssh") {
    const repoRoot = resolve(import.meta.dir, "../..");
    // Keep the fixture socket below sockaddr_un's limit, including the worktree
    // namespace. Longer macOS tmpdir paths otherwise trigger production hashing.
    const tempRoot = mkdtempSync("/tmp/exo-voice-e2e-");
    cleanupFns.push(() => rmSync(tempRoot, { recursive: true, force: true }));

    const configDir = join(tempRoot, "config");
    const worktreeName = detectWorktreeName(repoRoot);
    const runtimeDir = worktreeName
      ? join(configDir, "runtime", worktreeName)
      : join(configDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const socketPath = join(runtimeDir, "exocortexd.sock");

    const fakeBin = join(tempRoot, "bin");
    writeFakeRecorder(fakeBin);

    const localDaemon = await startFakeDaemon(socketPath);
    cleanupFns.push(() => localDaemon.close());
    const remoteSocketPath = join(tempRoot, "remote.sock");
    const fakeDaemon = route === "ssh" ? await startFakeDaemon(remoteSocketPath) : localDaemon;
    if (route === "ssh") {
      cleanupFns.push(() => fakeDaemon.close());
      const fakeSsh = join(fakeBin, "ssh");
      writeFileSync(fakeSsh, `#!/usr/bin/env bun
import { connect } from "node:net";
const socket = connect(process.env.EXOCORTEX_TEST_REMOTE_SOCKET);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
`);
      chmodSync(fakeSsh, 0o755);
    }

    const proc = Bun.spawn(["bun", "run", "tui/src/main.ts", ...(route === "ssh" ? ["--ssh", "fixture"] : [])], {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXOCORTEX_CONFIG_DIR: configDir,
        EXOCORTEX_TEST: "1",
        EXOCORTEX_TEST_REMOTE_SOCKET: remoteSocketPath,
        NODE_ENV: "test",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanupFns.push(async () => {
      proc.stdin?.write("\x03");
      proc.kill("SIGTERM");
      await Promise.race([proc.exited.catch(() => {}), delay(500)]);
      proc.kill("SIGKILL");
    });
    const screen = new TerminalScreen();
    const stdoutText = await readStream(proc.stdout, chunk => screen.feed(chunk));
    const stderrText = await readStream(proc.stderr);

    await waitFor(() => fakeDaemon.commands.some(command => command.type === "client_capabilities"));
    await delay(100); // release bootstrap and complete the route-switch UI reset
    return { proc, screen, stdoutText, stderrText, fakeDaemon, localDaemon };
  }

  for (const route of ["local", "ssh"] as const) {
    test(`${route}: Enter-recalling a submitted transcription ignores the Enter release and keeps completion in the prompt`, async () => {
      if (process.platform === "win32") return; // fake recorder is a POSIX shell fixture
      const { proc, screen, stdoutText, stderrText, fakeDaemon, localDaemon } = await launchVoiceTui(route);
      // Start hold-to-talk from normal mode, release to begin transcribing in the
      // prompt, then press Enter to submit that still-running transcription into
      // chat history. This matches the real workflow that regressed more closely
      // than pressing Enter while the recorder is still active.
      proc.stdin.write("\x1b");
      await delay(30);
      proc.stdin.write("\x1b[32;1:1u");
      await delay(650);
      proc.stdin.write("\x1b[32;1:3u");
      const transcriptionCommand = await waitFor(() => localDaemon.commands.find(isTranscribeAudioCommand));
      proc.stdin.write("\r");
      await delay(120);

      // Reproduce the user's recall path: open Ctrl-W, then press Enter. Real
      // kitty-keyboard terminals send both a press and a release event; the release
      // must not submit the recalled still-transcribing prompt job back to history.
      proc.stdin.write("\x17");
      await waitFor(() => screen.plainRows().some(row => row.includes("Edit message:")));
      proc.stdin.write("\x1b[13;1:1u");
      await delay(20);
      proc.stdin.write("\x1b[13;1:3u");
      await delay(120);

      const sendsBeforeCompletion = fakeDaemon.commands.filter(isUserMessageDispatchCommand);
      expect(sendsBeforeCompletion).toEqual([]);

      localDaemon.broadcast({ type: "transcription_result", reqId: transcriptionCommand.reqId, text: "recalled transcript" });
      await delay(250);

      const sendsAfterCompletion = fakeDaemon.commands.filter(isUserMessageDispatchCommand);
      const rows = screen.plainRows();
      const transcriptRows = rows
        .map((row, index) => ({ row: row.trimEnd(), index }))
        .filter(({ row }) => row.includes("recalled transcript"));
      expect(sendsAfterCompletion).toEqual([]);
      expect(stdoutText()).toContain("recalled transcript");
      expect(transcriptRows).toHaveLength(1);
      expect(transcriptRows[0].index).toBeGreaterThanOrEqual(17);
      expect(stderrText()).not.toContain("Fatal:");
      if (route === "ssh") expect(fakeDaemon.commands.filter(isTranscribeAudioCommand)).toEqual([]);
    }, 10_000);
  }

  test("SSH: recording submission immediately queues a placeholder and sends only final locally transcribed text remotely", async () => {
    if (process.platform === "win32") return;
    const { proc, screen, fakeDaemon, localDaemon, stderrText } = await launchVoiceTui("ssh");
    fakeDaemon.broadcast({
      type: "conversation_created", convId: "remote-voice", provider: "openai", model: "gpt-5.5",
      effort: "high", fastMode: false,
    });
    fakeDaemon.broadcast({
      type: "streaming_started", convId: "remote-voice", provider: "openai", model: "gpt-5.5",
      startedAt: Date.now(),
    });
    await delay(100);
    proc.stdin.write("\x1b");
    await delay(30);
    proc.stdin.write("\x1b[32;1:1u");
    await delay(650);
    // Enter during recording retains the automatic message-end queue behavior.
    proc.stdin.write("\r");
    const transcriptionCommand = await waitFor(() => localDaemon.commands.find(isTranscribeAudioCommand));
    await waitFor(() => screen.plainRows().some(row => row.includes("Transcribing…")));
    expect(fakeDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);

    localDaemon.broadcast({ type: "transcription_result", reqId: transcriptionCommand.reqId, text: "queued local voice" });
    const queued = await waitFor(() => fakeDaemon.commands.find(command => command.type === "queue_message"));
    expect(queued).toMatchObject({
      type: "queue_message", convId: "remote-voice", text: "queued local voice", timing: "message-end",
      queueId: expect.any(String),
    });
    expect(localDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);
    expect(fakeDaemon.commands.filter(isTranscribeAudioCommand)).toEqual([]);
    expect(stderrText()).not.toContain("Fatal:");
  }, 10_000);

  test("SSH: a submitted local transcription survives a remote disconnect and reconnect", async () => {
    if (process.platform === "win32") return;
    const { proc, screen, fakeDaemon, localDaemon, stderrText } = await launchVoiceTui("ssh");
    fakeDaemon.broadcast({
      type: "conversation_created", convId: "remote-voice", provider: "openai", model: "gpt-5.5",
      effort: "high", fastMode: false,
    });
    await delay(100);
    proc.stdin.write("\x1b");
    await delay(30);
    proc.stdin.write("\x1b[32;1:1u");
    await delay(650);
    proc.stdin.write("\r");
    const transcriptionCommand = await waitFor(() => localDaemon.commands.find(isTranscribeAudioCommand));
    await waitFor(() => screen.plainRows().some(row => row.includes("Transcribing…")));
    const connectionsBefore = fakeDaemon.commands.filter(command => command.type === "client_capabilities").length;
    fakeDaemon.dropConnections();
    await waitFor(() => fakeDaemon.commands.filter(command => command.type === "client_capabilities").length > connectionsBefore);
    await waitFor(() => fakeDaemon.commands.some(command => command.type === "load_conversation" && command.convId === "remote-voice"));
    await delay(100); // canonical reload must reattach the pending voice echo
    expect(screen.plainRows().some(row => row.includes("Transcribing…"))).toBe(true);

    localDaemon.broadcast({ type: "transcription_result", reqId: transcriptionCommand.reqId, text: "voice after reconnect" });
    const sent = await waitFor(() => fakeDaemon.commands.find(command => command.type === "send_message"));
    expect(sent).toMatchObject({
      type: "send_message", convId: "remote-voice", text: "voice after reconnect",
    });
    expect(fakeDaemon.commands.filter(isTranscribeAudioCommand)).toEqual([]);
    expect(localDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);
    expect(stderrText()).not.toContain("Fatal:");
  }, 10_000);
});
