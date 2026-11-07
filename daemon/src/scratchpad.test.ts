import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { conversationWorkspaceDir } from "@exocortex/shared/paths";
import { createScratchpadWatch, readScratchpad, SCRATCHPAD_FILE, SCRATCHPAD_MAX_BYTES, setScratchpadTimingForTest } from "./scratchpad";
import { DaemonServer, type ConnectedClient } from "./server";
import { createHandler } from "./handler";
import { create, remove } from "./conversations";
import type { Event } from "./protocol";
import { DaemonClient } from "../../tui/src/client";
import { createInitialState } from "../../tui/src/state";
import { handleEvent } from "../../tui/src/events";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-scratchpad-"));
  dirs.push(dir);
  return dir;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}

beforeAll(() => setScratchpadTimingForTest({ debounceMs: 5, pollMs: 25 }));
afterAll(() => setScratchpadTimingForTest());
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeClient(id = "c1"): ConnectedClient {
  return { id, socket: { destroyed: false } as never, subscriptions: new Set(), lines: null as never, capabilities: new Set(["scratchpad"]) };
}

describe("readScratchpad", () => {
  test("is null for a missing, empty or blank file, and the text otherwise", () => {
    const dir = tempDir();
    const path = join(dir, SCRATCHPAD_FILE);
    expect(readScratchpad(path)).toBeNull();
    writeFileSync(path, "");
    expect(readScratchpad(path)).toBeNull();
    writeFileSync(path, "  \n\n\t\n");
    expect(readScratchpad(path)).toBeNull();
    writeFileSync(path, "# Today\n- [ ] one\n");
    expect(readScratchpad(path)).toBe("# Today\n- [ ] one\n");
    expect(readScratchpad(dir)).toBeNull();
  });

  test("cuts a long file at its last whole line within the cap", () => {
    const path = join(tempDir(), SCRATCHPAD_FILE);
    const line = `- [ ] ${"é".repeat(40)}\n`;
    writeFileSync(path, line.repeat(Math.ceil((SCRATCHPAD_MAX_BYTES * 2) / Buffer.byteLength(line))));
    const content = readScratchpad(path)!;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(SCRATCHPAD_MAX_BYTES);
    expect(Buffer.byteLength(content)).toBeGreaterThan(SCRATCHPAD_MAX_BYTES - Buffer.byteLength(line));
    expect(content.split("\n").every(row => row === "" || row === line.trimEnd())).toBe(true);
  });
});

describe("scratchpad watch", () => {
  test("sends the file on subscribe and each change, null once emptied or deleted, and stops with the last client", async () => {
    const dir = tempDir();
    const path = join(dir, SCRATCHPAD_FILE);
    writeFileSync(path, "- [ ] first\n");
    const sent: Array<{ client: string; event: Event }> = [];
    const watch = createScratchpadWatch({ send: (client, event) => { sent.push({ client: client.id, event }); }, workspaceDir: () => dir });
    const a = fakeClient("a");
    const b = fakeClient("b");
    const contents = (client: string) => sent
      .filter(entry => entry.client === client)
      .map(entry => (entry.event as Extract<Event, { type: "scratchpad_updated" }>).content);
    try {
      watch.subscribed(a, "conv");
      expect(sent[0]).toEqual({ client: "a", event: { type: "scratchpad_updated", convId: "conv", content: "- [ ] first\n" } });

      writeFileSync(path, "- [x] first\n");
      await until(() => contents("a").length === 2);
      expect(contents("a")[1]).toBe("- [x] first\n");

      // A second client gets the current file at once, then changes with the first.
      watch.subscribed(b, "conv");
      expect(contents("b")).toEqual(["- [x] first\n"]);

      // Editors that save by renaming a new file over the old one.
      writeFileSync(join(dir, "scratchpad.md.tmp"), "- [ ] renamed in\n");
      renameSync(join(dir, "scratchpad.md.tmp"), path);
      await until(() => contents("b").length === 2);
      expect(contents("b")[1]).toBe("- [ ] renamed in\n");

      writeFileSync(path, "\n  \n");
      await until(() => contents("a").at(-1) === null);
      writeFileSync(path, "back\n");
      await until(() => contents("a").at(-1) === "back\n");
      unlinkSync(path);
      await until(() => contents("a").at(-1) === null && contents("b").at(-1) === null);

      // Nothing changed: nothing more is sent.
      const count = sent.length;
      await Bun.sleep(60);
      expect(sent.length).toBe(count);

      watch.unsubscribed(a, "conv");
      expect(watch.watchedConversations()).toEqual(["conv"]);
      watch.unsubscribed(b, "conv");
      expect(watch.watchedConversations()).toEqual([]);
      writeFileSync(path, "unwatched\n");
      await Bun.sleep(60);
      expect(sent.length).toBe(count);
    } finally {
      watch.stop();
    }
  });

  test("picks up a workspace created after the subscribe", async () => {
    const dir = join(tempDir(), "later");
    const sent: Event[] = [];
    const watch = createScratchpadWatch({ send: (_client, event) => { sent.push(event); }, workspaceDir: () => dir });
    try {
      watch.subscribed(fakeClient(), "conv");
      expect(sent).toEqual([{ type: "scratchpad_updated", convId: "conv", content: null }]);
      mkdirSync(dir);
      writeFileSync(join(dir, SCRATCHPAD_FILE), "- [ ] new\n");
      await until(() => sent.length === 2);
      expect(sent[1]).toEqual({ type: "scratchpad_updated", convId: "conv", content: "- [ ] new\n" });
    } finally {
      watch.stop();
    }
  });
});

describe("DaemonServer subscription notices", () => {
  test("tell of a new subscribe, an unsubscribe and a disconnect, never twice", () => {
    const server = new DaemonServer(join(tmpdir(), "unused.sock"), () => {});
    const notices: string[] = [];
    server.onSubscriptionChanged((client, convId, subscribed) => notices.push(`${client.id}:${convId}:${subscribed}`));
    const client = fakeClient("c");
    server.subscribe(client, "x");
    server.subscribe(client, "x");
    server.subscribe(client, "y");
    server.unsubscribe(client, "x");
    server.unsubscribe(client, "x");
    (server as unknown as { notifyClosed(client: ConnectedClient): void }).notifyClosed(client);
    expect(notices).toEqual(["c:x:true", "c:y:true", "c:x:false", "c:y:false"]);
  });
});

describe("scratchpad through a real daemon", () => {
  test("a TUI client gets the file when it opens the conversation and every change after", async () => {
    const socketDir = tempDir();
    const socketPath = join(socketDir, "daemon.sock");
    let commandHandler: ReturnType<typeof createHandler> | null = null;
    const server = new DaemonServer(socketPath, (client, cmd) => commandHandler?.(client, cmd));
    commandHandler = createHandler(server);
    await server.start();

    const convId = `scratchpad-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    create(convId, "openai", "gpt-5.4");
    const workspace = conversationWorkspaceDir(convId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, SCRATCHPAD_FILE), "# Today\n- [ ] **Wed 11:00** quiz\n");

    const state = createInitialState();
    const updates: Array<string | null> = [];
    const client = new DaemonClient((event) => {
      if (event.type === "scratchpad_updated" && event.convId === convId) updates.push(event.content);
      handleEvent(event, state, client);
    }, socketPath);
    try {
      await client.connect();
      client.loadConversation(convId);
      await until(() => updates.length === 1);
      expect(state.scratchpads.get(convId)).toBe("# Today\n- [ ] **Wed 11:00** quiz\n");

      writeFileSync(join(workspace, SCRATCHPAD_FILE), "# Today\n- [x] **Wed 11:00** quiz\n");
      await until(() => updates.length === 2);
      expect(state.scratchpads.get(convId)).toBe("# Today\n- [x] **Wed 11:00** quiz\n");

      unlinkSync(join(workspace, SCRATCHPAD_FILE));
      await until(() => updates.length === 3);
      expect(state.scratchpads.has(convId)).toBe(false);
    } finally {
      client.disconnect();
      await commandHandler.stop();
      await server.stop();
      remove(convId);
    }
  });
});
