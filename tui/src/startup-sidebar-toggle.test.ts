import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInitialState } from "./state";
import { TerminalScreen } from "./testhelpers/terminalscreen";

/**
 * A sidebar toggled while the TUI is still starting stays as the user left it:
 * the daemon's first data (and, over --ssh, the route switch) arrives after the
 * key and must not undo it. The bootstrap is held until the key was handled.
 */
test.each([
  { route: "local", savedOpen: false },
  { route: "local", savedOpen: true },
  { route: "ssh", savedOpen: false },
  { route: "ssh", savedOpen: true },
] as const)("a sidebar toggle during $route startup (saved open: $savedOpen) sticks", async ({ route, savedOpen }) => {
  if (process.platform === "win32") return; // executable SSH fixture uses a shebang
  const root = resolve(import.meta.dir, "../..");
  const temp = mkdtempSync(join(tmpdir(), "exo-startup-sidebar-"));
  const bin = join(temp, "bin");
  const release = join(temp, "release");
  mkdirSync(bin);
  const env = {
    ...process.env,
    EXOCORTEX_CONFIG_DIR: join(temp, "config"),
    EXOCORTEX_TEST: "1",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const storage = join(env.EXOCORTEX_CONFIG_DIR, "storage");
  mkdirSync(storage, { recursive: true });
  const statePath = join(storage, "tui-state.json");
  writeFileSync(statePath, JSON.stringify({
    version: 2, focusedConversationId: "fixture-conv", conversationScrollPositions: {},
    sidebar: savedOpen
      ? { open: true, currentFolderId: null, selectedItem: null, scrollOffset: 0 }
      : { open: false },
  }));
  const pathResult = Bun.spawnSync([process.execPath, "-e",
    'import { socketPath } from "./shared/src/paths"; process.stdout.write(socketPath());'],
  { cwd: root, env });
  expect(pathResult.exitCode).toBe(0);
  const socketPath = pathResult.stdout.toString();
  mkdirSync(dirname(socketPath), { recursive: true });

  const initial = createInitialState();
  const now = Date.now();
  const summary = (id: string, title: string, sortOrder: number) => ({
    id, provider: "openai", model: "gpt-6.1-sol", effort: "high", fastMode: false,
    createdAt: now, updatedAt: now, messageCount: 2, title, marked: false, pinned: false,
    streaming: false, unread: false, sortOrder, folderId: null,
  });
  const bootstrap = [
    { type: "tools_available", providers: [], tools: [],
      authByProvider: initial.authByProvider, authInfoByProvider: initial.authInfoByProvider },
    // The restored conversation is not the top row.
    { type: "conversations_list", conversations: [summary("other-conv", "Other chat", -1), summary("fixture-conv", "Fixture chat", 0)] },
  ];
  // The remote daemon answers the probe only once the test releases it.
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
const send = event => process.stdout.write(JSON.stringify(event) + "\\n");
const whenReleased = run => { const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); run(); } }, 5); };
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  if (command.type !== "ping") return;
  if (command.updateStatusOnly) send({ type: "pong", reqId: command.reqId, updateStatus: "none" });
  else whenReleased(() => { send({ type: "pong", reqId: command.reqId }); for (const event of ${JSON.stringify(bootstrap)}) send(event); });
});
`, { mode: 0o755 });

  // The local daemon holds its bootstrap the same way; over --ssh it only answers status checks.
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const server = createServer(socket => {
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
          send({ type: "pong", reqId: command.reqId, updateStatus: "none" });
          continue;
        }
        const timer = setInterval(() => {
          if (!existsSync(release)) return;
          clearInterval(timer);
          timers.delete(timer);
          send({ type: "pong", reqId: command.reqId });
          for (const event of bootstrap) send(event);
        }, 5);
        timers.add(timer);
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
    proc = Bun.spawn([process.execPath, "run", "tui/src/main.ts", ...(route === "ssh" ? ["--ssh", "fixture"] : [])], {
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
    const deadline = Date.now() + 5_000;
    const waitFor = async (ready: (rows: string) => boolean) => {
      while (!ready(screen.plainRows().join("\n")) && Date.now() < deadline) await Bun.sleep(10);
      return screen.plainRows().join("\n");
    };
    const sidebarShown = (rows: string) => /^ Conversations /m.test(rows);

    // The startup screen is up: over --ssh the connecting progress, locally the empty draft.
    await waitFor(rows => route === "ssh" ? /Connecting to remote/.test(rows) : /Exocortex/.test(rows));
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write("\x13"); // Ctrl+S
    stdin.flush();
    const toggled = await waitFor(rows => sidebarShown(rows) !== savedOpen);
    expect(sidebarShown(toggled)).toBe(!savedOpen);

    writeFileSync(release, "");
    // The list has landed once the restored conversation's title is in the top bar.
    const settled = await waitFor(rows => !/Connecting|Loading/.test(rows) && /Exocortex — Fixture chat/.test(rows));
    expect(stderr).toBe("");
    expect(settled).toMatch(/Exocortex — Fixture chat/);
    expect(sidebarShown(settled)).toBe(!savedOpen);
    // Opened before the list, its cursor lands on the open conversation, as opening it later does.
    if (!savedOpen) expect(settled).toMatch(/▸ Fixture chat/);

    proc.kill("SIGTERM");
    await proc.exited;
    await Promise.all([stdoutDone, stderrDone]);
    expect(JSON.parse(readFileSync(statePath, "utf8")).sidebar.open).toBe(!savedOpen);
  } finally {
    if (proc && proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; }
    for (const timer of timers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    rmSync(socketPath, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}, 15_000);
