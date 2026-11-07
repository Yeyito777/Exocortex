import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { conversationWorkspaceDir } from "@exocortex/shared/paths";
import { scratchpadHash } from "@exocortex/shared/scratchpad";
import { createScratchpadIndex, readScratchpad, SCRATCHPAD_FILE, SCRATCHPAD_MAX_BYTES, setScratchpadTimingForTest } from "./scratchpad";
import { DaemonServer, type ConnectedClient } from "./server";
import { createHandler } from "./handler";
import { create, remove } from "./conversations";
import type { Event } from "../../tui/src/protocol";
import { DaemonClient } from "../../tui/src/client";

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

beforeAll(() => setScratchpadTimingForTest({ debounceMs: 5, pollMs: 20, sweepMs: 60, lingerMs: 100 }));
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

describe("scratchpad index", () => {
  function setup(active: string[] = []) {
    const root = tempDir();
    const changes: Array<[string, string | null]> = [];
    const index = createScratchpadIndex({
      workspacesDir: () => root,
      activeConversationIds: () => active,
      onChange: (convId, entry) => { changes.push([convId, entry?.content ?? null]); },
    });
    const write = (convId: string, content: string) => {
      mkdirSync(join(root, convId), { recursive: true });
      writeFileSync(join(root, convId, SCRATCHPAD_FILE), content);
    };
    return { root, changes, index, write };
  }

  test("fills from every workspace on start without telling anyone, and hashes what summaries carry", () => {
    const { index, write, changes } = setup();
    write("a", "- [ ] one\n");
    write("b", "  \n");
    try {
      index.start();
      expect(index.conversationIds()).toEqual(["a"]);
      expect(index.hash("a")).toBe(scratchpadHash("- [ ] one\n"));
      expect(index.hash("b")).toBeUndefined();
      expect(changes).toEqual([]);
    } finally {
      index.stop();
    }
  });

  test("a running conversation's change is seen within a poll; one no client follows, by the sweep; a deleted file goes", async () => {
    const active = ["run"];
    const { index, write, changes, root } = setup(active);
    write("run", "- [ ] first\n");
    write("idle", "- [ ] idle\n");
    index.start();
    try {
      write("run", "- [x] first\n");
      await until(() => changes.length === 1);
      expect(changes[0]).toEqual(["run", "- [x] first\n"]);
      expect(index.hash("run")).toBe(scratchpadHash("- [x] first\n"));

      write("idle", "- [ ] edited by hand\n");
      await until(() => changes.length === 2);
      expect(changes[1]).toEqual(["idle", "- [ ] edited by hand\n"]);

      unlinkSync(join(root, "run", SCRATCHPAD_FILE));
      await until(() => changes.length === 3);
      expect(changes[2]).toEqual(["run", null]);
      expect(index.hash("run")).toBeUndefined();

      // A workspace moved to trash loses its scratchpad with the next sweep.
      rmSync(join(root, "idle"), { recursive: true });
      await until(() => changes.length === 4);
      expect(changes[3]).toEqual(["idle", null]);

      // Nothing changed: nothing more is told.
      await Bun.sleep(150);
      expect(changes).toHaveLength(4);
    } finally {
      index.stop();
    }
  });

  test("a followed conversation is watched: edits, editors that rename over it, emptied files", async () => {
    const { index, write, changes, root } = setup();
    write("conv", "- [ ] one\n");
    index.start();
    try {
      index.watch("conv");
      index.watch("conv");
      writeFileSync(join(root, "conv", "scratchpad.md.tmp"), "- [ ] renamed in\n");
      renameSync(join(root, "conv", "scratchpad.md.tmp"), join(root, "conv", SCRATCHPAD_FILE));
      await until(() => changes.length === 1);
      expect(changes[0]).toEqual(["conv", "- [ ] renamed in\n"]);
      write("conv", "\n \n");
      await until(() => changes.length === 2);
      expect(changes[1]).toEqual(["conv", null]);
      // Blank stays blank without reading it again; contents again are a change.
      write("conv", "back\n");
      await until(() => changes.length === 3);
      index.unwatch("conv");
      expect(index.watchedConversations()).toEqual(["conv"]);
      index.unwatch("conv");
      expect(index.watchedConversations()).toEqual([]);
    } finally {
      index.stop();
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
  test("the bootstrap sends the contents a TUI lacks ahead of the summaries naming them, then changes ahead of their summary", async () => {
    const socketPath = join(tempDir(), "daemon.sock");
    const convId = `scratchpad-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const other = `${convId}-other`;
    create(convId, "openai", "gpt-5.4");
    create(other, "openai", "gpt-5.4");
    for (const [id, content] of [[convId, "# Today\n- [ ] **Wed 11:00** quiz\n"], [other, "- [ ] held already\n"]] as const) {
      mkdirSync(conversationWorkspaceDir(id), { recursive: true });
      writeFileSync(join(conversationWorkspaceDir(id), SCRATCHPAD_FILE), content);
    }

    let commandHandler: ReturnType<typeof createHandler> | null = null;
    const server = new DaemonServer(socketPath, (client, cmd) => commandHandler?.(client, cmd));
    commandHandler = createHandler(server);
    await server.start();

    const events: Event[] = [];
    const client = new DaemonClient(event => { events.push(event); }, socketPath);
    client.setScratchpadHashes(() => [scratchpadHash("- [ ] held already\n")]);
    const summaryHash = (event: Event | undefined, id: string) =>
      event?.type === "conversations_list" ? event.conversations.find(row => row.id === id)?.scratchpad
        : event?.type === "conversation_updated" && event.summary.id === id ? event.summary.scratchpad ?? null : undefined;
    try {
      await client.connect();
      client.ping();
      await until(() => events.some(event => event.type === "conversations_list"));
      const bootstrap = events.findIndex(event => event.type === "scratchpads");
      const list = events.findIndex(event => event.type === "conversations_list");
      expect(bootstrap).toBeGreaterThanOrEqual(0);
      expect(bootstrap).toBeLessThan(list);
      // Only what it lacks; the summaries name both.
      expect(events[bootstrap]).toEqual({ type: "scratchpads", scratchpads: [{ hash: scratchpadHash("# Today\n- [ ] **Wed 11:00** quiz\n"), content: "# Today\n- [ ] **Wed 11:00** quiz\n" }] });
      expect(summaryHash(events[list], convId)).toBe(scratchpadHash("# Today\n- [ ] **Wed 11:00** quiz\n"));
      expect(summaryHash(events[list], other)).toBe(scratchpadHash("- [ ] held already\n"));

      // A conversation the client follows: a change is pushed, contents ahead of the summary.
      client.loadConversation(convId);
      events.length = 0;
      writeFileSync(join(conversationWorkspaceDir(convId), SCRATCHPAD_FILE), "# Today\n- [x] **Wed 11:00** quiz\n");
      const newHash = scratchpadHash("# Today\n- [x] **Wed 11:00** quiz\n");
      await until(() => events.some(event => summaryHash(event, convId) === newHash));
      const content = events.findIndex(event => event.type === "scratchpad_updated" && event.hash === newHash);
      expect(content).toBeGreaterThanOrEqual(0);
      expect(content).toBeLessThan(events.findIndex(event => summaryHash(event, convId) === newHash));

      // Deleted: its summary drops the hash.
      unlinkSync(join(conversationWorkspaceDir(convId), SCRATCHPAD_FILE));
      await until(() => events.some(event => summaryHash(event, convId) === null));
    } finally {
      client.disconnect();
      await commandHandler.stop();
      await server.stop();
      remove(convId);
      remove(other);
    }
  });
});
