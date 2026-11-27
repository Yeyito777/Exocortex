import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../historycursor";
import type { ConversationSummary, ConversationTaskSummary, FolderSummary } from "../messages";
import { renderSidebar } from "../sidebar";
import { termWidth } from "../textwidth";
import { countedActivityIndicator } from "./activityindicator";
import { moveToActiveConversation } from "./navigation";
import { focusSidebarItem } from "./selection";
import { createSidebarState, type SidebarState } from "./state";
import { updateConversationList } from "./updates";

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false, createdAt: sortOrder, updatedAt: sortOrder,
    messageCount: 0, title: id, marked: false, pinned: false, streaming: false, unread: false, sortOrder, ...overrides,
  };
}

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return { id, name: id, parentId: null, createdAt: sortOrder, updatedAt: sortOrder, pinned: false, sortOrder, ...overrides };
}

const wake: ConversationTaskSummary = { id: "w1", kind: "chrono", title: "wake", startedAt: 1, dueAt: 2, chronoMode: "wake" };
const longSleep: ConversationTaskSummary = { id: "s1", kind: "chrono", title: "sleep", startedAt: 1, dueAt: Date.now() + 3_600_000, chronoMode: "sleep" };
const busy = { streaming: true, subagentCount: 2, backgroundTaskCount: 1, tasks: [wake] };
const ACTIVITY = /[◉◆◷$]/;

/**
 * - quiet: muted, streaming, with subagents, a command and a wake, starred and marked
 * - hushed/: a muted folder holding a streaming conversation with tasks
 * - work/: not muted; holds a muted streaming conversation with tasks and an idle one
 * - mixed/: not muted; one muted streaming child, one unmuted streaming child with a subagent
 */
function scene(): SidebarState {
  const sidebar = createSidebarState("tree");
  updateConversationList(sidebar, [
    conversation("🔥 quiet", 1, { ...busy, muted: true, notificationsMuted: true, marked: true }),
    conversation("inside-hushed", 2, { ...busy, folderId: "hushed", notificationsMuted: true }),
    conversation("muted-child", 3, { ...busy, folderId: "work", muted: true, notificationsMuted: true }),
    conversation("idle-child", 4, { folderId: "work" }),
    conversation("muted-runner", 5, { ...busy, folderId: "mixed", muted: true, notificationsMuted: true }),
    conversation("live-runner", 6, { folderId: "mixed", streaming: true, subagentCount: 1 }),
    conversation("loud", 7, busy),
  ], [folder("hushed", 1, { muted: true }), folder("work", 2), folder("mixed", 3)]);
  return sidebar;
}

const rowsOf = (sidebar: SidebarState) => renderSidebar(sidebar, 20, true, null).map(row => stripAnsi(row));
const row = (rows: string[], text: string) => rows.find(candidate => candidate.includes(text))!;

describe("muting hides sidebar activity", () => {
  test("a muted streaming conversation shows no dot or task glyphs, but keeps its bell, star and mark", () => {
    const rows = rowsOf(scene());
    const quiet = row(rows, "quiet");
    expect(quiet).not.toMatch(ACTIVITY);
    expect(quiet).toContain("★");
    expect(quiet).toContain("🔥");
    expect(quiet).toContain("🔕");
    expect(termWidth(quiet)).toBe(termWidth(rows[0]));
    // An unmuted conversation doing the same work still shows it.
    expect(row(rows, "loud")).toMatch(/\$ ◷ 2◆ ◉/);
  });

  test("a muted conversation shows no yellow dot for a long sleep either", () => {
    const sidebar = createSidebarState("tree");
    updateConversationList(sidebar, [
      conversation("sleeper", 1, { muted: true, notificationsMuted: true, tasks: [longSleep] }),
      conversation("waiter", 2, { muted: true, notificationsMuted: true, streaming: true, providerWaiting: true }),
    ]);
    const rows = rowsOf(sidebar);
    expect(row(rows, "sleeper")).not.toMatch(ACTIVITY);
    expect(row(rows, "waiter")).not.toMatch(ACTIVITY);
  });

  test("a muted folder shows none of its aggregate indicators, collapsed or open, nor do its conversations", () => {
    const collapsed = rowsOf(scene());
    const hushed = row(collapsed, "hushed/");
    expect(hushed).not.toMatch(ACTIVITY);
    expect(hushed).toContain("🔕");
    expect(hushed).toContain("hushed/ 1");

    const sidebar = scene();
    sidebar.expandedFolderIds.add("hushed");
    const open = rowsOf(sidebar);
    expect(row(open, "hushed/")).not.toMatch(ACTIVITY);
    // Its conversations are muted through it.
    expect(row(open, "inside-hushed")).not.toMatch(ACTIVITY);
  });

  test("a collapsed folder whose only active child is muted shows no indicators; its count still includes it", () => {
    const rows = rowsOf(scene());
    const work = row(rows, "work/");
    expect(work).not.toMatch(ACTIVITY);
    expect(work).toContain("work/ 2");
  });

  test("a collapsed folder counts only its unmuted children's activity", () => {
    const rows = rowsOf(scene());
    // muted-runner ($ ◷ 2◆ ◉) is left out; live-runner (◆ ◉) is counted alone.
    expect(row(rows, "mixed/")).toMatch(/mixed\/ 2 +◆ ◉ │$/);
  });

  test("a folder holding a muted subfolder leaves the subfolder's conversations out", () => {
    const sidebar = createSidebarState("tree");
    updateConversationList(sidebar, [
      conversation("deep", 1, { ...busy, folderId: "inner", notificationsMuted: true }),
    ], [folder("outer", 1), folder("inner", 1, { parentId: "outer", muted: true })]);
    expect(row(rowsOf(sidebar), "outer/")).not.toMatch(ACTIVITY);
  });

  test("an open folder's muted child shows nothing; its unmuted sibling keeps its indicators", () => {
    const sidebar = scene();
    sidebar.expandedFolderIds.add("mixed");
    const rows = rowsOf(sidebar);
    expect(row(rows, "muted-runner")).not.toMatch(ACTIVITY);
    expect(row(rows, "muted-runner")).toContain("🔕");
    expect(row(rows, "live-runner")).toMatch(/◆ ◉ │$/);
  });

  test("Shift+L skips muted conversations, which no longer show as active", () => {
    const sidebar = scene();
    focusSidebarItem(sidebar, { type: "conversation", id: "🔥 quiet" });
    const inputs = { globalIdleConvIds: new Set<string>(), optimisticStreamingConvId: null };
    moveToActiveConversation(sidebar, 1, inputs);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "live-runner" });
    moveToActiveConversation(sidebar, 1, inputs);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "loud" });
  });
});

describe("counted glyphs put the count first", () => {
  test("alone for one, count first for more, 99+ past 99", () => {
    expect(countedActivityIndicator("◆", 0)).toBe("");
    expect(countedActivityIndicator("◆", 1)).toBe("◆ ");
    expect(countedActivityIndicator("◆", 2)).toBe("2◆ ");
    expect(countedActivityIndicator("$", 99)).toBe("99$ ");
    expect(countedActivityIndicator("◷", 100)).toBe("99+◷ ");
  });

  test("a folder's streaming dot counts the same way", () => {
    const sidebar = createSidebarState("tree");
    updateConversationList(sidebar, [
      conversation("a", 1, { folderId: "f", streaming: true }),
      conversation("b", 2, { folderId: "f", streaming: true }),
    ], [folder("f", 1)]);
    expect(row(rowsOf(sidebar), "f/")).toMatch(/f\/ 2 +2◉ │$/);
  });
});
