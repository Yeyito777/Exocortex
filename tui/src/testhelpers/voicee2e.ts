/**
 * A real TUI process against fake local and remote daemons, with fake
 * recorders on PATH, for the voice e2e files (split so they run on separate
 * workers).
 */
import { afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { TerminalScreen } from "./terminalscreen";
import type { Command, Event, ProviderAuthInfo, TranscribeAudioCommand } from "../protocol";
import type { ConversationSummary } from "../messages";

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 3_000): Promise<T> {
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
trap 'exit 0' INT TERM
out="\${@: -1}"
printf 'fake wav bytes' > "$out"
echo started >> "$(dirname "$0")/recordings"
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
    authByProvider: { openai: true, anthropic: false, deepseek: false, opencode: true, openrouter: false },
    authInfoByProvider: {
      openai: providerAuthInfo(),
      anthropic: providerAuthInfo({ configured: false, authenticated: false, status: "not_logged_in" }),
      deepseek: providerAuthInfo({ configured: false, authenticated: false, status: "not_logged_in" }),
      opencode: providerAuthInfo({ displayName: "Public preview", source: "public" }),
      openrouter: providerAuthInfo(),
    },
  };
}

export function isTranscribeAudioCommand(command: Command): command is TranscribeAudioCommand {
  return command.type === "transcribe_audio";
}

export function isUserMessageDispatchCommand(command: Command): boolean {
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

/** Registers the cleanup in the calling file; returns the launcher. */
export function useVoiceTui() {
  let cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanupFns.reverse()) await cleanup();
    cleanupFns = [];
  });

  async function launchVoiceTui(route: "local" | "ssh") {
    const repoRoot = resolve(import.meta.dir, "../../..");
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
    // Keys sent before the UI is up on its route (the SSH progress view, the
    // route-switch reset) don't reach the prompt.
    await waitFor(() => {
      const rows = screen.plainRows();
      return rows.some(row => row.includes("OpenAI/Gpt-5.5")) && rows.some(row => row.startsWith("I >"))
        && (route === "local" || rows.some(row => row.includes("Connected daemon: SSH alias fixture")));
    });

    const recordingsPath = join(fakeBin, "recordings");
    const recordings = () => existsSync(recordingsPath) ? readFileSync(recordingsPath, "utf8").split("\n").length - 1 : 0;
    /**
     * Escape to normal mode and hold Space until the fake recorder has run for
     * longer than the minimum clip. The hold is timed from the recorder's own
     * start, so a slow TUI or a slow recorder spawn can't shorten it.
     */
    async function holdSpace(): Promise<void> {
      const before = recordings();
      proc.stdin.write("\x1b\x1b[32;1:1u");
      await waitFor(() => recordings() > before);
      await delay(650);
    }
    return { proc, screen, stdoutText, stderrText, fakeDaemon, localDaemon, holdSpace };
  }

  return launchVoiceTui;
}
