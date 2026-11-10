import { describe, expect, test } from "bun:test";
import { buildDisplayRows, createSidebarState, finishedUnreadConversationFrom, type SidebarState } from "./sidebar";
import type { SidebarActivityInputs } from "./sidebar/activityindicator";
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
  return { id, name: id, parentId: null, createdAt: sortOrder, updatedAt: sortOrder, pinned: false, sortOrder, ...overrides };
}

const noActivity: SidebarActivityInputs = { globalIdleConvIds: new Set(), optimisticStreamingConvId: null };

/** Pinned p1, then a, b, an open folder holding c, a collapsed one holding d, and e/f/g that show no green dot. */
function treeSidebar(): SidebarState {
  const sidebar = createSidebarState();
  sidebar.folderView = "tree";
  sidebar.folders = [folder("open", 4), folder("shut", 5)];
  sidebar.expandedFolderIds = new Set(["open"]);
  sidebar.conversations = [
    conversation("p1", 1, { pinned: true, unread: true }),
    conversation("a", 2, { unread: true }),
    conversation("b", 3),
    conversation("c", 1, { folderId: "open", unread: true }),
    conversation("d", 1, { folderId: "shut", unread: true }),
    conversation("e", 6, { unread: true, muted: true }),
    conversation("f", 7, { unread: true, streaming: true }),
    conversation("g", 8, { unread: true }),
  ];
  return sidebar;
}

const inputs: SidebarActivityInputs = { globalIdleConvIds: new Set(["g"]), optimisticStreamingConvId: null };

describe("finishedUnreadConversationFrom", () => {
  test("rows are laid out in the order the tests assume", () => {
    const ids = buildDisplayRows(treeSidebar()).filter(row => row.type === "entry").map(row => row.item?.type === "up" ? ".." : row.item?.id);
    expect(ids).toEqual(["p1", "a", "b", "open", "c", "shut", "e", "f", "g"]);
  });

  test("searches down from the open conversation and wraps past the end to the pinned rows", () => {
    const sidebar = treeSidebar();
    expect(finishedUnreadConversationFrom(sidebar, "b", 1, inputs)).toBe("c");
    // Skips d (collapsed folder), e (muted), f (streaming) and g (global idle).
    expect(finishedUnreadConversationFrom(sidebar, "c", 1, inputs)).toBe("p1");
  });

  test("searches up from the open conversation and wraps past the top", () => {
    const sidebar = treeSidebar();
    expect(finishedUnreadConversationFrom(sidebar, "b", -1, inputs)).toBe("a");
    expect(finishedUnreadConversationFrom(sidebar, "a", -1, inputs)).toBe("p1");
    expect(finishedUnreadConversationFrom(sidebar, "p1", -1, inputs)).toBe("c");
  });

  test("a queued global-idle message is the only thing keeping g from being a target", () => {
    expect(finishedUnreadConversationFrom(treeSidebar(), "c", 1, noActivity)).toBe("g");
  });

  test("never returns the open conversation, and finds nothing when it is the only green row", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [conversation("only", 1, { unread: true }), conversation("idle", 2)];
    expect(finishedUnreadConversationFrom(sidebar, "only", 1, noActivity)).toBeNull();
    expect(finishedUnreadConversationFrom(sidebar, "only", -1, noActivity)).toBeNull();
    expect(finishedUnreadConversationFrom(sidebar, "idle", 1, noActivity)).toBe("only");
  });

  test("an open conversation still waiting on its optimistic send is not a target", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [conversation("x", 1, { unread: true }), conversation("y", 2, { unread: true })];
    expect(finishedUnreadConversationFrom(sidebar, null, 1, { ...noActivity, optimisticStreamingConvId: "x" })).toBe("y");
  });

  test("counts from the sidebar cursor, not the open conversation", () => {
    const sidebar = treeSidebar();
    sidebar.selectedItem = { type: "conversation", id: "c" };
    // Open b would give c going down; the cursor on c gives p1 (wrapping) and a going up.
    expect(finishedUnreadConversationFrom(sidebar, "b", 1, inputs)).toBe("p1");
    expect(finishedUnreadConversationFrom(sidebar, "b", -1, inputs)).toBe("a");
  });

  test("a cursor on a folder row counts from that row", () => {
    const sidebar = treeSidebar();
    sidebar.selectedItem = { type: "folder", id: "shut" };
    expect(finishedUnreadConversationFrom(sidebar, "a", 1, inputs)).toBe("p1");
    expect(finishedUnreadConversationFrom(sidebar, "a", -1, inputs)).toBe("c");
  });

  test("an unlisted open conversation counts from the selection", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("elsewhere", 1)];
    sidebar.conversations = [
      conversation("hidden", 1, { folderId: "elsewhere" }),
      conversation("x", 2, { unread: true }),
      conversation("y", 3),
      conversation("z", 4, { unread: true }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "y" };
    expect(finishedUnreadConversationFrom(sidebar, "hidden", 1, noActivity)).toBe("z");
    expect(finishedUnreadConversationFrom(sidebar, "hidden", -1, noActivity)).toBe("x");
  });
});
