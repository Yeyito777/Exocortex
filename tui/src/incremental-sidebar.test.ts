import { describe, expect, test } from "bun:test";
import { sidebarFirstPageConversationIds, sidebarFolderConversationCounts, type SidebarViewHint } from "@exocortex/shared/sidebar-first-page";
import { handleEvent } from "./events";
import { createInitialState } from "./state";
import { renderSidebar } from "./sidebar/render";
import type { ConversationSummary, FolderSummary } from "./messages";
import type { Event } from "./protocol";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function conversation(id: string, folderId: string | null, sortOrder: number, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, provider: "openai", model: "m", effort: "high", fastMode: false, createdAt: 1, updatedAt: 1, messageCount: 1,
    title: id, marked: false, pinned: false, streaming: false, unread: false, sortOrder, folderId, ...extra,
  } as ConversationSummary;
}

function folder(id: string, sortOrder: number, parentId: string | null = null): FolderSummary {
  return { id, name: id, parentId, createdAt: 1, updatedAt: 1, pinned: false, sortOrder };
}

/** A daemon's two-part bootstrap list for this view, as handler.ts builds it. */
function bootstrap(conversations: ConversationSummary[], folders: FolderSummary[], view: SidebarViewHint) {
  const first = new Set([...sidebarFirstPageConversationIds(conversations, folders, view), ...view.conversationIds]);
  for (const c of conversations) if (c.streaming || c.unread || (c.tasks?.length ?? 0) > 0) first.add(c.id);
  const page: Event = {
    type: "conversations_list", folders,
    conversations: conversations.filter(c => first.has(c.id)),
    sidebarPartial: { remaining: conversations.length - first.size, folderConversationCounts: sidebarFolderConversationCounts(conversations, folders) },
  };
  return { page, full: { type: "conversations_list", conversations, folders } as Event };
}

describe("incremental sidebar in the TUI", () => {
  const folders = [folder("work", 1), folder("deep", 2, "work"), folder("archive", 3)];
  const conversations = [
    ...Array.from({ length: 80 }, (_, i) => conversation(`top${i}`, null, 10 + i)),
    ...Array.from({ length: 300 }, (_, i) => conversation(`w${i}`, "work", i)),
    ...Array.from({ length: 50 }, (_, i) => conversation(`d${i}`, "deep", i)),
    ...Array.from({ length: 200 }, (_, i) => conversation(`a${i}`, "archive", i, i === 150 ? { streaming: true } : {})),
  ];
  const view: SidebarViewHint = { folderView: "tree", currentFolderId: null, expandedFolderIds: ["work"], scrollOffset: 0, rows: 30, conversationIds: ["a199"] };

  test("the first page draws the same sidebar the whole list does: rows, order, folder counts and badges", () => {
    for (const expanded of [["work"], []]) {
      const state = createInitialState();
      state.sidebar.open = true;
      state.sidebar.folderView = "tree";
      state.sidebar.expandedFolderIds = new Set(expanded);
      const { page, full } = bootstrap(conversations, folders, { ...view, expandedFolderIds: expanded });
      handleEvent(page, state, null as never);
      expect(state.sidebar.partial).not.toBeNull();
      expect(state.sidebar.conversations.length).toBeLessThan(conversations.length);
      const firstFrame = renderSidebar(state.sidebar, 30, true, null).join("\n");
      handleEvent(full, state, null as never);
      expect(state.sidebar.partial).toBeNull();
      // Byte for byte, colours included: nothing moves or changes when the rest lands.
      expect(firstFrame).toBe(renderSidebar(state.sidebar, 30, true, null).join("\n"));
      if (expanded.length) expect(stripAnsi(firstFrame)).toContain("deep/ 50");
      else expect(stripAnsi(firstFrame)).toContain("archive/ 200");
    }
  });

  test("a first page doesn't forget saved positions or the open conversation it leaves out", () => {
    const state = createInitialState();
    state.convId = "a10";
    state.conversationScroll.positions.set("w250", 0.5);
    const { page } = bootstrap(conversations, folders, { ...view, conversationIds: [] });
    handleEvent(page, state, null as never);
    expect(state.conversationScroll.positions.get("w250")).toBe(0.5);
    expect(state.convId).toBe("a10");
  });

  test("over /ssh the loading view ends once both the list and tool styles are here, in either order", () => {
    for (const order of [["list", "tools"], ["tools", "list"]] as const) {
      const state = createInitialState();
      state.sshConnecting = { phase: "loading", message: "Loading…" };
      for (const step of order) {
        expect(state.sshConnecting).not.toBeNull();
        handleEvent(step === "list"
          ? bootstrap(conversations, folders, view).page
          : { type: "tools_available", providers: [], tools: [{ name: "bash", label: "Bash", color: "#fff" }] } as unknown as Event,
        state, null as never);
      }
      expect(state.sshConnecting).toBeNull();
    }
  });
});
