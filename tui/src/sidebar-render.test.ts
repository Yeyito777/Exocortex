import { describe, expect, test } from "bun:test";
import { createSidebarState, renderSidebar } from "./sidebar";
import type { ConversationSummary } from "./messages";
import { SIDEBAR_WIDTH } from "./sidebar/layout";
import { theme } from "./theme";
import { visibleLength } from "./textwidth";

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

describe("sidebar rendering", () => {
  test("keeps visual selection marker muted on the current conversation", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("current", 0, { title: "Current conversation" }),
      conversation("selected", 1, { title: "Selected conversation" }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "selected" };
    sidebar.selectedId = "selected";
    sidebar.selectedIndex = 1;
    sidebar.visualAnchor = { type: "conversation", id: "current" };

    const rows = renderSidebar(sidebar, 8, true, "current");
    const currentRow = rows.find(row => row.includes("Current conversation"));

    expect(currentRow).toBeDefined();
    expect(currentRow).toContain(`${theme.muted}│ ${theme.text}${theme.bold}Current conversation`);
  });

  test("renders conversations with global-idle queued messages using a yellow streaming indicator", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("queued", 0, { title: "Queued conversation" }),
      conversation("plain", 1, { title: "Plain conversation" }),
    ];

    const rows = renderSidebar(sidebar, 8, true, null, new Set(["queued"]));
    const queuedRow = rows.find(row => row.includes("Queued conversation"));
    const plainRow = rows.find(row => row.includes("Plain conversation"));

    expect(queuedRow).toContain(`${theme.warning}◉ `);
    expect(plainRow).not.toContain("◉ ");
  });

  test("propagates global-idle indicators to containing folders", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [{ id: "folder", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 }];
    sidebar.conversations = [
      conversation("queued", 0, { title: "Queued conversation", folderId: "folder" }),
    ];

    const rows = renderSidebar(sidebar, 8, true, null, new Set(["queued"]));
    const folderRow = rows.find(row => row.includes("Work"));

    expect(folderRow).toContain(`${theme.warning}◉ `);
  });

  test("counts streaming conversations recursively on folder indicators", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "work", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
      { id: "nested", name: "Nested", parentId: "work", createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    sidebar.conversations = [
      conversation("direct", 0, { title: "Direct", folderId: "work", streaming: true }),
      conversation("nested-stream", 1, { title: "Nested stream", folderId: "nested", streaming: true }),
      conversation("nested-idle", 2, { title: "Nested idle", folderId: "nested" }),
    ];

    let rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Work"))).toContain(`${theme.accent}◉2 `);

    sidebar.currentFolderId = "work";
    rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Nested"))).toContain(`${theme.accent}◉ `);
    expect(rows.find(row => row.includes("Nested"))).not.toContain("◉1 ");
    expect(rows.find(row => row.includes("Direct"))).toContain(`${theme.accent}◉ `);
    expect(rows.find(row => row.includes("Direct"))).not.toContain("◉1 ");
    expect(rows.every(row => visibleLength(row) === SIDEBAR_WIDTH)).toBe(true);
  });

  test("renders managed background task counts on conversations and containing folders", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [{ id: "folder", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 }];
    sidebar.conversations = [
      conversation("worker", 0, { title: "Worker", folderId: "folder", backgroundTaskCount: 2 }),
      conversation("plain", 1, { title: "Plain", folderId: "folder" }),
    ];

    let rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Work"))).toContain(`${theme.warning}$2 `);

    sidebar.currentFolderId = "folder";
    rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Worker"))).toContain(`${theme.warning}$2 `);
    expect(rows.find(row => row.includes("Plain"))).not.toContain("$2 ");
    expect(rows.every(row => visibleLength(row) === SIDEBAR_WIDTH)).toBe(true);
  });

  test("marks overflowing background task counts explicitly", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [conversation("worker", 0, { title: "Worker", backgroundTaskCount: 100 })];

    const rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Worker"))).toContain(`${theme.warning}$99+ `);
  });

  test("renders Chrono, subagent, and shell indicators after the streaming indicator without a goal badge", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [conversation("worker", 0, {
      title: "Worker",
      streaming: true,
      subagentCount: 2,
      backgroundTaskCount: 2,
      tasks: [
        { id: "child", kind: "subagent", title: "Child", startedAt: 0 },
        { id: "shell", kind: "background", title: "Build", startedAt: 0 },
        { id: "chrono-1", kind: "chrono", title: "Wake one", startedAt: 0, chronoMode: "wake" },
        { id: "chrono-2", kind: "chrono", title: "Sleep", startedAt: 0, chronoMode: "sleep" },
        { id: "chrono-wait", kind: "chrono", title: "Wait for shell", startedAt: 0, chronoMode: "wait" },
      ],
      goal: { objective: "Ship it", status: "active", createdAt: 0, updatedAt: 0, turns: 0 },
    })];

    const row = renderSidebar(sidebar, 8, true, null).find(candidate => candidate.includes("Worker"));
    expect(row).toContain(`${theme.accent}◉ `);
    expect(row).toContain(`${theme.accent}◆2 `);
    expect(row).toContain(`${theme.warning}$2 `);
    expect(row).toContain(`${theme.success}◷ `);
    expect(row).not.toContain(`${theme.success}◷2 `);
    expect(row).not.toContain(`${theme.tool}◆ `);
    expect(row!.indexOf("◉ ")).toBeLessThan(row!.indexOf("◷ "));
    expect(row!.indexOf("◷ ")).toBeLessThan(row!.indexOf("◆2 "));
    expect(row!.indexOf("◆2 ")).toBeLessThan(row!.indexOf("$2 "));
    expect(visibleLength(row!)).toBe(SIDEBAR_WIDTH);
  });

  test("shows deferred Chrono sleeps while omitting live sleeps and waits", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [{ id: "folder", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 }];
    sidebar.conversations = [
      conversation("deferred-sleep", 0, {
        title: "Deferred sleep",
        folderId: "folder",
        tasks: [{ id: "chrono-long-sleep", kind: "chrono", title: "Sleep for ten minutes", startedAt: 0, chronoMode: "sleep" }],
      }),
      conversation("live-sleep", 1, {
        title: "Live sleep",
        folderId: "folder",
        streaming: true,
        tasks: [{ id: "chrono-short-sleep", kind: "chrono", title: "Sleep briefly", startedAt: 0, chronoMode: "sleep" }],
      }),
      conversation("waiting", 2, {
        title: "Waiting",
        folderId: "folder",
        tasks: [{ id: "chrono-wait", kind: "chrono", title: "Wait for build", startedAt: 0, chronoMode: "wait" }],
      }),
    ];

    let rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Work"))).toContain(`${theme.success}◷ `);

    sidebar.currentFolderId = "folder";
    rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Deferred sleep"))).toContain(`${theme.success}◷ `);
    expect(rows.find(row => row.includes("Live sleep"))).toContain(`${theme.accent}◉ `);
    expect(rows.find(row => row.includes("Live sleep"))).not.toContain("◷");
    expect(rows.find(row => row.includes("Waiting"))).not.toContain("◷");
  });

  test("omits goal badges while aggregating other activity through folder trees", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "work", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
      { id: "nested", name: "Nested", parentId: "work", createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    sidebar.conversations = [
      conversation("active", 0, {
        title: "Active",
        folderId: "nested",
        subagentCount: 2,
        tasks: [
          { id: "chrono-1", kind: "chrono", title: "Wake one", startedAt: 0 },
          { id: "chrono-2", kind: "chrono", title: "Wake two", startedAt: 0 },
        ],
        goal: { objective: "Active goal", status: "active", createdAt: 0, updatedAt: 0, turns: 0 },
      }),
      conversation("paused", 1, {
        title: "Paused",
        folderId: "work",
        subagentCount: 1,
        tasks: [{ id: "chrono-3", kind: "chrono", title: "Wake three", startedAt: 0 }],
        goal: { objective: "Paused goal", status: "paused", createdAt: 0, updatedAt: 0, turns: 0 },
      }),
    ];

    let rows = renderSidebar(sidebar, 8, true, null);
    const workRow = rows.find(row => row.includes("Work"));
    expect(workRow).toContain(`${theme.accent}◆3 `);
    expect(workRow).toContain(`${theme.success}◷3 `);
    expect(workRow).not.toContain(`${theme.tool}◆ `);

    sidebar.currentFolderId = "work";
    rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Nested"))).toContain(`${theme.accent}◆2 `);
    expect(rows.find(row => row.includes("Nested"))).toContain(`${theme.success}◷2 `);
    expect(rows.find(row => row.includes("Nested"))).not.toContain(`${theme.tool}◆ `);
    expect(rows.find(row => row.includes("Paused"))).toContain(`${theme.accent}◆ `);
    expect(rows.find(row => row.includes("Paused"))).toContain(`${theme.success}◷ `);
    expect(rows.find(row => row.includes("Paused"))).not.toContain(`${theme.tool}◆ `);
    expect(rows.find(row => row.includes("Paused"))).not.toContain(`${theme.tool}◇ `);
    expect(rows.every(row => visibleLength(row) === SIDEBAR_WIDTH)).toBe(true);
  });

  test("renders a right-aligned badge counting unread conversations in a folder tree", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "work", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
      { id: "nested", name: "Nested", parentId: "work", createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    sidebar.conversations = [
      conversation("read", 0, { folderId: "work" }),
      conversation("unread-direct", 1, { folderId: "work", unread: true }),
      conversation("unread-nested", 2, { folderId: "nested", unread: true }),
      conversation("unread-root", 3, { unread: true }),
    ];

    const rows = renderSidebar(sidebar, 8, true, null);
    const folderRow = rows.find(row => row.includes("Work"));

    expect(folderRow).toBeDefined();
    expect(folderRow).toContain(`${theme.notificationBg}${theme.notificationFg} 2 ${theme.reset}`);
    expect(visibleLength(folderRow!)).toBe(SIDEBAR_WIDTH);
  });

  test("does not count streaming unread conversations in folder notification badges", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "work", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    sidebar.conversations = [
      conversation("settled", 0, { folderId: "work", unread: true }),
      conversation("still-streaming", 1, { folderId: "work", unread: true, streaming: true }),
    ];

    const folderRow = renderSidebar(sidebar, 8, true, null).find(row => row.includes("Work"));

    expect(folderRow).toContain(`${theme.accent}◉ `);
    expect(folderRow).toContain(`${theme.notificationBg}${theme.notificationFg} 1 ${theme.reset}`);
    expect(folderRow).not.toContain(`${theme.notificationBg}${theme.notificationFg} 2 ${theme.reset}`);
  });

  test("keeps queued turn chains blue and shows their final unread state immediately", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "work", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    const queuedTurn = conversation("queued-chain", 0, { folderId: "work", unread: true, streaming: true });
    sidebar.conversations = [queuedTurn];

    let folderRow = renderSidebar(sidebar, 8, true, null).find(row => row.includes("Work"));
    expect(folderRow).toContain(`${theme.accent}◉ `);
    expect(folderRow).not.toContain(theme.notificationBg);

    const finalCompletion = { ...queuedTurn, streaming: false };
    sidebar.conversations = [finalCompletion];

    folderRow = renderSidebar(sidebar, 8, true, null).find(row => row.includes("Work"));
    expect(folderRow).toContain(`${theme.notificationBg}${theme.notificationFg} 1 ${theme.reset}`);
  });

  test("renders canonical unread state without interpreting reserved folder names", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "subagents", name: " SubAgents ", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
      { id: "batch", name: "Batch", parentId: "subagents", createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    sidebar.conversations = [
      conversation("direct-agent", 0, { folderId: "subagents", unread: true }),
      conversation("nested-agent", 1, { folderId: "batch", unread: true }),
      conversation("ordinary", 2, { unread: true }),
    ];

    let rows = renderSidebar(sidebar, 8, true, null);
    const subagentsRow = rows.find(row => row.includes("SubAgents"));
    expect(subagentsRow).toContain(`${theme.success}◉ `);
    expect(subagentsRow).toContain(`${theme.notificationBg}${theme.notificationFg} 2 ${theme.reset}`);
    expect(rows.find(row => row.includes("ordinary"))).toContain(`${theme.success}◉ `);

    sidebar.currentFolderId = "subagents";
    rows = renderSidebar(sidebar, 8, true, null);
    const batchRow = rows.find(row => row.includes("Batch"));
    expect(batchRow).toContain(`${theme.success}◉ `);
    expect(batchRow).toContain(`${theme.notificationBg}${theme.notificationFg} 1 ${theme.reset}`);
    expect(rows.find(row => row.includes("direct-agent"))).toContain(`${theme.success}◉ `);

    sidebar.currentFolderId = "batch";
    rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("nested-agent"))).toContain(`${theme.success}◉ `);
  });

  test("renders a right-aligned mute bell instead of completion notifications", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [conversation("muted", 0, {
      title: "Muted conversation",
      muted: true,
      notificationsMuted: true,
      unread: true,
    })];

    const row = renderSidebar(sidebar, 8, true, null).find(candidate => candidate.includes("Muted conversation"));

    expect(row).toContain("🔕");
    expect(row).not.toContain(`${theme.success}◉ `);
    expect(row).not.toContain(theme.notificationBg);
    expect(visibleLength(row!)).toBe(SIDEBAR_WIDTH);
  });

  test("muted folders keep live streaming indicators while replacing unread badges", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [{
      id: "muted-folder",
      name: "Muted folder",
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      pinned: false,
      muted: true,
      sortOrder: 0,
    }];
    sidebar.conversations = [conversation("streaming", 0, {
      folderId: "muted-folder",
      streaming: true,
      unread: true,
      notificationsMuted: true,
    })];

    const row = renderSidebar(sidebar, 8, true, null).find(candidate => candidate.includes("Muted folder"));

    expect(row).toContain(`${theme.accent}◉ `);
    expect(row).toContain("🔕");
    expect(row).not.toContain(theme.notificationBg);
    expect(visibleLength(row!)).toBe(SIDEBAR_WIDTH);
  });
});
