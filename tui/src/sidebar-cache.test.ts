import { describe, expect, test } from "bun:test";
import { sidebarListDelta, sidebarBucket } from "@exocortex/shared/sidebar-digest";
import { SidebarCache } from "./sidebar-cache";
import type { ConversationSummary, Event, FolderSummary } from "./protocol";

const summary = (i: number, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: `conv-${i}`, provider: "openai", model: "gpt-5.5", effort: "high", fastMode: false,
  createdAt: i, updatedAt: i, messageCount: i, title: `t${i} 🐋`, marked: false, pinned: false, sortOrder: i,
  folderId: null, ...extra,
} as ConversationSummary);
const folders = [{ id: "f1", name: "One", sortOrder: 0 }] as unknown as FolderSummary[];
const list = (conversations: ConversationSummary[], folderList = folders): Event =>
  ({ type: "conversations_list", conversations, folders: folderList });

function daemonAnswer(conversations: ConversationSummary[], folderList: FolderSummary[], cache: SidebarCache, alias = "whale"): Event {
  const digest = cache.beginSync(alias)!;
  expect(digest).not.toBeNull();
  const delta = sidebarListDelta(conversations, folderList, digest);
  return { type: "conversations_list", ...(delta ?? { conversations, folders: folderList }) };
}

const sorted = (event: Event | null) => event?.type === "conversations_list"
  ? event.conversations.map(c => JSON.stringify(c)).sort() : null;

describe("SidebarCache", () => {
  const base = Array.from({ length: 300 }, (_, i) => summary(i));

  test("rebuilds the daemon's list from a digest answer, following events seen meanwhile", () => {
    const cache = new SidebarCache();
    cache.receive(list(base), "whale");
    cache.receive({ type: "conversation_updated", summary: summary(3, { title: "seen live" }) }, "whale");
    cache.receive({ type: "conversation_pinned", convId: "conv-4", pinned: true }, "whale");
    cache.receive({ type: "conversation_deleted", convId: "conv-5" }, "whale");
    // Daemon state after the outage: the live events plus one offline rename.
    const daemon = base.filter(c => c.id !== "conv-5").map(c =>
      c.id === "conv-3" ? summary(3, { title: "seen live" })
      : c.id === "conv-4" ? { ...c, pinned: true }
      : c.id === "conv-9" ? summary(9, { title: "offline rename" }) : c);
    const answer = daemonAnswer(daemon, folders, cache);
    expect(answer.type === "conversations_list" && answer.sidebarBuckets).toEqual([sidebarBucket("conv-9")]);
    const rebuilt = cache.receive(answer, "whale");
    expect(sorted(rebuilt)).toEqual(sorted(list(daemon)));
    expect(rebuilt && "sidebarBuckets" in rebuilt).toBe(false);
    expect(rebuilt?.type === "conversations_list" && rebuilt.folders).toEqual(folders);
  });

  test("an answer without its pinned base asks for a full list", () => {
    const cache = new SidebarCache();
    cache.receive(list(base), "whale");
    const answer = daemonAnswer(base, folders, cache);
    cache.receive(list(base), "whale"); // a full list arrives first and settles the pin
    expect(cache.receive(answer, "whale")).toBeNull();
  });

  test("never offers one host's rows to another", () => {
    const cache = new SidebarCache();
    cache.receive(list(base), "whale");
    expect(cache.beginSync("laptop")).toBeNull();
    cache.receive({ type: "conversation_updated", summary: summary(1) }, "laptop");
    expect(cache.beginSync("whale")).toBeNull();
  });

  test("folder patches keep folder hashes aligned with the daemon", () => {
    const cache = new SidebarCache();
    cache.receive(list(base), "whale");
    const added = { id: "f2", name: "Two", sortOrder: 1 } as unknown as FolderSummary;
    cache.receive({ type: "sidebar_state_patched", folders: [added] }, "whale");
    const answer = daemonAnswer(base, [...folders, added], cache);
    expect(answer.type === "conversations_list" && answer.folders).toBeUndefined();
    const rebuilt = cache.receive(answer, "whale");
    expect(rebuilt?.type === "conversations_list" && rebuilt.folders).toEqual([...folders, added]);
  });
});
