import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../historycursor";
import type { ConversationSummary, ConversationTaskSummary, FolderSummary } from "../messages";
import { renderSidebar } from "../sidebar";
import { termWidth } from "../textwidth";
import { theme } from "../theme";
import type { SidebarIndicatorPlacement } from "./indicatorplacement";
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

const sleep: ConversationTaskSummary = { id: "s", kind: "chrono", title: "sleep", startedAt: 1, dueAt: Date.now() + 3_600_000, chronoMode: "sleep" };
const wake: ConversationTaskSummary = { id: "w", kind: "chrono", title: "wake", startedAt: 1, dueAt: 2, chronoMode: "wake" };
const streaming = { streaming: true };
const unread = { unread: true };

/**
 * busy/: 3 streaming, 2 unread (blue 3, green 2)
 * waits/: one in a long sleep, one queued for the global idle gate, one streaming (yellow 2, blue 1)
 * inbox/: 2 unread only (green 2, where the badge was)
 * tasks/: one streaming with subagents and a command, one with a wake, one unread
 * single/: one streaming child (a bare dot)
 * hush/: a streaming child and an unread child, both muted, and one unmuted streaming
 * quiet/: a muted folder with streaming and unread children
 */
function scene(): { sidebar: SidebarState; globalIdle: Set<string> } {
  const sidebar = createSidebarState("tree");
  const convs: ConversationSummary[] = [];
  let n = 0;
  const add = (folderId: string, overrides: Partial<ConversationSummary>, id = `${folderId}-${n}`) => {
    convs.push(conversation(id, n++, { folderId, ...overrides }));
  };
  for (let i = 0; i < 3; i++) add("busy", streaming);
  for (let i = 0; i < 2; i++) add("busy", unread);
  add("waits", { tasks: [sleep] });
  add("waits", {}, "queued");
  add("waits", streaming);
  for (let i = 0; i < 2; i++) add("inbox", unread);
  add("tasks", { streaming: true, subagentCount: 2, backgroundTaskCount: 1 });
  add("tasks", { tasks: [wake] });
  add("tasks", unread);
  add("single", streaming);
  add("hush", { streaming: true, muted: true, notificationsMuted: true });
  add("hush", { unread: false, muted: true, notificationsMuted: true });
  add("hush", streaming);
  add("quiet", { streaming: true, notificationsMuted: true });
  add("quiet", { notificationsMuted: true });
  updateConversationList(sidebar, convs, ["busy", "waits", "inbox", "tasks", "single", "hush", "quiet"]
    .map((id, i) => folder(id, i, id === "quiet" ? { muted: true } : {})));
  return { sidebar, globalIdle: new Set(["queued"]) };
}

function render(placement: SidebarIndicatorPlacement) {
  const { sidebar, globalIdle } = scene();
  const rows = renderSidebar(sidebar, 20, true, null, globalIdle, null, null, placement);
  const find = (name: string) => rows.find(row => stripAnsi(row).includes(`📁 ${name}/`))!;
  return { rows, find, plain: (name: string) => stripAnsi(find(name)) };
}

const right = render({ folders: "right", conversations: "right" });
const after = render({ folders: "after", conversations: "after" });
const blue = (text: string) => `${theme.accent}${text}`;
const yellow = (text: string) => `${theme.warning}${text}`;
const green = (text: string) => `${theme.success}${text}`;

describe("collapsed folders count their children's dots by colour", () => {
  test("right: one counted dot per state, outermost, in the order yellow, blue, green", () => {
    expect(right.plain("busy")).toMatch(/busy\/ 5 +3◉ 2◉ │$/);
    expect(right.find("busy")).toContain(blue("3◉ "));
    expect(right.find("busy")).toContain(green("2◉ "));

    expect(right.plain("waits")).toMatch(/waits\/ 3 +2◉ ◉ │$/);
    expect(right.find("waits")).toContain(yellow("2◉ "));
    expect(right.find("waits")).toContain(blue("◉ "));

    // Only unread: the green count sits at the edge, where the red badge was.
    expect(right.plain("inbox")).toMatch(/inbox\/ 2 +2◉ │$/);
    expect(right.find("inbox")).toContain(green("2◉ "));

    // Tasks come first, then yellow (the wake is not a long sleep), blue and green.
    expect(right.plain("tasks")).toMatch(/tasks\/ 3 +\$ ◷ 2◆ ◉ ◉ │$/);
    const tasksRow = right.find("tasks");
    expect(tasksRow.indexOf(blue("◉ "))).toBeLessThan(tasksRow.indexOf(green("◉ ")));

    // One child: a bare dot.
    expect(right.plain("single")).toMatch(/single\/ 1 +◉ │$/);
  });

  test("after: the same dots right after the name, mirrored: green, blue, yellow, then the tasks", () => {
    expect(after.plain("busy")).toMatch(/busy\/ 5 2◉ 3◉ +│$/);
    expect(after.find("busy").indexOf(green("2◉ "))).toBeLessThan(after.find("busy").indexOf(blue("3◉ ")));
    expect(after.plain("waits")).toMatch(/waits\/ 3 ◉ 2◉ +│$/);
    expect(after.find("waits").indexOf(blue("◉ "))).toBeLessThan(after.find("waits").indexOf(yellow("2◉ ")));
    expect(after.plain("inbox")).toMatch(/inbox\/ 2 2◉ +│$/);
    expect(after.plain("tasks")).toMatch(/tasks\/ 3 ◉ ◉ 2◆ ◷ \$ +│$/);
  });

  test("folder rows no longer show the red unread badge; every row keeps its width", () => {
    for (const { rows } of [right, after]) {
      for (const row of rows) {
        if (stripAnsi(row).includes("📁")) expect(row).not.toContain(theme.notificationBg);
        expect(termWidth(stripAnsi(row))).toBe(termWidth(stripAnsi(rows[0])));
      }
    }
  });

  test("muted children add nothing; a muted folder shows only its bell", () => {
    // hush/: only the unmuted streaming child counts.
    expect(right.plain("hush")).toMatch(/hush\/ 3 +◉ │$/);
    expect(right.find("hush")).toContain(blue("◉ "));
    expect(right.plain("quiet")).toMatch(/quiet\/ 2 +🔕│$/);
    expect(right.plain("quiet")).not.toMatch(/[◉◆◷$]/);
  });

  test("open folders still show no aggregate dots", () => {
    const { sidebar, globalIdle } = scene();
    sidebar.expandedFolderIds.add("busy");
    const rows = renderSidebar(sidebar, 20, true, null, globalIdle, null, null, { folders: "right", conversations: "right" });
    expect(stripAnsi(rows.find(row => stripAnsi(row).includes("📂 busy/"))!)).not.toMatch(/◉/);
  });

  test("before keeps the old folder row: one dot by the busiest state and the red unread badge", () => {
    const before = render({ folders: "before", conversations: "before" });
    expect(before.plain("busy")).toMatch(/^[▸ ] 3◉ 📁 busy\/ 5 +2 │$/);
    expect(before.find("busy")).toContain(blue("3◉ "));
    expect(before.find("busy")).toContain(theme.notificationBg);
    expect(before.plain("inbox")).toMatch(/^[▸ ] ◉ 📁 inbox\/ 2 +2 │$/);
    expect(before.find("inbox")).toContain(green("◉ "));
    expect(before.find("inbox")).toContain(theme.notificationBg);
  });
});
