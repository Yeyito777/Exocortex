import { afterEach, describe, expect, mock, test } from "bun:test";
import { historyEntryHash } from "@exocortex/shared/history-delta";
import { appendMessages, clearUnread, create, deleteFolder, ensureTopLevelFolder, findTopLevelFolderByName, get, getHistoryRev, getSummary, markDirty, markUnread, moveConversationToFolder, remove, setSystemInstructions, trimConversation, unwindTo } from "./conversations";
import { clearActiveJob, setActiveJob } from "./streaming";
import { DaemonServer, type ConnectedClient } from "./server";
import { LineSplitter } from "./line-splitter";
import type { Socket } from "node:net";
import { createHandler, setHistoryRevPushDelayForTest } from "./handler";

const IDS: string[] = [];
const FOLDER = `history-rev-test-${process.pid}`;
afterEach(() => {
  setHistoryRevPushDelayForTest(250);
  for (const id of IDS.splice(0)) { clearActiveJob(id); remove(id); }
  const folder = findTopLevelFolderByName(FOLDER);
  if (folder) deleteFolder(folder.id, "unwrap", false);
});

function conversation(turns = 6): string {
  const id = `history-rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  create(id, "openai", "gpt-5.4");
  for (let turn = 0; turn < turns; turn++) {
    appendMessages(id, [
      { role: "user", content: `user ${turn} `.repeat(60), metadata: null },
      { role: "assistant", content: `assistant ${turn} `.repeat(60), metadata: null },
    ]);
  }
  return id;
}

function harness() {
  const sent: Array<any> = [];
  const pushes: Array<Record<string, string>> = [];
  const server = {
    sendTo: mock((_client: unknown, event: unknown) => { sent.push(event); }),
    broadcast: mock(() => {}), sendToSubscribers: mock(() => {}), sendToSubscribersExcept: mock(() => {}),
    subscribe: mock(() => {}), unsubscribe: mock(() => {}), hasSubscribers: mock(() => false),
    broadcastHistoryRevisions: mock((revs: Record<string, string>) => { pushes.push(revs); }),
  };
  const handle = createHandler(server as never);
  const client = { capabilities: new Set<string>() };
  const run = async (command: Parameters<typeof handle>[1]) => {
    sent.length = 0;
    await handle(client as never, command);
    return [...sent];
  };
  return { server, run, pushes };
}

describe("history revisions", () => {
  test("move with every change a page can show, and only then", async () => {
    const id = conversation();
    const changes: Array<[string, () => unknown]> = [
      ["append", () => appendMessages(id, [{ role: "user", content: "more", metadata: null }])],
      ["in-place edit", () => { get(id)!.messages[1]!.content = "edited"; markDirty(id, "messages"); }],
      ["trim", () => trimConversation(id, "messages", 1)],
      ["instructions", () => setSystemInstructions(id, "be brief")],
      ["turn start", () => setActiveJob(id, new AbortController(), Date.now())],
      ["turn end", () => clearActiveJob(id)],
      ["folder", () => moveConversationToFolder(id, ensureTopLevelFolder(FOLDER)!.id)],
    ];
    for (const [label, change] of changes) {
      const before = getHistoryRev(id);
      change();
      expect({ label, changed: getHistoryRev(id) !== before }).toEqual({ label, changed: true });
    }
    // An edit or rewind cuts the history back.
    const beforeUnwind = getHistoryRev(id);
    expect(await unwindTo(id, 2)).not.toBeNull();
    expect(getHistoryRev(id)).not.toBe(beforeUnwind);
    // Reading, opening and unread state leave it alone.
    const { run } = harness();
    const stable = getHistoryRev(id);
    markUnread(id);
    await run({ type: "load_conversation", reqId: "open", convId: id, turns: 2 });
    clearUnread(id);
    expect(getHistoryRev(id)).toBe(stable);
  });

  test("ride every page, which a peek fetches without opening anything", async () => {
    const id = conversation();
    const { server, run } = harness();
    markUnread(id);
    const open = { type: "load_conversation" as const, reqId: "open", convId: id, turns: 2, initialBackfill: { reqId: "backfill", turns: 2 } };
    const peeked = await run({ ...open, peek: true });
    expect(peeked.map(event => event.type)).toEqual(["conversation_loaded", "conversation_history_loaded"]);
    expect(peeked[0].historyRev).toBe(getHistoryRev(id));
    expect(peeked[1].historyRev).toBe(getHistoryRev(id));
    expect(server.subscribe).not.toHaveBeenCalled();
    expect(getSummary(id)?.unread).toBe(true);
    // Cached hashes make it a delta like any page.
    const hashes = peeked[0].entries.map((entry: unknown) => historyEntryHash(JSON.stringify(entry)));
    const [warm] = await run({ ...open, peek: true, cachedEntryHashes: hashes });
    expect(warm.entries).toEqual([]);

    // A streaming conversation's peek has no catch-up snapshot either.
    setActiveJob(id, new AbortController(), Date.now());
    expect((await run({ ...open, peek: true })).some(event => event.type === "streaming_started")).toBe(false);
    clearActiveJob(id);

    const opened = await run(open);
    expect(opened[0]).toMatchObject({ type: "conversation_loaded", historyRev: getHistoryRev(id) });
    expect(server.subscribe).toHaveBeenCalledTimes(1);
    expect(getSummary(id)?.unread).toBe(false);
  });

  test("are answered for known conversations and pushed coalesced", async () => {
    setHistoryRevPushDelayForTest(5);
    const a = conversation(1), b = conversation(1);
    const { run, pushes } = harness();
    const [answer] = await run({ type: "get_history_revisions", reqId: "revs", convIds: [a, b, "missing"] });
    expect(answer).toEqual({ type: "history_revisions", reqId: "revs", revs: { [a]: getHistoryRev(a), [b]: getHistoryRev(b) } });
    const [refused] = await run({ type: "get_history_revisions", reqId: "bad", convIds: Array(513).fill(a) });
    expect(refused).toMatchObject({ type: "error", reqId: "bad" });

    appendMessages(a, [{ role: "user", content: "one", metadata: null }]);
    appendMessages(a, [{ role: "user", content: "two", metadata: null }]);
    appendMessages(b, [{ role: "user", content: "three", metadata: null }]);
    for (let i = 0; i < 200 && pushes.length === 0; i++) await Bun.sleep(5);
    expect(pushes).toEqual([{ [a]: getHistoryRev(a), [b]: getHistoryRev(b) }]);
  });

  test("are pushed only to clients that asked, never app clients", () => {
    const server = new DaemonServer("unused", () => {});
    const writes = new Map<string, string[]>();
    const add = (name: string, capabilities: string[], app = false): void => {
      writes.set(name, []);
      const client = {
        id: name, lines: new LineSplitter(), capabilities: new Set(capabilities), subscriptions: new Set(),
        socket: { destroyed: false, write: (line: string) => { writes.get(name)!.push(line); return true; } } as unknown as Socket,
        ...(app ? { app: { name: "app" } } : {}),
      } as unknown as ConnectedClient;
      (server as any).clients.set(name, client);
    };
    add("tui", ["history-revisions"]);
    add("legacy", []);
    add("app", ["history-revisions"], true);
    server.broadcastHistoryRevisions({ c: "x.1" });
    expect(writes.get("tui")!.map(line => JSON.parse(line))).toEqual([{ type: "history_revisions", revs: { c: "x.1" } }]);
    expect(writes.get("legacy")).toEqual([]);
    expect(writes.get("app")).toEqual([]);
  });
});
