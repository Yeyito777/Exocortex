import { describe, expect, test } from "bun:test";
import { buildDisplayRows, createSidebarState, handleSidebarAction } from "./sidebar";
import type { SidebarActivityInputs } from "./sidebar/activityindicator";
import type { SidebarState } from "./sidebar/state";
import type { ConversationSummary, FolderSummary } from "./messages";

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: sortOrder,
    updatedAt: sortOrder,
    messageCount: 0,
    title: id,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder,
    ...overrides,
  };
}

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    name: id,
    parentId: null,
    createdAt: sortOrder,
    updatedAt: sortOrder,
    pinned: false,
    sortOrder,
    ...overrides,
  };
}

const NO_ACTIVITY: SidebarActivityInputs = { globalIdleConvIds: new Set(), optimisticStreamingConvId: null };

function select(sidebar: SidebarState, id: string): void {
  sidebar.selectedItem = { type: "conversation", id };
  sidebar.selectedId = id;
  sidebar.selectedIndex = sidebar.conversations.findIndex(conv => conv.id === id);
}

function jump(sidebar: SidebarState, action: string, activity: SidebarActivityInputs = NO_ACTIVITY): unknown {
  expect(handleSidebarAction(action, sidebar, activity)).toEqual({ type: "handled" });
  return sidebar.selectedItem;
}

function visibleOrder(sidebar: SidebarState): string[] {
  return buildDisplayRows(sidebar).flatMap(row => row.type === "entry" && row.item && row.item.type !== "up"
    ? [`${row.item.type === "folder" ? "f" : "c"}:${row.item.id}`]
    : []);
}

const longSleep = { id: "chrono:sleep:long", kind: "chrono" as const, title: "Sleeping", startedAt: 1, chronoMode: "sleep" as const };

describe("sidebar folder jumps ([ and ])", () => {
  /** Tree view: pinned folder, then work (open) holding nested client (open) and archive (closed). */
  function tree(): SidebarState {
    const sidebar = createSidebarState("tree");
    sidebar.folders = [
      folder("pinned-folder", 1, { pinned: true }),
      folder("work", 2),
      folder("client", 1, { parentId: "work" }),
      folder("archive", 2, { parentId: "work" }),
      folder("hidden", 1, { parentId: "archive" }),
      folder("last", 3),
    ];
    sidebar.conversations = [
      conversation("top", 0),
      conversation("work-chat", 3, { folderId: "work" }),
      conversation("client-chat", 1, { folderId: "client" }),
      conversation("archived-chat", 1, { folderId: "archive" }),
    ];
    sidebar.expandedFolderIds.add("work");
    sidebar.expandedFolderIds.add("client");
    select(sidebar, "top");
    return sidebar;
  }

  test("the fixture lists pinned and nested folders and hides a collapsed folder's contents", () => {
    const order = visibleOrder(tree());
    expect(order).toContain("f:pinned-folder");
    expect(order).toContain("f:client");
    expect(order).toContain("f:archive");
    expect(order).not.toContain("f:hidden");
    expect(order).not.toContain("c:archived-chat");
  });

  test("] walks every visible folder downward in display order and wraps", () => {
    const sidebar = tree();
    const folders = visibleOrder(sidebar).filter(key => key.startsWith("f:")).map(key => key.slice(2));
    const startRow = visibleOrder(sidebar).indexOf("c:top");
    const after = visibleOrder(sidebar).slice(startRow + 1).filter(key => key.startsWith("f:")).map(key => key.slice(2));
    const expected = [...after, ...folders.filter(id => !after.includes(id))];
    const seen = expected.map(() => (jump(sidebar, "nav_next_folder") as { id: string }).id);
    expect(seen).toEqual(expected);
    expect(seen).not.toContain("hidden");
    // Wrapped: the next ] starts the cycle again.
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "folder", id: expected[0] });
  });

  test("[ walks folders upward and wraps from the first to the last", () => {
    const sidebar = tree();
    const folders = visibleOrder(sidebar).filter(key => key.startsWith("f:")).map(key => key.slice(2));
    sidebar.selectedItem = { type: "folder", id: folders[0] };
    expect(jump(sidebar, "nav_prev_folder")).toEqual({ type: "folder", id: folders[folders.length - 1] });
    expect(jump(sidebar, "nav_prev_folder")).toEqual({ type: "folder", id: folders[folders.length - 2] });
  });

  test("jumps into an open nested folder and skips a collapsed folder's subfolders", () => {
    const sidebar = tree();
    sidebar.selectedItem = { type: "folder", id: "work" };
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "folder", id: "client" });
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "folder", id: "archive" });
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "folder", id: "last" });
    expect(jump(sidebar, "nav_prev_folder")).toEqual({ type: "folder", id: "archive" });
  });

  test("only moves the cursor: nothing opens, expands or collapses", () => {
    const sidebar = tree();
    const expanded = [...sidebar.expandedFolderIds];
    jump(sidebar, "nav_next_folder");
    jump(sidebar, "nav_next_folder");
    expect([...sidebar.expandedFolderIds]).toEqual(expanded);
  });

  test("navigate view jumps among the open folder's subfolders, not the .. row", () => {
    const sidebar = createSidebarState("navigate");
    sidebar.currentFolderId = "work";
    sidebar.folders = [folder("work", 1), folder("a", 1, { parentId: "work" }), folder("b", 2, { parentId: "work" })];
    sidebar.conversations = [conversation("chat", 3, { folderId: "work" })];
    select(sidebar, "chat");
    const folders = visibleOrder(sidebar).filter(key => key.startsWith("f:"));
    expect(folders).toEqual(["f:a", "f:b"]);
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "folder", id: "a" });
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "folder", id: "b" });
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "folder", id: "a" });
    expect(sidebar.currentFolderId).toBe("work");
  });

  test("no folders: the cursor stays put", () => {
    const sidebar = createSidebarState("tree");
    sidebar.conversations = [conversation("a", 1), conversation("b", 2)];
    select(sidebar, "a");
    expect(jump(sidebar, "nav_next_folder")).toEqual({ type: "conversation", id: "a" });
    expect(jump(sidebar, "nav_prev_folder")).toEqual({ type: "conversation", id: "a" });
  });
});

describe("sidebar streaming/waiting jumps ({ and })", () => {
  function list(): SidebarState {
    const sidebar = createSidebarState("tree");
    sidebar.conversations = [
      conversation("c1", 1),
      conversation("streaming", 2, { streaming: true }),
      conversation("idle", 3),
      conversation("unread", 4, { unread: true }),
      conversation("sleeping", 5, { tasks: [longSleep] }),
      conversation("provider-wait", 6, { streaming: true, providerWaiting: true }),
      conversation("c7", 7),
    ];
    select(sidebar, "c1");
    return sidebar;
  }

  test("} visits streaming and waiting conversations downward and wraps; idle and green-unread rows are skipped", () => {
    const sidebar = list();
    const order = visibleOrder(sidebar).filter(key => ["c:streaming", "c:sleeping", "c:provider-wait"].includes(key));
    const ids = order.map(key => key.slice(2));
    const seen = [0, 1, 2, 3].map(() => (jump(sidebar, "nav_next_streaming") as { id: string }).id);
    expect(seen).toEqual([...ids, ids[0]]);
    expect(seen).not.toContain("unread");
    expect(seen).not.toContain("idle");
  });

  test("{ goes upward and wraps from the first match to the last", () => {
    const sidebar = list();
    const ids = visibleOrder(sidebar).filter(key => ["c:streaming", "c:sleeping", "c:provider-wait"].includes(key)).map(key => key.slice(2));
    select(sidebar, ids[0]);
    expect(jump(sidebar, "nav_prev_streaming")).toEqual({ type: "conversation", id: ids[2] });
    expect(jump(sidebar, "nav_prev_streaming")).toEqual({ type: "conversation", id: ids[1] });
  });

  test("the global idle gate and a just-sent message count, from the TUI's activity inputs", () => {
    const sidebar = createSidebarState("tree");
    sidebar.conversations = [conversation("a", 1), conversation("gated", 2), conversation("sent", 3)];
    select(sidebar, "a");
    const activity: SidebarActivityInputs = { globalIdleConvIds: new Set(["gated"]), optimisticStreamingConvId: "sent" };
    const seen = [jump(sidebar, "nav_next_streaming", activity), jump(sidebar, "nav_next_streaming", activity)]
      .map(item => (item as { id: string }).id).sort();
    expect(seen).toEqual(["gated", "sent"]);
    // Without those inputs both are idle.
    select(sidebar, "a");
    expect(jump(sidebar, "nav_next_streaming")).toEqual({ type: "conversation", id: "a" });
  });

  test("no other streaming or waiting conversation: nothing happens", () => {
    const sidebar = createSidebarState("tree");
    sidebar.conversations = [
      conversation("only", 1, { streaming: true }),
      conversation("idle", 2),
      conversation("unread", 3, { unread: true }),
    ];
    select(sidebar, "idle");
    expect(jump(sidebar, "nav_next_streaming")).toEqual({ type: "conversation", id: "only" });
    // The cursor's own row is not a target, so with it the only match nothing moves.
    expect(jump(sidebar, "nav_next_streaming")).toEqual({ type: "conversation", id: "only" });
    expect(jump(sidebar, "nav_prev_streaming")).toEqual({ type: "conversation", id: "only" });

    sidebar.conversations = [conversation("idle", 2), conversation("unread", 3, { unread: true })];
    select(sidebar, "idle");
    expect(jump(sidebar, "nav_next_streaming")).toEqual({ type: "conversation", id: "idle" });
    expect(jump(sidebar, "nav_prev_streaming")).toEqual({ type: "conversation", id: "idle" });
  });

  test("reaches conversations in collapsed folders, expanding them; folders themselves are never stops", () => {
    const sidebar = createSidebarState("tree");
    sidebar.folders = [folder("project", 1), folder("open", 2), { ...folder("deep", 3), parentId: "project" }];
    sidebar.conversations = [
      conversation("root", 0),
      conversation("inside-closed", 1, { folderId: "project", streaming: true }),
      conversation("inside-open", 1, { folderId: "open", tasks: [longSleep] }),
      conversation("nested", 1, { folderId: "deep", streaming: true }),
    ];
    sidebar.expandedFolderIds.add("open");
    select(sidebar, "root");
    const seen = [0, 1, 2].map(() => (jump(sidebar, "nav_next_streaming") as { id: string }).id);
    expect(new Set(seen)).toEqual(new Set(["inside-closed", "inside-open", "nested"]));
    expect([...sidebar.expandedFolderIds].sort()).toEqual(["deep", "open", "project"]);
    expect(buildDisplayRows(sidebar).some(row => row.item?.type === "conversation" && row.item.id === "nested")).toBe(true);
  });

  test("leaves collapsed folders closed when nothing inside them streams", () => {
    const sidebar = createSidebarState("tree");
    sidebar.folders = [folder("quiet", 1)];
    sidebar.conversations = [
      conversation("root", 0),
      conversation("idle-inside", 1, { folderId: "quiet" }),
      conversation("live", 2, { streaming: true }),
    ];
    select(sidebar, "root");
    expect(jump(sidebar, "nav_next_streaming")).toEqual({ type: "conversation", id: "live" });
    expect(sidebar.expandedFolderIds.size).toBe(0);
  });
});
