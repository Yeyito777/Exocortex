import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInitialState } from "./state";
import { TerminalScreen } from "./testhelpers/terminalscreen";

test("real --ssh startup retains Local status through the remote bootstrap", async () => {
  if (process.platform === "win32") return; // executable SSH fixture uses a shebang
  const root = resolve(import.meta.dir, "../..");
  const temp = mkdtempSync(join(tmpdir(), "exo-startup-status-"));
  const bin = join(temp, "bin");
  const ready = join(temp, "ssh-ready");
  mkdirSync(bin);
  const env = {
    ...process.env,
    EXOCORTEX_CONFIG_DIR: join(temp, "config"),
    EXOCORTEX_TEST: "1",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const storage = join(env.EXOCORTEX_CONFIG_DIR, "storage");
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, "tui-state.json"), JSON.stringify({
    version: 2, focusedConversationId: null, conversationScrollPositions: {},
    sidebar: { open: true, currentFolderId: null, selectedItem: null, scrollOffset: 0 },
  }));
  // Resolve exactly as the child does, including worktree/socket-length isolation.
  const pathResult = Bun.spawnSync([process.execPath, "-e",
    'import { socketPath } from "./shared/src/paths"; process.stdout.write(socketPath());'],
  { cwd: root, env });
  expect(pathResult.exitCode).toBe(0);
  const socketPath = pathResult.stdout.toString();
  mkdirSync(dirname(socketPath), { recursive: true });

  const initial = createInitialState();
  const bootstrap = [
    { type: "tools_available", providers: [], tools: [],
      authByProvider: initial.authByProvider, authInfoByProvider: initial.authInfoByProvider },
    { type: "conversations_list", conversations: [] },
  ];
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = event => process.stdout.write(JSON.stringify(event) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  if (command.type !== "ping") return;
  if (command.updateStatusOnly) {
    send({ type: "pong", reqId: command.reqId, updateStatus: "none" });
  } else {
    setTimeout(() => {
      writeFileSync(${JSON.stringify(ready)}, "");
      send({ type: "pong", reqId: command.reqId });
      for (const event of ${JSON.stringify(bootstrap)}) send(event);
    }, 100);
  }
});
`, { mode: 0o755 });

  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let connections = 0;
  let startupIndependentProbes = 0;
  const server = createServer(socket => {
    const connection = ++connections;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    const send = (event: unknown) => {
      if (!socket.destroyed) socket.write(JSON.stringify(event) + "\n");
    };
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const command = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (command.type !== "ping") continue;
        if (command.updateStatusOnly) {
          const afterSwitch = existsSync(ready);
          if (connection > 1 && !afterSwitch) startupIndependentProbes++;
          // A fresh post-switch check is slow. Startup's already-known Local
          // result must not turn into Unknown while that check is outstanding.
          const timer = setTimeout(() => {
            timers.delete(timer);
            send({ type: "pong", reqId: command.reqId, updateStatus: "restart_needed" });
          }, afterSwitch ? 1_000 : 10);
          timers.add(timer);
        } else {
          send({ type: "pong", reqId: command.reqId });
          for (const event of bootstrap) send(event);
        }
      }
    });
  });
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let stderr = "";
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });
    proc = Bun.spawn([process.execPath, "run", "tui/src/main.ts", "--ssh", "fixture"], {
      cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const screen = new TerminalScreen();
    const consume = async (stream: ReadableStream<Uint8Array>, onText: (text: string) => void) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onText(decoder.decode(value, { stream: true }));
      }
    };
    const stdoutDone = consume(proc.stdout as ReadableStream<Uint8Array>, text => screen.feed(text));
    const stderrDone = consume(proc.stderr as ReadableStream<Uint8Array>, text => { stderr += text; });
    const deadline = Date.now() + 3_000;
    while (!screen.plainRows().some(row => /Remote:\s+None/.test(row)) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    const rows = screen.plainRows().join("\n");
    expect(stderr).toBe("");
    expect(rows).toMatch(/Remote:\s+None/);
    expect(rows).toMatch(/Local:\s+Restart needed/);
    expect(startupIndependentProbes).toBe(1);
    proc.kill("SIGTERM");
    await proc.exited;
    await Promise.all([stdoutDone, stderrDone]);
  } finally {
    if (proc && proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; }
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    rmSync(socketPath, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}, 10_000);
