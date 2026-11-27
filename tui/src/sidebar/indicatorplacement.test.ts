import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../historycursor";
import type { ConversationSummary, ConversationTaskSummary, FolderSummary } from "../messages";
import { termWidth } from "../textwidth";
import { focusConversationById, renderSidebar } from "../sidebar";
import { resolveSidebarIndicatorPlacement, type SidebarIndicatorPlacement } from "./indicatorplacement";
import { createSidebarState, type SidebarState } from "./state";
import { updateConversationList } from "./updates";
// Rows rendered by the sidebar before tui.sidebarIndicators existed (main at
// dfca0238), for the two scenes below. "before" must reproduce them byte for byte.
import beforeGolden from "./indicatorplacement.before.json";

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false, createdAt: sortOrder, updatedAt: sortOrder,
    messageCount: 0, title: id, marked: false, pinned: false, streaming: false, unread: false, sortOrder, ...overrides,
  };
}

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return { id, name: id, parentId: null, createdAt: sortOrder, updatedAt: sortOrder, pinned: false, sortOrder, ...overrides };
}

/** Every kind of icon on folder and conversation rows, collapsed and open folders, long names, mute and unread. */
function scene(): SidebarState {
  const wake: ConversationTaskSummary = { id: "w1", kind: "chrono", title: "wake", startedAt: 1, dueAt: 2, chronoMode: "wake" };
  const sidebar = createSidebarState("tree");
  updateConversationList(sidebar, [
    conversation("busy", 1, { folderId: "work", streaming: true, subagentCount: 2, backgroundTaskCount: 1, tasks: [wake] }),
    conversation("quiet", 2, { folderId: "work", unread: true }),
    conversation("child", 3, { folderId: "open", streaming: true }),
    conversation("deep", 4, { folderId: "long", unread: true, subagentCount: 1 }),
    conversation("hushed", 5, { folderId: "muted", unread: true, streaming: true }),
    conversation("root streaming", 6, { streaming: true }),
    conversation("🔥 marked and starred", 7, { marked: true, subagentCount: 3 }),
    conversation("a conversation title far too long for the sidebar", 8, { subagentCount: 1, backgroundTaskCount: 1, tasks: [wake] }),
    conversation("current", 9, { unread: true, muted: true }),
    conversation("plain", 10),
  ], [
    folder("work", 1), folder("open", 2),
    folder("long", 3, { name: "a folder name far too long for the sidebar" }), folder("muted", 4, { muted: true }),
  ]);
  sidebar.expandedFolderIds.add("open");
  return sidebar;
}

/** The scene as it is, then with the cursor on a conversation inside the expanded `work` folder. */
function render(placement: SidebarIndicatorPlacement): string[][] {
  return [null, "busy"].map(selected => {
    const sidebar = scene();
    if (selected) focusConversationById(sidebar, selected);
    return renderSidebar(sidebar, 20, true, "current", new Set(), null, null, placement);
  });
}

const plain = (frames: string[][]) => frames.map(rows => rows.map(row => stripAnsi(row)));

describe("tui.sidebarIndicators", () => {
  test("before for both reproduces the sidebar from before the setting, byte for byte", () => {
    expect(render({ folders: "before", conversations: "before" })).toEqual(beforeGolden);
  });

  test("after for both puts every icon after the name and keeps rows full width", () => {
    const [collapsed, expanded] = plain(render({ folders: "after", conversations: "after" }));
    expect(collapsed.slice(2, 12)).toEqual([
      "▸ 📁 work/ 2 ◉ ◆2 ◷ $    1 │",
      "  📂 open/                 │",
      "    child ◉                │",
      "  📁 a folder nam… ◉ ◆   1 │",
      "  📁 muted/ 1 ◉          🔕│",
      "  root streaming ◉         │",
      "  marked and star… ◆3 ★ 🔥 │",
      "  a conversation ti… ◆ ◷ $ │",
      "  current                🔕│",
      "  plain                    │",
    ]);
    expect(expanded[3]).toBe("▸   busy ◉ ◆2 ◷ $          │");
    for (const row of [...collapsed, ...expanded]) expect(termWidth(row)).toBe(termWidth(collapsed[0]));
  });

  test("folders and conversations are set separately", () => {
    const [foldersAfter] = plain(render({ folders: "after", conversations: "before" }));
    expect(foldersAfter[2]).toBe("▸ 📁 work/ 2 ◉ ◆2 ◷ $    1 │");
    expect(foldersAfter[7]).toBe("  ◉ root streaming         │");
    const [conversationsAfter] = plain(render({ folders: "before", conversations: "after" }));
    expect(conversationsAfter[2]).toBe("▸ ◉ ◆2 ◷ $ 📁 work/ 2    1 │");
    expect(conversationsAfter[7]).toBe("  root streaming ◉         │");
  });

  test("right puts every icon at the row's right end, one column in from the border or left of the mute bell and unread badge", () => {
    const [collapsed, expanded] = plain(render({ folders: "right", conversations: "right" }));
    expect(collapsed.slice(2, 12)).toEqual([
      "▸ 📁 work/ 2   ◉ ◆2 ◷ $  1 │",
      "  📂 open/                 │",
      "    child                ◉ │",
      "  📁 a folder name… ◉ ◆  1 │",
      "  📁 muted/ 1          ◉ 🔕│",
      "  root streaming         ◉ │",
      "  marked and star… ◆3 ★ 🔥 │",
      "  a conversation ti… ◆ ◷ $ │",
      "  current                🔕│",
      "  plain                    │",
    ]);
    expect(expanded[3]).toBe("▸   busy          ◉ ◆2 ◷ $ │");
    for (const row of [...collapsed, ...expanded]) expect(termWidth(row)).toBe(termWidth(collapsed[0]));
  });

  test("right: rows without a badge or bell end their icons in one column, one in from the border; a badge or bell takes the edge, one space after them", () => {
    const [rows] = plain(render({ folders: "right", conversations: "right" }));
    const edge = termWidth(rows[0]) - 1; // the border's column
    const iconsEnd = (row: string) => termWidth(row.replace(/[^◉◆◷$★🔥\d]*$/u, ""));
    // No badge or bell: one empty column between the last icon and the border.
    for (const title of ["child", "root streaming", "marked and star", "a conversation ti"]) {
      expect(iconsEnd(rows.find(row => row.includes(title))!)).toBe(edge - 1);
    }
    // One plain space, then the unread badge (` 1 `, padded on its red background) or the mute bell.
    expect(rows.find(row => row.includes("work/"))).toMatch(/◷ \$ {2}1 │$/);
    expect(rows.find(row => row.includes("muted/"))).toMatch(/◉ 🔕│$/);
  });

  test("right: a long name is cut where it would meet the icons, which stay whole", () => {
    const [rows] = plain(render({ folders: "right", conversations: "right" }));
    const long = rows.find(row => row.includes("a conversation"))!;
    expect(long).toMatch(/a conversation ti… ◆ ◷ \$ │$/);
    const folderRow = rows.find(row => row.includes("a folder"))!;
    expect(folderRow).toMatch(/a folder name… ◉ ◆ {2}1 │$/);
  });

  test("config.json values: each side defaults to right; unknown values fall back", () => {
    expect(resolveSidebarIndicatorPlacement(() => ({}))).toEqual({ folders: "right", conversations: "right" });
    expect(resolveSidebarIndicatorPlacement(() => ({ tui: { sidebarIndicators: { folders: "before" } } })))
      .toEqual({ folders: "before", conversations: "right" });
    expect(resolveSidebarIndicatorPlacement(() => ({ tui: { sidebarIndicators: { folders: "left", conversations: "before" } } })))
      .toEqual({ folders: "right", conversations: "before" });
    expect(resolveSidebarIndicatorPlacement(() => ({ tui: { sidebarIndicators: { folders: "after", conversations: "after" } } })))
      .toEqual({ folders: "after", conversations: "after" });
    expect(resolveSidebarIndicatorPlacement(() => ({ tui: { sidebarIndicators: "before" } })))
      .toEqual({ folders: "right", conversations: "right" });
    expect(resolveSidebarIndicatorPlacement(() => { throw new Error("unreadable"); }))
      .toEqual({ folders: "right", conversations: "right" });
  });
});
