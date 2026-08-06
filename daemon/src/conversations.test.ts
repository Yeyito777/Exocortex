/**
 * Tests for conversations.ts behavior.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationWorkspaceDir, conversationsDir, dataDir, trashedConversationWorkspaceDir, trashDir } from "@exocortex/shared/paths";
import { HistoryUnwindRefreshRequiredError, appendRealtimeCallStatus, appendRealtimeTranscript, bumpToTop, clearUnread, clone, conversationCacheInternalsForTest, create, createFolder, createWithInitialUserMessage, deleteFolder, ensureTopLevelFolder, findTopLevelFolderByName, flush, flushAll, get, getDisplayData, getEffectiveFolderInstructions, getEffectiveSystemInstructions, getFolderInstructions, getQueuedMessageById, getRenderSnapshot, getSummary, getToolOutputs, hasConversation, isUnread, listSidebarState, listRunningConversationIds, loadFromDisk, loadQueuedMessagesFromDisk, mark, markDirty, markUnread, moveConversationToFolder, moveSidebarItem, moveSidebarItems, onChunk, pin, pinFolder, pinSidebarItems, promoteRealtimeTranscript, pushQueuedMessage, redoDelete, releaseHistoryUnwindLease, remove, removeMany, rename, renameFolder, setFolderInstructions, setModel, setSystemInstructions, trimConversation, undoDelete, unwindTo } from "./conversations";
import { setActiveJob, replaceCurrentStreamingBlocks, replaceStreamingDisplayMessages, setStreamingCommittedBlockCount, clearActiveJob, isHistoryUnwindPending } from "./streaming";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, historyPrefixHash } from "./messages";
import { isSqliteConversationStore, load as loadPersisted } from "./persistence";
import { createConversationWorkspace } from "./workspace-service";

const legacyFileTest = isSqliteConversationStore() ? test.skip : test;
const IDS: string[] = [];
const FOLDER_IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `test-conv-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

beforeEach(() => {
  conversationCacheInternalsForTest.resetLimits();
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
  for (const id of FOLDER_IDS.splice(0)) {
    deleteFolder(id);
  }
});

describe("canonical conversation cache", () => {
  test("evicts least-recently-used clean transcripts while retaining indexed existence", () => {
    conversationCacheInternalsForTest.evictClean();
    conversationCacheInternalsForTest.setLimits({ maxEntries: 2, maxFileBytes: Number.MAX_SAFE_INTEGER });
    const first = mkId("cache-first");
    const second = mkId("cache-second");
    const third = mkId("cache-third");

    create(first, "openai", "gpt-5.4", "first");
    create(second, "openai", "gpt-5.4", "second");
    create(third, "openai", "gpt-5.4", "third");

    expect(conversationCacheInternalsForTest.snapshot().ids).toEqual([second, third]);
    expect(hasConversation(first)).toBe(true);
    expect(getSummary(first)?.title).toBe("first");

    expect(get(first)?.id).toBe(first);
    expect(conversationCacheInternalsForTest.snapshot().ids).toEqual([third, first]);
  });

  test("does not evict active or dirty transcripts under cache pressure", () => {
    conversationCacheInternalsForTest.evictClean();
    const active = mkId("cache-active");
    const dirtyId = mkId("cache-dirty");
    create(active, "openai", "gpt-5.4", "active");
    create(dirtyId, "openai", "gpt-5.4", "dirty");
    setActiveJob(active, new AbortController(), Date.now());
    markDirty(dirtyId);

    conversationCacheInternalsForTest.setLimits({ maxEntries: 0, maxFileBytes: 0 });

    expect(conversationCacheInternalsForTest.snapshot().ids).toEqual([active, dirtyId]);
    clearActiveJob(active);
    flush(dirtyId);
    conversationCacheInternalsForTest.evictClean();
    expect(conversationCacheInternalsForTest.snapshot().ids).toEqual([]);
  });
});

describe("realtime transcripts", () => {
  test("persists model-hidden call boundaries without counting them as turns", () => {
    const id = mkId("realtime-call-status");
    create(id, "openai", "gpt-5.4", "Call status");

    expect(appendRealtimeCallStatus(id, "Realtime call started.", 500)).toBe(true);
    expect(appendRealtimeCallStatus(id, "Realtime call ended.", 2_500)).toBe(true);

    const messages = get(id)!.messages;
    expect(messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: "Realtime call started.",
        metadata: expect.objectContaining({ kind: "realtime_call_status" }),
      }),
      expect.objectContaining({
        role: "system",
        content: "Realtime call ended.",
        metadata: expect.objectContaining({ kind: "realtime_call_status" }),
      }),
    ]);
    expect(messages[0]!.metadata?.system).toBeUndefined();
    expect(messages[1]!.metadata?.system).toBeUndefined();
    expect(getSummary(id)?.messageCount).toBe(0);
  });

  test("persists call utterances as ordinary provenance-tagged user and assistant turns", () => {
    const id = mkId("realtime-transcript");
    create(id, "openai", "gpt-5.4", "Call transcript");

    const speaker = {
      kind: "single" as const,
      participants: [{ id: "owner-id", displayName: "Owner", trust: "owner" as const }],
    };
    expect(appendRealtimeTranscript(id, "user", "  What is six plus one?  ", 1_000, {
      callId: "call-discord",
      adapterType: "external",
      adapterId: "discord:paramount:voice",
      speaker,
    })).toBe(true);
    expect(appendRealtimeTranscript(id, "assistant", "Seven.", 2_000, {
      endedAt: 4_500,
      model: "gpt-live-1-boulder-alpha",
      tokens: 3,
      callId: "call-discord",
      adapterType: "external",
      adapterId: "discord:paramount:voice",
      toolName: "discord",
      sourceLabel: "#voice",
      accountAlias: "paramount",
      endpointId: "voice",
    })).toBe(true);

    const messages = get(id)!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "What is six plus one?",
      metadata: { kind: "realtime_transcript", realtimeSpeaker: speaker },
      contextCheckpoint: { version: 1, transcriptHistoryCount: 0 },
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Seven.",
      metadata: {
        startedAt: 2_000,
        endedAt: 4_500,
        model: "gpt-live-1-boulder-alpha",
        tokens: 3,
        realtimeCallId: "call-discord",
        realtimeAdapterType: "external",
        realtimeAdapterId: "discord:paramount:voice",
        realtimeToolName: "discord",
        realtimeSourceLabel: "#voice",
        realtimeAccountAlias: "paramount",
        realtimeEndpointId: "voice",
        kind: "realtime_transcript",
      },
    });
    expect(messages[0]!.metadata?.system).toBeUndefined();
    expect(messages[1]!.metadata?.system).toBeUndefined();
    expect(getSummary(id)?.messageCount).toBe(2);
  });

  test("promotes a matching transcript in place without adding another user turn", () => {
    const id = mkId("realtime-delegation");
    create(id, "openai", "gpt-5.4", "Realtime delegation");
    appendRealtimeTranscript(id, "user", "Please inspect the repository.", 1_000);
    appendRealtimeTranscript(id, "assistant", "I’ll take a look.", 1_500);

    const original = get(id)!.messages[0]!;
    original.contextTokens = {
      version: 1,
      provider: "openai",
      model: "gpt-5.4",
      signature: "stale",
      totalTokens: 10,
      breakdown: {
        userText: 10,
        userImage: 0,
        assistantText: 0,
        toolUse: 0,
        toolResultText: 0,
        toolResultImage: 0,
        thinking: 0,
        providerReasoning: 0,
        systemHint: 0,
      },
      source: "estimated",
      updatedAt: 1_000,
    };

    const replacement = "[realtime delegation]\nTask: Inspect the repository.\nOriginal speech: Please inspect the repository.";
    expect(promoteRealtimeTranscript(id, "Please inspect the repository", replacement)).toBe(true);

    const messages = get(id)!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(original);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: replacement,
      metadata: { startedAt: 1_000, kind: "realtime_transcript" },
      contextCheckpoint: { version: 1, transcriptHistoryCount: 0 },
      contextTokens: null,
    });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "I’ll take a look." });
    expect(loadPersisted(id)?.messages[0]).toMatchObject({
      content: replacement,
      metadata: { startedAt: 1_000, kind: "realtime_transcript" },
      contextTokens: null,
    });
    expect(promoteRealtimeTranscript(id, "unrelated speech", replacement)).toBe(false);
  });

  test("preserves speaker attribution when promoting a call transcript into a delegation", () => {
    const id = mkId("realtime-speaker-promotion");
    create(id, "openai", "gpt-5.4", "Speaker delegation");
    const speaker = {
      kind: "single" as const,
      participants: [{ id: "owner-id", displayName: "Owner", trust: "owner" as const }],
    };
    appendRealtimeTranscript(id, "user", "Inspect this", 1_000, {
      callId: "call-discord",
      adapterType: "external",
      adapterId: "discord:paramount:voice",
      speaker,
    });

    expect(promoteRealtimeTranscript(id, "Inspect this", "[realtime delegation]\nTask: Inspect this", "call-discord")).toBe(true);
    expect(get(id)!.messages[0]?.metadata?.realtimeSpeaker).toEqual(speaker);
  });

  test("promotes only the transcript owned by the delegated call", () => {
    const id = mkId("realtime-delegation-call-id");
    create(id, "openai", "gpt-5.4", "Parallel realtime delegation");
    appendRealtimeTranscript(id, "user", "Check this", 1_000, {
      callId: "call-tui",
      adapterType: "tui",
      adapterId: "local",
    });
    appendRealtimeTranscript(id, "user", "Check this", 2_000, {
      callId: "call-discord",
      adapterType: "external",
      adapterId: "discord:paramount:voice",
      toolName: "discord",
      endpointId: "voice",
    });

    expect(promoteRealtimeTranscript(id, "Check this", "Discord delegated", "call-discord")).toBe(true);
    expect(get(id)!.messages.map(message => message.content)).toEqual(["Check this", "Discord delegated"]);
  });
});

describe("folders", () => {
  function rootRows(ids: string[]): { type: "conversation" | "folder"; id: string; sortOrder: number; pinned: boolean }[] {
    return [
      ...listSidebarState().conversations
        .filter(summary => ids.includes(summary.id) && (summary.folderId ?? null) === null)
        .map(summary => ({ type: "conversation" as const, id: summary.id, sortOrder: summary.sortOrder, pinned: summary.pinned })),
      ...listSidebarState().folders
        .filter(summary => ids.includes(summary.id) && (summary.parentId ?? null) === null)
        .map(summary => ({ type: "folder" as const, id: summary.id, sortOrder: summary.sortOrder, pinned: summary.pinned })),
    ].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder);
  }

  test("ensures a reusable top-level folder by name and moves conversations into it", () => {
    const id = mkId("subagent-folder-move");
    create(id, "openai", "gpt-5.4", "subagent task");

    const folder = ensureTopLevelFolder("subagents")!;
    FOLDER_IDS.push(folder.id);
    expect(folder).toMatchObject({ name: "subagents", parentId: null });
    expect(findTopLevelFolderByName("SUBAGENTS")?.id).toBe(folder.id);
    expect(ensureTopLevelFolder("subagents")?.id).toBe(folder.id);

    expect(moveConversationToFolder(id, folder.id)).toBe(true);
    expect(getSummary(id)?.folderId).toBe(folder.id);
    expect(listSidebarState().conversations.find(summary => summary.id === id)?.folderId).toBe(folder.id);
  });

  test("moving conversations out can insert them immediately before their source folder", () => {
    const beforeId = mkId("folder-before");
    const movedId = mkId("folder-moved");
    create(beforeId, "openai", "gpt-5.4", "before");
    const folder = createFolder(`Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);
    create(movedId, "openai", "gpt-5.4", "moved", undefined, false, folder.id);

    expect(moveSidebarItems([{ type: "conversation", id: movedId }], null, { type: "folder", id: folder.id })).toBe(true);

    const rows = rootRows([beforeId, movedId, folder.id]);
    const folderIndex = rows.findIndex(row => row.id === folder.id);
    expect(folderIndex).toBeGreaterThan(0);
    expect(rows[folderIndex - 1]?.id).toBe(movedId);
    expect(getSummary(movedId)?.folderId ?? null).toBeNull();
  });

  test("deleting a folder unwraps children into the deleted folder's previous slot", () => {
    const afterId = mkId("folder-delete-after");
    const beforeId = mkId("folder-delete-before");
    const childId = mkId("folder-delete-child");

    create(afterId, "openai", "gpt-5.4", "after");
    const folder = createFolder(`Delete Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);
    create(beforeId, "openai", "gpt-5.4", "before");
    create(childId, "openai", "gpt-5.4", "child", undefined, false, folder.id);

    expect(rootRows([beforeId, folder.id, afterId]).map(row => row.id)).toEqual([beforeId, folder.id, afterId]);
    expect(deleteFolder(folder.id, "unwrap")).toBe(true);

    expect(getSummary(childId)?.folderId ?? null).toBeNull();
    expect(rootRows([beforeId, childId, afterId]).map(row => row.id)).toEqual([beforeId, childId, afterId]);
  });

  test("undo restores a safe folder unwrap", () => {
    const childId = mkId("folder-unwrap-undo-child");
    const folder = createFolder(`Undo Unwrap Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);
    create(childId, "openai", "gpt-5.4", "child", undefined, false, folder.id);
    expect(pin(childId, true)).toBe(true);

    expect(deleteFolder(folder.id, "unwrap")).toBe(true);
    expect(getSummary(childId)?.folderId ?? null).toBeNull();

    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)).toMatchObject({ id: folder.id, name: folder.name });
    expect(getSummary(childId)).toMatchObject({ folderId: folder.id, pinned: true });
  });

  test("recursive folder delete removes descendants and undo restores the tree", () => {
    const childId = mkId("folder-recursive-child");
    const nestedChildId = mkId("folder-recursive-nested-child");
    const folder = createFolder(`Recursive Folder ${Date.now()} ${Math.random()}`)!;
    const nested = createFolder(`Nested Folder ${Date.now()} ${Math.random()}`, folder.id)!;
    FOLDER_IDS.push(folder.id, nested.id);
    create(childId, "openai", "gpt-5.4", "child", undefined, false, folder.id);
    create(nestedChildId, "openai", "gpt-5.4", "nested", undefined, false, nested.id);

    expect(deleteFolder(folder.id, "recursive")).toBe(true);
    expect(getSummary(childId)).toBeNull();
    expect(getSummary(nestedChildId)).toBeNull();
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id || candidate.id === nested.id)).toBe(false);

    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)).toMatchObject({ id: folder.id, parentId: null });
    expect(listSidebarState().folders.find(candidate => candidate.id === nested.id)).toMatchObject({ id: nested.id, parentId: folder.id });
    expect(getSummary(childId)).toMatchObject({ folderId: folder.id });
    expect(getSummary(nestedChildId)).toMatchObject({ folderId: nested.id });
  });

  test("a workspace collision blocks recursive-folder undo before exposing ghost folders", () => {
    const childId = mkId("folder-workspace-collision-child");
    const folder = createFolder(`Workspace Collision Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);
    create(childId, "openai", "gpt-5.4", "child", undefined, false, folder.id);
    expect(deleteFolder(folder.id, "recursive")).toBe(true);

    const replacement = conversationWorkspaceDir(childId);
    mkdirSync(replacement, { recursive: true });
    writeFileSync(join(replacement, "foreign.txt"), "foreign");
    expect(undoDelete()).toBeNull();
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id)).toBe(false);
    expect(getSummary(childId)).toBeNull();

    rmSync(replacement, { recursive: true, force: true });
    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id)).toBe(true);
    expect(getSummary(childId)).toMatchObject({ folderId: folder.id });
  });

  test("folder delete undo survives a conversation-store reload", () => {
    const childId = mkId("folder-restart-recursive-child");
    const nestedChildId = mkId("folder-restart-recursive-nested-child");
    const folder = createFolder(`Restart Recursive Folder ${Date.now()} ${Math.random()}`)!;
    const nested = createFolder(`Restart Nested Folder ${Date.now()} ${Math.random()}`, folder.id)!;
    FOLDER_IDS.push(folder.id, nested.id);
    create(childId, "openai", "gpt-5.4", "child", undefined, false, folder.id);
    create(nestedChildId, "openai", "gpt-5.4", "nested", undefined, false, nested.id);

    expect(deleteFolder(folder.id, "recursive")).toBe(true);
    loadFromDisk();
    expect(getSummary(childId)).toBeNull();
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id || candidate.id === nested.id)).toBe(false);

    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)).toMatchObject({ id: folder.id, parentId: null });
    expect(listSidebarState().folders.find(candidate => candidate.id === nested.id)).toMatchObject({ id: nested.id, parentId: folder.id });
    expect(getSummary(childId)).toMatchObject({ folderId: folder.id });
    expect(getSummary(nestedChildId)).toMatchObject({ folderId: nested.id });
  });

  test("folder unwrap undo survives a conversation-store reload", () => {
    const childId = mkId("folder-restart-unwrap-child");
    const folder = createFolder(`Restart Unwrap Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);
    create(childId, "openai", "gpt-5.4", "child", undefined, false, folder.id);

    expect(deleteFolder(folder.id, "unwrap")).toBe(true);
    loadFromDisk();
    expect(getSummary(childId)?.folderId ?? null).toBeNull();
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id)).toBe(false);

    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)).toMatchObject({ id: folder.id, parentId: null });
    expect(getSummary(childId)).toMatchObject({ folderId: folder.id });
  });

  test("undo restores a batch conversation delete as one sidebar entry", () => {
    const ids = [mkId("batch-delete-a"), mkId("batch-delete-b")];
    for (const id of ids) create(id, "openai", "gpt-5.4", id);

    expect(removeMany(ids)).toEqual(ids);
    expect(getSummary(ids[0])).toBeNull();
    expect(getSummary(ids[1])).toBeNull();

    expect(undoDelete()?.type).toBe("conversations");
    expect(getSummary(ids[0])).toMatchObject({ id: ids[0] });
    expect(getSummary(ids[1])).toMatchObject({ id: ids[1] });
  });

  test("creates, trashes, and restores a conversation workspace with its contents", () => {
    const id = mkId("workspace-lifecycle");
    create(id, "openai", "gpt-5.4", "workspace lifecycle");
    const live = conversationWorkspaceDir(id);
    writeFileSync(join(live, "artifact.txt"), "preserved");

    expect(remove(id)).toBe(true);
    expect(existsSync(live)).toBe(false);
    expect(readFileSync(join(trashedConversationWorkspaceDir(id), "artifact.txt"), "utf8")).toBe("preserved");

    expect(undoDelete()?.type).toBe("conversation");
    expect(readFileSync(join(live, "artifact.txt"), "utf8")).toBe("preserved");
  });

  test("blocks undo rather than attaching a colliding replacement workspace", () => {
    const id = mkId("workspace-restore-collision");
    create(id, "openai", "gpt-5.4", "original");
    writeFileSync(join(conversationWorkspaceDir(id), "original.txt"), "original");
    expect(remove(id)).toBe(true);

    const replacement = conversationWorkspaceDir(id);
    mkdirSync(replacement, { recursive: true });
    writeFileSync(join(replacement, "foreign.txt"), "foreign");
    expect(undoDelete()).toBeNull();
    expect(getSummary(id)).toBeNull();
    expect(readFileSync(join(replacement, "foreign.txt"), "utf8")).toBe("foreign");

    rmSync(replacement, { recursive: true, force: true });
    expect(undoDelete()?.type).toBe("conversation");
    expect(readFileSync(join(conversationWorkspaceDir(id), "original.txt"), "utf8")).toBe("original");
  });

  test("reserves a deleted conversation ID until its trash entry is restored", () => {
    const id = mkId("workspace-deleted-id-reserved");
    create(id, "openai", "gpt-5.4", "original");
    expect(remove(id)).toBe(true);

    expect(() => create(id, "openai", "gpt-5.4", "replacement"))
      .toThrow("already exists or is recoverable from trash");
    expect(getSummary(id)).toBeNull();

    expect(undoDelete()?.type).toBe("conversation");
    expect(getSummary(id)).toMatchObject({ id, title: "original" });
  });

  test("gives a clone a separate empty workspace", () => {
    const id = mkId("workspace-clone-source");
    create(id, "openai", "gpt-5.4", "workspace clone");
    writeFileSync(join(conversationWorkspaceDir(id), "source-only.txt"), "source");

    const cloned = clone(id)!;
    IDS.push(cloned.id);
    expect(existsSync(conversationWorkspaceDir(cloned.id))).toBe(true);
    expect(existsSync(join(conversationWorkspaceDir(cloned.id), "source-only.txt"))).toBe(false);
  });

  legacyFileTest("keeps live state when the conversation file cannot be moved to trash", () => {
    const id = mkId("delete-missing-file");
    const conv = create(id, "openai", "gpt-5.6-sol", "missing file");
    rmSync(join(conversationsDir(), `${id}.json`));

    expect(remove(id)).toBe(false);
    expect(get(id)).toBe(conv);

    // Restore a durable file so normal test cleanup can remove the conversation.
    markDirty(id);
    flush(id);
    expect(remove(id)).toBe(true);
  });

  test("undo restores a single sidebar reorder", () => {
    const ids = ["undo-move-a", "undo-move-b", "undo-move-c"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    expect(rootRows(ids).map(row => row.id)).toEqual(ids);

    expect(moveSidebarItem({ type: "conversation", id: ids[1] }, "down")).toBe(true);
    expect(rootRows(ids).map(row => row.id)).toEqual([ids[0], ids[2], ids[1]]);

    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(rootRows(ids).map(row => row.id)).toEqual(ids);
  });

  test("undo restores moving conversations into a folder", () => {
    const id = mkId("undo-move-folder-child");
    create(id, "openai", "gpt-5.4", "child");
    const folder = createFolder(`Undo Move Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);

    expect(moveSidebarItems([{ type: "conversation", id }], folder.id)).toBe(true);
    expect(getSummary(id)?.folderId).toBe(folder.id);

    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(getSummary(id)?.folderId ?? null).toBeNull();
  });

  test("undo removes a created folder and restores items moved into it", () => {
    const ids = [mkId("undo-create-folder-a"), mkId("undo-create-folder-b")];
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);

    const folder = createFolder("Undo Created Folder", null, ids.map(id => ({ type: "conversation" as const, id })))!;
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id)).toBe(true);
    expect(getSummary(ids[0])?.folderId).toBe(folder.id);
    expect(getSummary(ids[1])?.folderId).toBe(folder.id);

    expect(undoDelete()).toEqual({ type: "sidebar_state", folderInstructions: [{ folderId: folder.id, text: "" }] });
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id)).toBe(false);
    expect(getSummary(ids[0])?.folderId ?? null).toBeNull();
    expect(getSummary(ids[1])?.folderId ?? null).toBeNull();
  });

  test("undo restores folder rename, pinning, and instructions", () => {
    const folder = createFolder(`Undo Folder Metadata ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);

    expect(renameFolder(folder.id, "Renamed Folder")).toBe(true);
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)?.name).toBe("Renamed Folder");
    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)?.name).toBe(folder.name);

    expect(pinFolder(folder.id, true)).toBe(true);
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)?.pinned).toBe(true);
    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)?.pinned).toBe(false);

    expect(setFolderInstructions(folder.id, "Remember folder rules.")).toBe(true);
    expect(getFolderInstructions(folder.id)).toBe("Remember folder rules.");
    expect(undoDelete()).toEqual({ type: "sidebar_state", folderInstructions: [{ folderId: folder.id, text: "" }] });
    expect(getFolderInstructions(folder.id)).toBe("");
  });

  test("undo restores conversation mark, rename, pin, and clone sidebar actions", () => {
    const id = mkId("undo-conv-metadata");
    create(id, "openai", "gpt-5.4", "Original Title");

    expect(mark(id, true)).toBe(true);
    expect(getSummary(id)?.marked).toBe(true);
    expect(undoDelete()).toEqual({ type: "sidebar_state", updatedConvIds: [id] });
    expect(getSummary(id)?.marked).toBe(false);

    expect(rename(id, "Renamed Title")).toBe(true);
    expect(getSummary(id)?.title).toBe("Renamed Title");
    expect(undoDelete()).toEqual({ type: "sidebar_state", updatedConvIds: [id] });
    expect(getSummary(id)?.title).toBe("Original Title");

    expect(pin(id, true)).toBe(true);
    expect(getSummary(id)?.pinned).toBe(true);
    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(getSummary(id)?.pinned).toBe(false);

    const cloned = clone(id)!;
    IDS.push(cloned.id);
    expect(getSummary(cloned.id)).toMatchObject({ id: cloned.id });
    expect(undoDelete()).toEqual({ type: "sidebar_state", deletedConvIds: [cloned.id] });
    expect(getSummary(cloned.id)).toBeNull();
  });

  test("undo restores batch pinning as one sidebar entry", () => {
    const ids = [mkId("undo-batch-pin-a"), mkId("undo-batch-pin-b")];
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);

    expect(pinSidebarItems(ids.map(id => ({ item: { type: "conversation" as const, id }, pinned: true })))).toBe(true);
    expect(ids.map(id => getSummary(id)?.pinned)).toEqual([true, true]);

    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(ids.map(id => getSummary(id)?.pinned)).toEqual([false, false]);
  });

  test("redo re-applies a conversation delete after undo", () => {
    const id = mkId("redo-delete");
    create(id, "openai", "gpt-5.4", "redo delete");

    expect(remove(id)).toBe(true);
    expect(getSummary(id)).toBeNull();
    expect(undoDelete()?.type).toBe("conversation");
    expect(getSummary(id)).toMatchObject({ id });

    expect(redoDelete()).toEqual({ type: "sidebar_state", deletedConvIds: [id] });
    expect(getSummary(id)).toBeNull();
    expect(undoDelete()?.type).toBe("conversation");
    expect(getSummary(id)).toMatchObject({ id });
  });

  test("redo re-applies sidebar metadata and move actions", () => {
    const ids = [mkId("redo-move-a"), mkId("redo-move-b")];
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);

    expect(moveSidebarItem({ type: "conversation", id: ids[0] }, "down")).toBe(true);
    expect(rootRows(ids).map(row => row.id)).toEqual([ids[1], ids[0]]);
    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(rootRows(ids).map(row => row.id)).toEqual(ids);
    expect(redoDelete()).toEqual({ type: "sidebar_state" });
    expect(rootRows(ids).map(row => row.id)).toEqual([ids[1], ids[0]]);

    expect(mark(ids[0], true)).toBe(true);
    expect(undoDelete()).toEqual({ type: "sidebar_state", updatedConvIds: [ids[0]] });
    expect(getSummary(ids[0])?.marked).toBe(false);
    expect(redoDelete()).toEqual({ type: "sidebar_state", updatedConvIds: [ids[0]] });
    expect(getSummary(ids[0])?.marked).toBe(true);
  });

  test("redo recreates a folder after undoing folder creation", () => {
    const id = mkId("redo-create-folder-child");
    create(id, "openai", "gpt-5.4", "child");
    const folder = createFolder("Redo Created Folder", null, [{ type: "conversation", id }])!;

    expect(undoDelete()).toEqual({ type: "sidebar_state", folderInstructions: [{ folderId: folder.id, text: "" }] });
    expect(listSidebarState().folders.some(candidate => candidate.id === folder.id)).toBe(false);
    expect(getSummary(id)?.folderId ?? null).toBeNull();

    expect(redoDelete()).toEqual({ type: "sidebar_state" });
    expect(listSidebarState().folders.find(candidate => candidate.id === folder.id)).toMatchObject({ id: folder.id, name: folder.name });
    expect(getSummary(id)?.folderId).toBe(folder.id);
  });

  test("redo re-applies recursive folder delete and folder unwrap", () => {
    const recursiveChildId = mkId("redo-recursive-child");
    const recursiveFolder = createFolder(`Redo Recursive Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(recursiveFolder.id);
    create(recursiveChildId, "openai", "gpt-5.4", "recursive child", undefined, false, recursiveFolder.id);

    expect(deleteFolder(recursiveFolder.id, "recursive")).toBe(true);
    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(getSummary(recursiveChildId)).toMatchObject({ folderId: recursiveFolder.id });
    expect(redoDelete()).toEqual({ type: "sidebar_state", deletedConvIds: [recursiveChildId] });
    expect(getSummary(recursiveChildId)).toBeNull();
    expect(listSidebarState().folders.some(candidate => candidate.id === recursiveFolder.id)).toBe(false);

    const unwrapChildId = mkId("redo-unwrap-child");
    const unwrapFolder = createFolder(`Redo Unwrap Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(unwrapFolder.id);
    create(unwrapChildId, "openai", "gpt-5.4", "unwrap child", undefined, false, unwrapFolder.id);

    expect(deleteFolder(unwrapFolder.id, "unwrap")).toBe(true);
    expect(undoDelete()).toEqual({ type: "sidebar_state" });
    expect(getSummary(unwrapChildId)?.folderId).toBe(unwrapFolder.id);
    expect(redoDelete()).toEqual({ type: "sidebar_state" });
    expect(getSummary(unwrapChildId)?.folderId ?? null).toBeNull();
    expect(listSidebarState().folders.some(candidate => candidate.id === unwrapFolder.id)).toBe(false);
  });

  test("redo restores a clone after undo removes it", () => {
    const id = mkId("redo-clone-source");
    create(id, "openai", "gpt-5.4", "clone source");

    const cloned = clone(id)!;
    IDS.push(cloned.id);
    expect(undoDelete()).toEqual({ type: "sidebar_state", deletedConvIds: [cloned.id] });
    expect(getSummary(cloned.id)).toBeNull();

    expect(redoDelete()?.type).toBe("conversation");
    expect(getSummary(cloned.id)).toMatchObject({ id: cloned.id });
  });

  test("moving a visual block down preserves the block order", () => {
    const ids = ["visual-a", "visual-b", "visual-c", "visual-d", "visual-e"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    expect(rootRows(ids).map(row => row.id)).toEqual(ids);

    expect(moveSidebarItems([
      { type: "conversation", id: ids[1] },
      { type: "conversation", id: ids[2] },
    ], null, { type: "conversation", id: ids[4] }, { preservePinned: true })).toBe(true);

    expect(rootRows(ids).map(row => row.id)).toEqual([ids[0], ids[3], ids[1], ids[2], ids[4]]);
  });

  test("visual block moves can preserve pinned state", () => {
    const ids = ["visual-pinned-a", "visual-pinned-b", "visual-pinned-c"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    expect(pin(ids[1], true)).toBe(true);
    expect(pin(ids[2], true)).toBe(true);

    expect(moveSidebarItems([
      { type: "conversation", id: ids[1] },
      { type: "conversation", id: ids[2] },
    ], null, undefined, { preservePinned: true, placement: "bottom" })).toBe(true);

    expect(getSummary(ids[1])?.pinned).toBe(true);
    expect(getSummary(ids[2])?.pinned).toBe(true);
  });

  test("creating a folder from pinned conversations creates a pinned folder in their slot", () => {
    const ids = ["folder-pinned-before", "folder-pinned-a", "folder-pinned-b", "folder-unpinned"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    expect(pin(ids[0], true)).toBe(true);
    expect(pin(ids[1], true)).toBe(true);
    expect(pin(ids[2], true)).toBe(true);

    const folder = createFolder("Pinned Folder", null, [
      { type: "conversation", id: ids[1] },
      { type: "conversation", id: ids[2] },
    ]);
    expect(folder).not.toBeNull();
    FOLDER_IDS.push(folder!.id);

    expect(folder!.pinned).toBe(true);
    expect(getSummary(ids[1])?.folderId).toBe(folder!.id);
    expect(getSummary(ids[2])?.folderId).toBe(folder!.id);
    expect(rootRows([...ids, folder!.id]).map(row => row.id)).toEqual([ids[0], folder!.id, ids[3]]);
  });

  test("folder instructions are included in effective system instructions and display", () => {
    const folder = createFolder(`Agents Folder ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);
    const id = mkId("folder-instructions");
    create(id, "openai", "gpt-5.4", "child", undefined, false, folder.id);
    const snapshotWithoutFolderInstructions = getRenderSnapshot(id);

    expect(setFolderInstructions(folder.id, "Use repo-local conventions.")).toBe(true);
    expect(getRenderSnapshot(id)).not.toBe(snapshotWithoutFolderInstructions);
    expect(getFolderInstructions(folder.id)).toBe("Use repo-local conventions.");
    expect(setSystemInstructions(id, "Be terse.")).toBe(true);

    expect(getEffectiveSystemInstructions(id)).toContain("# Context from AGENTS.md:\nUse repo-local conventions.");
    expect(getEffectiveSystemInstructions(id)).toContain("Conversation instructions:\nBe terse.");

    const entries = getDisplayData(id)?.entries ?? [];
    expect(entries[0]).toEqual({ type: "system_instructions", text: expect.stringContaining("Use repo-local conventions.") });
    expect(entries[1]).toEqual({ type: "system_instructions", text: "Be terse." });
  });

  test("folder instructions survive a conversation-store reload", () => {
    const folder = createFolder(`Persistent Agents ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(folder.id);
    expect(setFolderInstructions(folder.id, "Persistent rules.")).toBe(true);

    loadFromDisk();

    expect(getFolderInstructions(folder.id)).toBe("Persistent rules.");
  });

  test("effective folder instructions can be loaded before a conversation exists", () => {
    const parent = createFolder(`Draft Parent Agents ${Date.now()} ${Math.random()}`)!;
    const child = createFolder(`Draft Child Agents ${Date.now()} ${Math.random()}`, parent.id)!;
    FOLDER_IDS.push(child.id, parent.id);

    expect(setFolderInstructions(parent.id, "Parent draft rules.")).toBe(true);
    expect(setFolderInstructions(child.id, "Child draft rules.")).toBe(true);

    const effective = getEffectiveFolderInstructions(child.id)!;
    expect(effective.indexOf("Parent draft rules.")).toBeLessThan(effective.indexOf("Child draft rules."));
    expect(effective).toContain("# Context from AGENTS.md:\nParent draft rules.");
    expect(effective).toContain("# Context from AGENTS.md:\nChild draft rules.");
  });

  test("nested folder instructions are applied from parent to child", () => {
    const parent = createFolder(`Parent Agents ${Date.now()} ${Math.random()}`)!;
    const child = createFolder(`Child Agents ${Date.now()} ${Math.random()}`, parent.id)!;
    FOLDER_IDS.push(child.id, parent.id);
    const id = mkId("nested-folder-instructions");
    create(id, "openai", "gpt-5.4", "child", undefined, false, child.id);

    expect(setFolderInstructions(parent.id, "Parent rules.")).toBe(true);
    expect(setFolderInstructions(child.id, "Child rules.")).toBe(true);

    const effective = getEffectiveSystemInstructions(id)!;
    expect(effective.indexOf("Parent rules.")).toBeLessThan(effective.indexOf("Child rules."));
    expect(effective).toContain("# Context from AGENTS.md:\nParent rules.");
    expect(effective).toContain("# Context from AGENTS.md:\nChild rules.");
  });
});

describe("sidebar ordering", () => {
  function rootConversationOrder(ids: string[]): string[] {
    return listSidebarState().conversations
      .filter(summary => ids.includes(summary.id) && (summary.folderId ?? null) === null)
      .map(summary => summary.id);
  }

  test("manual moves use the latest unflushed bump-to-top order", () => {
    const ids = ["bump-one", "bump-two", "bump-three", "bump-four"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    expect(rootConversationOrder(ids)).toEqual(ids);

    // Sending a message bumps the active conversation immediately for the TUI,
    // but the stream setup intentionally does not flush the conversation yet.
    expect(bumpToTop(ids[2])).toBe(true);
    expect(getSummary(ids[2])!.sortOrder).toBeLessThan(getSummary(ids[0])!.sortOrder);

    // If the daemon's sidebar index still has the old order, moving the bumped
    // row down swaps it with ids[3] and produces [1, 2, 4, 3]. It should instead
    // move one row down from the visible [3, 1, 2, 4] order.
    expect(moveSidebarItem({ type: "conversation", id: ids[2] }, "down")).toBe(true);
    expect(rootConversationOrder(ids)).toEqual([ids[0], ids[2], ids[1], ids[3]]);
  });

  test("manual moves survive reload before the debounced index save", () => {
    const ids = ["reload-move-one", "reload-move-two", "reload-move-three", "reload-move-four"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    expect(rootConversationOrder(ids)).toEqual(ids);

    expect(moveSidebarItem({ type: "conversation", id: ids[1] }, "down")).toBe(true);
    expect(rootConversationOrder(ids)).toEqual([ids[0], ids[2], ids[1], ids[3]]);

    loadFromDisk();

    expect(rootConversationOrder(ids)).toEqual([ids[0], ids[2], ids[1], ids[3]]);
  });

  legacyFileTest("manual moves persist through tiny sidebar overlays without rewriting conversation history", () => {
    const ids = ["overlay-move-one", "overlay-move-two", "overlay-move-three"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    const paths = ids.map(id => join(conversationsDir(), `${id}.json`));
    const filesBefore = paths.map(path => readFileSync(path, "utf8"));

    expect(moveSidebarItem({ type: "conversation", id: ids[1] }, "down")).toBe(true);

    expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(filesBefore);
    expect(existsSync(join(conversationsDir(), `${ids[1]}.sidebar`))).toBe(true);
    expect(existsSync(join(conversationsDir(), `${ids[2]}.sidebar`))).toBe(true);
    expect(loadPersisted(ids[1])?.sortOrder).toBeGreaterThan(loadPersisted(ids[2])!.sortOrder);

    loadFromDisk();
    expect(rootConversationOrder(ids)).toEqual([ids[0], ids[2], ids[1]]);
  });

  legacyFileTest("an ordinary save folds a sidebar overlay into the conversation file", () => {
    const ids = ["overlay-fold-one", "overlay-fold-two"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    const sidebarPath = join(conversationsDir(), `${ids[0]}.sidebar`);

    expect(moveSidebarItem({ type: "conversation", id: ids[0] }, "down")).toBe(true);
    expect(existsSync(sidebarPath)).toBe(true);

    markDirty(ids[0]);
    flush(ids[0]);

    expect(existsSync(sidebarPath)).toBe(false);
    expect(loadPersisted(ids[0])?.sortOrder).toBe(getSummary(ids[0])?.sortOrder);
  });

  test("delete materializes sidebar placement so undo restores it without an overlay", () => {
    const ids = ["overlay-delete-one", "overlay-delete-two", "overlay-delete-three"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);

    expect(moveSidebarItem({ type: "conversation", id: ids[1] }, "down")).toBe(true);
    const movedOrder = getSummary(ids[1])!.sortOrder;
    expect(remove(ids[1])).toBe(true);
    expect(existsSync(join(conversationsDir(), `${ids[1]}.sidebar`))).toBe(false);

    expect(undoDelete()).toMatchObject({ type: "conversation" });
    expect(getSummary(ids[1])?.sortOrder).toBe(movedOrder);
    expect(rootConversationOrder(ids)).toEqual([ids[0], ids[2], ids[1]]);
  });

  legacyFileTest("a failed delete keeps the live generation synchronized after sidebar materialization", async () => {
    const ids = ["overlay-failed-delete", "overlay-failed-delete-neighbor"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.6-sol", id);
    const conv = get(ids[0])!;
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    markDirty(ids[0]);
    flush(ids[0]);
    expect(moveSidebarItem({ type: "conversation", id: ids[0] }, "down")).toBe(true);

    const blockingTrashPath = join(trashDir(), `${ids[0]}.json`);
    mkdirSync(blockingTrashPath, { recursive: true });
    try {
      expect(remove(ids[0])).toBe(false);
    } finally {
      rmSync(blockingTrashPath, { recursive: true, force: true });
    }
    expect(existsSync(join(conversationsDir(), `${ids[0]}.sidebar`))).toBe(false);

    expect(await unwindTo(ids[0], 1)).not.toBeNull();
    expect(loadPersisted(ids[0])?.messages.map(message => message.content)).toEqual(["keep", "kept answer"]);
  });

  legacyFileTest("a sidebar move survives an unwind that advances only the logical generation", async () => {
    const ids = ["overlay-then-unwind", "overlay-then-unwind-neighbor"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.6-sol", id);
    const conv = get(ids[0])!;
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    markDirty(ids[0]);
    flush(ids[0]);
    expect(moveSidebarItem({ type: "conversation", id: ids[0] }, "down")).toBe(true);
    const movedOrder = getSummary(ids[0])!.sortOrder;

    expect(await unwindTo(ids[0], 1)).not.toBeNull();
    expect(existsSync(join(conversationsDir(), `${ids[0]}.sidebar`))).toBe(true);

    const reloaded = loadPersisted(ids[0]);
    expect(reloaded?.messages.map(message => message.content)).toEqual(["keep", "kept answer"]);
    expect(reloaded?.sortOrder).toBe(movedOrder);
    loadFromDisk();
    expect(rootConversationOrder(ids)).toEqual([ids[1], ids[0]]);
  });

  legacyFileTest("a malformed sidebar overlay rebuilds a cached moved summary from the base file", () => {
    const ids = ["overlay-corrupt-one", "overlay-corrupt-two"].map(mkId);
    for (const id of ids.slice().reverse()) create(id, "openai", "gpt-5.4", id);
    expect(rootConversationOrder(ids)).toEqual(ids);
    expect(moveSidebarItem({ type: "conversation", id: ids[0] }, "down")).toBe(true);
    flushAll();
    const sidebarPaths = ids.map(id => join(conversationsDir(), `${id}.sidebar`));
    for (const sidebarPath of sidebarPaths) writeFileSync(sidebarPath, "{not json", "utf8");

    expect(loadFromDisk().indexRebuilt).toBeGreaterThanOrEqual(2);
    expect(sidebarPaths.some(existsSync)).toBe(false);
    expect(rootConversationOrder(ids)).toEqual(ids);
  });
});

describe("createWithInitialUserMessage", () => {
  test("persists the pending title and first user message in one conversation mutation", () => {
    const id = mkId("initial-user-message");

    createWithInitialUserMessage(id, "openai", "gpt-5.4", "pending", "high", false, {
      text: "name this chat",
      startedAt: 123,
    });

    expect(get(id)).toMatchObject({
      id,
      title: "pending",
      messages: [{
        role: "user",
        content: "name this chat",
        metadata: { startedAt: 123, endedAt: 123, model: "gpt-5.4", tokens: 0 },
      }],
    });
    expect(get(id)?.messages[0]?.contextCheckpoint).toMatchObject({
      version: 1,
      provider: "openai",
      model: "gpt-5.4",
      windowId: null,
      transcriptHistoryCount: 0,
      contextTokens: 0,
    });
    expect(getSummary(id)).toMatchObject({ title: "pending", messageCount: 1 });
  });
});

describe("setModel", () => {
  test("switches provider/model atomically, preserves replay for bridging, and bumps updatedAt", async () => {
    const id = mkId("switch-provider");
    const conv = create(id, "openai", "gpt-5.4", undefined, "low", true);
    conv.messages.push({ role: "user", content: "keep full transcript", metadata: null });
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.4",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 1,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 1),
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 1,
      compactionCount: 1,
    };
    conv.lastContextTokens = 123_456;
    const before = conv.updatedAt;

    await Bun.sleep(2);
    expect(setModel(id, "openai", "gpt-5.5", "high", false)).toBe(true);

    const after = get(id)!;
    expect(after.provider).toBe("openai");
    expect(after.model).toBe("gpt-5.5");
    expect(after.effort).toBe("high");
    expect(after.fastMode).toBe(false);
    expect(after.lastContextTokens).toBeNull();
    expect(after.activeContext?.kind).toBe("openai_native");
    expect(after.updatedAt).toBeGreaterThan(before);
  });
});

describe("trimConversation", () => {
  test("trims oldest history entries and clears stale context", () => {
    const id = mkId("trim-messages");
    const conv = create(id, "openai", "gpt-5.4");
    conv.lastContextTokens = 9_999;
    expect(setSystemInstructions(id, "Be terse.")).toBe(true);
    conv.messages.push({ role: "user", content: "first", metadata: null });
    conv.messages.push({ role: "assistant", content: "reply one", metadata: null });
    conv.messages.push({ role: "user", content: "second", metadata: null });

    const result = trimConversation(id, "messages", 2);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("Trimmed 2 oldest history entries");
    expect(get(id)?.messages).toEqual([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "user", content: "second", metadata: null },
    ]);
    expect(get(id)?.lastContextTokens).toBeNull();
  });

  test("expands message trimming to preserve assistant tool_use and user tool_result pairs", () => {
    const id = mkId("trim-messages-tool-pair");
    create(id, "openai", "gpt-5.5");
    const conv = get(id)!;
    conv.messages.push({ role: "user", content: "before tool", metadata: null });
    conv.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "echo hi" } }],
      metadata: null,
    });
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "hi" }],
      metadata: null,
    });
    conv.messages.push({ role: "assistant", content: "after tool", metadata: null });

    const result = trimConversation(id, "messages", 2);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("expanded from 2 to 3 to preserve a tool_use/tool_result pair");
    expect(get(id)?.messages).toEqual([
      { role: "assistant", content: "after tool", metadata: null },
    ]);
  });

  test("strips thinking from the oldest assistant turns first", () => {
    const id = mkId("trim-thinking");
    create(id, "openai", "gpt-5.4");
    const conv = get(id)!;
    conv.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "sig" }, { type: "text", text: "visible" }], metadata: null });
    conv.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "later", signature: "sig2" }, { type: "text", text: "second" }], metadata: null });

    const result = trimConversation(id, "thinking", 1);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("Trimmed thinking from 1 assistant turn");
    expect(get(id)?.messages[0]?.content).toEqual([{ type: "text", text: "visible" }]);
    expect(Array.isArray(get(id)?.messages[1]?.content)).toBe(true);
    expect((get(id)?.messages[1]?.content as Array<{ type: string }>).some((block) => block.type === "thinking")).toBe(true);
  });

  test("strips oldest tool result payloads first", () => {
    const id = mkId("trim-toolresults");
    create(id, "openai", "gpt-5.5");
    const conv = get(id)!;
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "very long output that should definitely be longer than the trim placeholder" }],
      metadata: null,
    });
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-2", content: "second output" }],
      metadata: null,
    });

    const result = trimConversation(id, "toolresults", 1);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("Trimmed 1 tool result");
    expect(get(id)?.messages[0]?.content).toEqual([{ type: "tool_result", tool_use_id: "tool-1", content: "[Output removed by /trim]" }]);
    expect(get(id)?.messages[1]?.content).toEqual([{ type: "tool_result", tool_use_id: "tool-2", content: "second output" }]);
  });
});

describe("unwindTo", () => {
  test("replaces context usage measured against the removed suffix with a prefix estimate", async () => {
    const id = mkId("unwind-context-usage");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    conv.lastContextTokens = 350_000;
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 1)).not.toBeNull();
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    expect(get(id)?.lastContextTokens).toBe(4);
  });

  test("preserves a checkpoint when unwinding only its unrepresented transcript tail", async () => {
    const id = mkId("unwind-preserve-context");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
    );
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 2),
      compactionHistoryCount: 2,
      compactionPrefixHash: historyPrefixHash(conv.messages, 2),
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    const checkpoint = structuredClone(conv.activeContext);
    conv.messages.push(
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 1)).not.toBeNull();
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    expect(get(id)?.activeContext).toEqual(checkpoint);
    expect(get(id)?.lastContextTokens).toBe(2);
    expect(loadPersisted(id)?.activeContext).toEqual(checkpoint);
  });

  test("uses a canonical tail checkpoint without advancing a lagging compact replay", async () => {
    const id = mkId("unwind-lagging-compact-replay");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "represented prompt", metadata: null },
      { role: "assistant", content: "represented answer", metadata: null },
    );
    const compactedPrefixHash = historyPrefixHash(conv.messages, 2);
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 2,
      transcriptPrefixHash: compactedPrefixHash,
      compactionHistoryCount: 2,
      compactionPrefixHash: compactedPrefixHash,
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    const checkpoint = structuredClone(conv.activeContext);
    conv.messages.push(
      { role: "user", content: "unrepresented but retained", metadata: null },
      { role: "assistant", content: "retained answer", metadata: null },
    );
    const targetHistoryCount = 4;
    conv.messages.push(
      {
        role: "user",
        content: "edit me",
        metadata: null,
        contextCheckpoint: {
          version: 1,
          provider: "openai",
          model: "gpt-5.6-sol",
          windowId: `${id}:1`,
          transcriptHistoryCount: targetHistoryCount,
          transcriptPrefixHash: historyPrefixHash(conv.messages, targetHistoryCount),
          contextTokens: 54_321,
        },
      },
      { role: "assistant", content: "remove me", metadata: null },
    );
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 2)).not.toBeNull();
    expect(get(id)?.messages.map((message) => message.content)).toEqual([
      "represented prompt",
      "represented answer",
      "unrepresented but retained",
      "retained answer",
    ]);
    expect(get(id)?.activeContext).toEqual(checkpoint);
    expect(get(id)?.lastContextTokens).toBe(54_321);
    expect(loadPersisted(id)?.activeContext).toEqual(checkpoint);
    expect(loadPersisted(id)?.lastContextTokens).toBe(54_321);
  });

  test("rewinds a legacy advanced checkpoint when abort recovery crosses the unwind point", async () => {
    const id = mkId("unwind-restore-pre-abort-context");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
    );
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 2),
      compactionHistoryCount: 2,
      compactionPrefixHash: historyPrefixHash(conv.messages, 2),
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    const checkpoint = structuredClone(conv.activeContext);
    conv.messages.push({ role: "user", content: "remove", metadata: null });
    markDirty(id);
    flush(id);

    const ac = new AbortController();
    setActiveJob(id, ac, Date.now());
    ac.signal.addEventListener("abort", () => {
      conv.activeContext = {
        ...structuredClone(checkpoint),
        messages: [
          ...structuredClone(checkpoint.messages),
          { role: "user", content: "remove" },
        ],
        transcriptHistoryCount: 3,
        transcriptPrefixHash: historyPrefixHash(conv.messages, 3),
      };
      clearActiveJob(id);
    }, { once: true });

    expect(await unwindTo(id, 1)).not.toBeNull();
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    expect(get(id)?.activeContext).toEqual(checkpoint);
  });

  test("refuses to unwind inside the immutable compaction prefix", async () => {
    const id = mkId("unwind-discard-context");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "remove from here", metadata: null },
      { role: "assistant", content: "represented answer", metadata: null },
      { role: "user", content: "later", metadata: null },
    );
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 2),
      compactionHistoryCount: 2,
      compactionPrefixHash: historyPrefixHash(conv.messages, 2),
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };

    const before = structuredClone(conv);
    expect(await unwindTo(id, 0)).toBeNull();
    expect(get(id)?.messages).toEqual(before.messages);
    expect(get(id)?.activeContext).toEqual(before.activeContext);
  });

  test("refuses sent-message edits when a persisted divider has lost its checkpoint", async () => {
    const id = mkId("unwind-lost-checkpoint");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "old prompt", metadata: null },
      {
        role: "system",
        content: CONTEXT_COMPACTION_FINISHED_TEXT,
        metadata: {
          startedAt: 123,
          endedAt: 123,
          model: "gpt-5.6-sol",
          tokens: 0,
          kind: CONTEXT_COMPACTION_FINISHED_KIND,
        },
      },
      { role: "user", content: "tail without replay base", metadata: null },
    );

    expect(await unwindTo(id, 1)).toBeNull();
    expect(get(id)?.messages).toHaveLength(3);
  });

  test("refuses a stale target identity even when its user index was reused", async () => {
    const id = mkId("unwind-stale-target");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push({
      role: "user",
      content: "replacement at reused index",
      metadata: { startedAt: 200, endedAt: 200, model: conv.model, tokens: 0 },
    });
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 0, "stale-op", 100)).toBeNull();
    expect(get(id)?.messages).toHaveLength(1);
  });

  test("uses a daemon fingerprint to identify legacy messages without timestamps", async () => {
    const id = mkId("unwind-legacy-fingerprint");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "legacy prompt", metadata: null },
      { role: "assistant", content: "legacy answer", metadata: null },
    );
    markDirty(id);
    flush(id);
    const fingerprint = historyPrefixHash(conv.messages, 1);

    expect(await unwindTo(id, 0, "stale-fingerprint-op", undefined, `${fingerprint}-stale`)).toBeNull();
    expect(get(id)?.messages).toHaveLength(2);
    expect(await unwindTo(id, 0, "valid-fingerprint-op", undefined, fingerprint)).toMatchObject({ status: "applied" });
    expect(get(id)?.messages).toHaveLength(0);
  });

  test("trims an advanced compact replay back to a post-compaction user checkpoint", async () => {
    const id = mkId("unwind-trim-compact-tail");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "represented prompt", metadata: null },
      { role: "assistant", content: "represented answer", metadata: null },
    );
    const baseMessages = [{
      role: "assistant" as const,
      content: [],
      providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
    }];
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: structuredClone(baseMessages),
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 2),
      compactionHistoryCount: 2,
      compactionPrefixHash: historyPrefixHash(conv.messages, 2),
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    const rewindCheckpoint = {
      version: 1 as const,
      provider: "openai" as const,
      model: "gpt-5.6-sol" as const,
      windowId: `${id}:1`,
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 2),
      contextTokens: 91_234,
    };
    conv.messages.push(
      { role: "user", content: "edit me", metadata: null, contextCheckpoint: rewindCheckpoint },
      { role: "assistant", content: "remove me", metadata: null },
    );
    conv.activeContext.messages.push(
      { role: "user", content: "edit me" },
      { role: "assistant", content: "remove me" },
    );
    conv.activeContext.transcriptHistoryCount = 4;
    conv.activeContext.transcriptPrefixHash = historyPrefixHash(conv.messages, 4);
    conv.lastContextTokens = 300_000;
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 1)).not.toBeNull();
    expect(get(id)?.messages.map((message) => message.content)).toEqual([
      "represented prompt",
      "represented answer",
    ]);
    expect(get(id)?.activeContext?.messages).toEqual(baseMessages);
    expect(get(id)?.activeContext?.transcriptHistoryCount).toBe(2);
    expect(get(id)?.lastContextTokens).toBe(91_234);
    expect(loadPersisted(id)?.activeContext?.messages).toEqual(baseMessages);
    expect(loadPersisted(id)?.lastContextTokens).toBe(91_234);
  });

  test("falls back to canonical hashing for a corrupt user context checkpoint", async () => {
    const id = mkId("unwind-corrupt-user-checkpoint");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "represented prompt", metadata: null },
      { role: "assistant", content: "represented answer", metadata: null },
    );
    const basePrefixHash = historyPrefixHash(conv.messages, 2);
    const compactedMessages = [{
      role: "assistant" as const,
      content: [],
      providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
    }];
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: structuredClone(compactedMessages),
      transcriptHistoryCount: 2,
      transcriptPrefixHash: basePrefixHash,
      compactionHistoryCount: 2,
      compactionPrefixHash: basePrefixHash,
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    conv.messages.push(
      {
        role: "user",
        content: "edit me",
        metadata: null,
        contextCheckpoint: {
          version: 1,
          provider: "openai",
          model: "gpt-5.6-sol",
          windowId: `${id}:1`,
          transcriptHistoryCount: 2,
          transcriptPrefixHash: "f".repeat(24),
          contextTokens: 999_999,
        },
      },
      { role: "assistant", content: "remove me", metadata: null },
    );
    conv.activeContext.messages.push(
      { role: "user", content: "edit me" },
      { role: "assistant", content: "remove me" },
    );
    conv.activeContext.transcriptHistoryCount = 4;
    conv.activeContext.transcriptPrefixHash = historyPrefixHash(conv.messages, 4);
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 1)).not.toBeNull();
    expect(get(id)?.activeContext?.messages).toEqual(compactedMessages);
    expect(get(id)?.activeContext?.transcriptPrefixHash).toBe(basePrefixHash);
    expect(get(id)?.lastContextTokens).not.toBe(999_999);
    expect(loadPersisted(id)?.activeContext?.transcriptPrefixHash).toBe(basePrefixHash);
  });

  legacyFileTest("persists only a truncation overlay and does not rewrite the sidebar index", async () => {
    const id = mkId("unwind-targeted-persistence");
    const conv = create(id, "openai", "gpt-5.6-sol", "targeted unwind");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    markDirty(id);
    flush(id);
    const supersededQueueId = `${id}-superseded`;
    pushQueuedMessage(id, "superseded follow-up", "message-end", undefined, undefined, undefined, supersededQueueId);

    const conversationPath = join(conversationsDir(), `${id}.json`);
    const indexPath = join(dataDir(), "conversations-index.json");
    const conversationBefore = readFileSync(conversationPath, "utf8");
    const indexBefore = readFileSync(indexPath, "utf8");

    expect(await unwindTo(id, 1)).not.toBeNull();

    expect(readFileSync(conversationPath, "utf8")).toBe(conversationBefore);
    expect(readFileSync(indexPath, "utf8")).toBe(indexBefore);
    const overlayPath = join(conversationsDir(), `${id}.unwind`);
    expect(readFileSync(overlayPath, "utf8").length).toBeLessThan(800);
    expect(loadPersisted(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    expect(getQueuedMessageById(supersededQueueId)).toBeUndefined();

    // Startup overlays the tiny summary delta in memory. It does not repair by
    // rewriting the monolithic index merely because an unwind sidecar exists.
    loadFromDisk();
    expect(readFileSync(indexPath, "utf8")).toBe(indexBefore);
    expect(getSummary(id)?.messageCount).toBe(2);

    // Simulate a crash after sidecar commit but before the queue-file rewrite:
    // the exact old ID is tombstoned, while a later distinct queue entry survives.
    const committedOverlay = JSON.parse(readFileSync(overlayPath, "utf8"));
    writeFileSync(overlayPath, JSON.stringify({
      ...committedOverlay,
      supersededQueueIds: [supersededQueueId],
    }, null, 2));
    pushQueuedMessage(id, "stale queue-file copy", "message-end", undefined, undefined, undefined, supersededQueueId);
    const laterQueueId = `${id}-later`;
    pushQueuedMessage(id, "later follow-up", "message-end", undefined, undefined, undefined, laterQueueId);
    loadQueuedMessagesFromDisk();
    expect(getQueuedMessageById(supersededQueueId)).toBeUndefined();
    expect(getQueuedMessageById(laterQueueId)).toBeDefined();
  });

  test("materializes the targeted boundary before trash so undo cannot restore the suffix", async () => {
    const id = mkId("unwind-trash-roundtrip");
    const conv = create(id, "openai", "gpt-5.6-sol", "unwind trash");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    markDirty(id);
    flush(id);
    expect(await unwindTo(id, 1)).not.toBeNull();

    expect(remove(id)).toBe(true);
    expect(undoDelete()).toMatchObject({ type: "conversation" });
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
  });

  test("serializes concurrent unwinds and commits only the mutation owner", async () => {
    const id = mkId("unwind-concurrent");
    const conv = create(id, "openai", "gpt-5.6-sol", "concurrent unwind");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
    );
    markDirty(id);
    flush(id);
    const ac = new AbortController();
    setActiveJob(id, ac, Date.now());

    const first = unwindTo(id, 1, "owner-op");
    expect(await unwindTo(id, 0, "racing-op")).toBeNull();
    clearActiveJob(id);

    expect(await first).toMatchObject({ operationId: "owner-op", userMessageIndex: 1 });
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
  });

  test("coalesces an in-flight retry of the same unwind operation", async () => {
    const id = mkId("unwind-same-operation");
    const conv = create(id, "openai", "gpt-5.6-sol", "same operation");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
    );
    markDirty(id);
    flush(id);
    const ac = new AbortController();
    setActiveJob(id, ac, Date.now());

    const owner = unwindTo(id, 1, "same-operation");
    const retry = unwindTo(id, 1, "same-operation");
    clearActiveJob(id);

    expect(await owner).toMatchObject({ status: "applied", operationId: "same-operation" });
    expect(await retry).toMatchObject({ status: "already_applied", operationId: "same-operation" });
  });

  test("can hold the mutation lease until the canonical event is published", async () => {
    const id = mkId("unwind-deferred-lease");
    const conv = create(id, "openai", "gpt-5.6-sol", "deferred lease");
    conv.messages.push({ role: "user", content: "remove", metadata: null });
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 0, "deferred-operation", undefined, undefined, true)).toMatchObject({ status: "applied" });
    expect(isHistoryUnwindPending(id)).toBe(true);
    expect(remove(id)).toBe(false);
    releaseHistoryUnwindLease(id, "deferred-operation");
    expect(isHistoryUnwindPending(id)).toBe(false);
  });

  test("holds a failed post-abort lease until canonical recovery is published", async () => {
    const id = mkId("unwind-failed-deferred-lease");
    const conv = create(id, "openai", "gpt-5.6-sol", "failed deferred lease");
    conv.messages.push({ role: "user", content: "replace during abort", metadata: null });
    markDirty(id);
    flush(id);
    const ac = new AbortController();
    setActiveJob(id, ac, Date.now());
    ac.signal.addEventListener("abort", () => {
      conv.messages[0] = { role: "user", content: "replacement", metadata: null };
      clearActiveJob(id);
    }, { once: true });

    await expect(unwindTo(id, 0, "failed-deferred-operation", undefined, undefined, true))
      .rejects.toBeInstanceOf(HistoryUnwindRefreshRequiredError);
    expect(isHistoryUnwindPending(id)).toBe(true);
    releaseHistoryUnwindLease(id, "failed-deferred-operation");
    expect(isHistoryUnwindPending(id)).toBe(false);
  });

  test("refuses deletion while an unwind owns the conversation mutation lock", async () => {
    const id = mkId("unwind-delete-race");
    const conv = create(id, "openai", "gpt-5.6-sol", "delete race");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
    );
    markDirty(id);
    flush(id);
    const ac = new AbortController();
    setActiveJob(id, ac, Date.now());

    const unwind = unwindTo(id, 1, "delete-race-owner");
    expect(remove(id)).toBe(false);
    expect(get(id)).toBe(conv);
    clearActiveJob(id);

    expect(await unwind).toMatchObject({ status: "applied" });
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
  });

  test("replays a durable operation receipt without truncating a newer turn", async () => {
    const id = mkId("unwind-idempotent");
    const conv = create(id, "openai", "gpt-5.6-sol", "idempotent unwind");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
    );
    markDirty(id);
    flush(id);

    expect(await unwindTo(id, 1, "stable-op")).toMatchObject({ status: "applied" });
    conv.messages.push({ role: "user", content: "newer turn at the same user index", metadata: null });
    conv.updatedAt += 1;
    markDirty(id);
    flush(id); // Materializes both the unwind and its operation receipt.

    expect(await unwindTo(id, 1, "stable-op")).toMatchObject({ status: "already_applied" });
    expect(get(id)?.messages.map((message) => message.content)).toEqual([
      "keep",
      "kept answer",
      "newer turn at the same user index",
    ]);
  });

  test("leaves history and queued intent untouched when targeted persistence is unsafe", async () => {
    const id = mkId("unwind-unsafe-dirty");
    const conv = create(id, "openai", "gpt-5.6-sol", "unsafe unwind");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
    );
    markDirty(id);
    flush(id);
    const queueId = `${id}-queued`;
    pushQueuedMessage(id, "must survive", "message-end", undefined, undefined, undefined, queueId);
    markDirty(id); // Represents an unrelated mutation not encoded by the overlay.

    expect(unwindTo(id, 1, "unsafe-op")).rejects.toThrow("unrelated dirty state");
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer", "remove"]);
    expect(getQueuedMessageById(queueId)).toBeDefined();
  });
});

describe("stream chunk tracking", () => {
  legacyFileTest("does not rewrite durable history for ephemeral live chunks", () => {
    const id = mkId("stream-chunks-ephemeral");
    const conv = create(id, "openai", "gpt-5.6-sol");
    const path = join(conversationsDir(), `${id}.json`);
    const persistedBefore = readFileSync(path, "utf8");

    // Live partial text is stored by streaming.ts rather than conv.messages.
    // Mutate memory here so this test detects an accidental periodic flush.
    conv.messages.push({ role: "assistant", content: "not durable yet", metadata: null });
    expect([onChunk(id), onChunk(id), onChunk(id), onChunk(id), onChunk(id)]).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);

    expect(readFileSync(path, "utf8")).toBe(persistedBefore);
  });
});

describe("setSystemInstructions", () => {
  test("bumps updatedAt when instructions are added", async () => {
    const id = mkId("add");
    const conv = create(id, "openai", "gpt-5.5");
    const before = conv.updatedAt;

    await Bun.sleep(2);
    expect(setSystemInstructions(id, "Be terse.")).toBe(true);

    const after = get(id)!;
    expect(after.messages[0]).toEqual({ role: "system_instructions", content: "Be terse.", metadata: null });
    expect(after.updatedAt).toBeGreaterThan(before);
  });

  test("bumps updatedAt when instructions are changed or cleared, but not on no-op", async () => {
    const id = mkId("change-clear");
    create(id, "openai", "gpt-5.5");

    expect(setSystemInstructions(id, "Be terse.")).toBe(true);
    const afterSet = get(id)!;
    const firstUpdatedAt = afterSet.updatedAt;

    expect(setSystemInstructions(id, "Be terse.")).toBe(true);
    const afterNoOp = get(id)!;
    expect(afterNoOp.updatedAt).toBe(firstUpdatedAt);

    await Bun.sleep(2);
    expect(setSystemInstructions(id, "Be thorough.")).toBe(true);
    const afterChange = get(id)!;
    expect(afterChange.updatedAt).toBeGreaterThan(firstUpdatedAt);
    const secondUpdatedAt = afterChange.updatedAt;

    await Bun.sleep(2);
    expect(setSystemInstructions(id, "")).toBe(true);
    const afterClear = get(id)!;
    expect(afterClear.messages.find((m) => m.role === "system_instructions")).toBeUndefined();
    expect(afterClear.updatedAt).toBeGreaterThan(secondUpdatedAt);
  });
});

describe("getSummary", () => {
  test("messageCount excludes system instructions and compaction/status notices", () => {
    const id = mkId("summary-count");
    create(id, "openai", "gpt-5.5");
    expect(setSystemInstructions(id, "Be terse.")).toBe(true);

    const conv = get(id)!;
    conv.messages.push({ role: "user", content: "hello", metadata: null });
    conv.messages.push({ role: "user", content: "[Context: getting full]", metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.5", tokens: 0, system: true, kind: "context_warning" } });
    conv.messages.push({ role: "assistant", content: "hi", metadata: null });
    conv.messages.push({
      role: "system",
      content: CONTEXT_COMPACTION_FINISHED_TEXT,
      metadata: {
        startedAt: 2,
        endedAt: 2,
        model: "gpt-5.5",
        tokens: 0,
        kind: CONTEXT_COMPACTION_FINISHED_KIND,
      },
    });

    const summary = getSummary(id)!;
    expect(summary.messageCount).toBe(2);
  });
});

describe("unread persistence", () => {
  test("unread indicators survive conversation-store reloads and clear durably", () => {
    const id = mkId("unread-restart");
    create(id, "openai", "gpt-5.4", "unread");

    markUnread(id);
    expect(isUnread(id)).toBe(true);
    expect(getSummary(id)).toMatchObject({ unread: true });

    loadFromDisk();
    expect(isUnread(id)).toBe(true);
    expect(getSummary(id)).toMatchObject({ unread: true });

    expect(clearUnread(id)).toBe(true);
    expect(isUnread(id)).toBe(false);

    loadFromDisk();
    expect(getSummary(id)).toMatchObject({ unread: false });
  });

  test("never marks conversations in the reserved top-level subagents tree unread", () => {
    const subagents = ensureTopLevelFolder(" SubAgents ")!;
    const nested = createFolder(`Nested agents ${Date.now()} ${Math.random()}`, subagents.id)!;
    const ordinary = createFolder(`Ordinary ${Date.now()} ${Math.random()}`)!;
    const misleading = createFolder("subagents", ordinary.id)!;
    FOLDER_IDS.push(subagents.id, nested.id, ordinary.id, misleading.id);

    const directId = mkId("unread-subagent-direct");
    const nestedId = mkId("unread-subagent-nested");
    const ordinaryId = mkId("unread-nested-name");
    create(directId, "openai", "gpt-5.4", "direct", undefined, false, subagents.id);
    create(nestedId, "openai", "gpt-5.4", "nested", undefined, false, nested.id);
    create(ordinaryId, "openai", "gpt-5.4", "ordinary", undefined, false, misleading.id);

    markUnread(directId);
    markUnread(nestedId);
    markUnread(ordinaryId);

    expect(isUnread(directId)).toBe(false);
    expect(isUnread(nestedId)).toBe(false);
    expect(getSummary(directId)).toMatchObject({ unread: false, notificationsMuted: true });
    expect(getSummary(nestedId)).toMatchObject({ unread: false, notificationsMuted: true });
    expect(getSummary(ordinaryId)).toMatchObject({ unread: true });
    expect(getSummary(ordinaryId)?.notificationsMuted).toBeUndefined();

    setActiveJob(nestedId, new AbortController(), Date.now());
    expect(getSummary(nestedId)).toMatchObject({ streaming: true, unread: false, notificationsMuted: true });
    clearActiveJob(nestedId);
  });

  test("clears durable unread state when a conversation tree moves under subagents", () => {
    const subagents = ensureTopLevelFolder("subagents")!;
    const batch = createFolder(`Unread batch ${Date.now()} ${Math.random()}`)!;
    FOLDER_IDS.push(subagents.id, batch.id);
    const id = mkId("unread-moved-subagent");
    create(id, "openai", "gpt-5.4", "move me", undefined, false, batch.id);
    markUnread(id);
    expect(isUnread(id)).toBe(true);

    expect(moveSidebarItems([{ type: "folder", id: batch.id }], subagents.id)).toBe(true);
    expect(getSummary(id)).toMatchObject({ unread: false, notificationsMuted: true });

    loadFromDisk();
    expect(isUnread(id)).toBe(false);
    expect(getSummary(id)).toMatchObject({ unread: false, notificationsMuted: true });
  });
});

describe("listRunningConversationIds", () => {
  test("returns only conversations with active streams", () => {
    const running = mkId("running");
    const idle = mkId("idle");
    create(running, "openai", "gpt-5.5");
    create(idle, "openai", "gpt-5.5");

    setActiveJob(running, new AbortController(), Date.now());

    expect(listRunningConversationIds()).toEqual([running]);
  });
});

describe("getDisplayData", () => {
  test("reuses a quiet render snapshot until conversation history changes", () => {
    const id = mkId("display-snapshot-cache");
    create(id, "openai", "gpt-5.4", "cached snapshot");

    const first = getRenderSnapshot(id);
    expect(getRenderSnapshot(id)).toBe(first);

    setSystemInstructions(id, "new instructions");
    expect(getRenderSnapshot(id)).not.toBe(first);
  });

  test("does not duplicate a persisted streaming suffix when only context attribution changed", () => {
    const id = mkId("display-context-attribution-drift");
    create(id, "openai", "gpt-5.5");
    const conv = get(id)!;
    const completedRound = [
      {
        role: "assistant" as const,
        content: [
          { type: "thinking" as const, thinking: "checking", signature: "" },
          { type: "tool_use" as const, id: "call-1", name: "bash", input: { command: "pwd" } },
        ],
        metadata: null,
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "call-1", content: "/tmp" }],
        metadata: null,
      },
    ];
    conv.messages.push(
      { role: "user", content: "initial", metadata: null },
      ...structuredClone(completedRound),
    );
    // The persisted copy is annotated independently after the next round starts.
    // A null/undefined difference is sufficient to model the bookkeeping drift;
    // it must not make identical transcript content appear twice.
    conv.messages[1].contextTokens = null;
    setActiveJob(id, new AbortController(), 100);
    replaceStreamingDisplayMessages(id, completedRound);
    setStreamingCommittedBlockCount(id, 3);

    const snapshot = getRenderSnapshot(id, false)!;

    expect(snapshot.entries).toMatchObject([
      { type: "user", text: "initial" },
      {
        type: "ai",
        blocks: [
          { type: "thinking", text: "checking" },
          { type: "tool_call", toolCallId: "call-1", toolName: "bash" },
          { type: "tool_result", toolCallId: "call-1", isError: false },
        ],
      },
    ]);
    expect(snapshot.pendingAI).toMatchObject({ blocks: [], blockOffset: 3 });
  });

  test("keeps interleaved external transcripts canonical while exposing only the unfinished live tail", () => {
    const id = mkId("display-interleaved-transcript");
    create(id, "openai", "gpt-5.6-sol");
    const conv = get(id)!;
    const firstRound = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "call-glob", name: "glob", input: { pattern: "docs/**" } }],
      metadata: null,
    };
    const firstResult = {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: "call-glob", content: "README.md" }],
      metadata: null,
    };
    const secondRound = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "call-read", name: "read", input: { file_path: "README.md" } }],
      metadata: null,
    };
    const interjection = {
      role: "user" as const,
      content: "How long will this take?",
      metadata: {
        startedAt: 2_000,
        endedAt: 2_000,
        model: "gpt-5.6-sol" as const,
        tokens: 0,
        kind: "realtime_transcript",
      },
    };
    conv.messages.push(
      { role: "user", content: "initial", metadata: null },
      structuredClone(firstRound),
      structuredClone(firstResult),
      interjection,
      structuredClone(secondRound),
    );
    setActiveJob(id, new AbortController(), 1_000);
    replaceStreamingDisplayMessages(id, [firstRound, firstResult, secondRound]);
    replaceCurrentStreamingBlocks(id, [{ type: "text", text: "Still reading" }]);
    setStreamingCommittedBlockCount(id, 3);

    const snapshot = getRenderSnapshot(id, false)!;
    const toolCallIds = snapshot.entries.flatMap(entry =>
      entry.type === "ai"
        ? entry.blocks.filter(block => block.type === "tool_call").map(block => block.toolCallId)
        : []
    );

    expect(toolCallIds).toEqual(["call-glob", "call-read"]);
    expect(snapshot.entries.filter(entry => entry.type === "user" && entry.text === interjection.content)).toHaveLength(1);
    expect(snapshot.pendingAI).toMatchObject({
      blocks: [{ type: "text", text: "Still reading" }],
      blockOffset: 3,
    });
  });

  test("late-join snapshots retain a durable compaction boundary without duplicating its assistant prefix", () => {
    const id = mkId("display-compaction-boundary");
    create(id, "openai", "gpt-5.6-sol");
    const conv = get(id)!;
    const completedAt = 2_000;
    const activeSuffix = [
      { role: "assistant" as const, content: "Before compaction", metadata: null },
      {
        role: "system" as const,
        content: CONTEXT_COMPACTION_FINISHED_TEXT,
        metadata: {
          startedAt: completedAt,
          endedAt: completedAt,
          model: "gpt-5.6-sol",
          tokens: 0,
          kind: CONTEXT_COMPACTION_FINISHED_KIND,
        },
      },
    ];
    conv.messages.push(
      { role: "user", content: "initial", metadata: null },
      ...structuredClone(activeSuffix),
    );
    setActiveJob(id, new AbortController(), 1_000);
    replaceStreamingDisplayMessages(id, activeSuffix);

    const snapshot = getRenderSnapshot(id)!;

    expect(snapshot.entries).toMatchObject([
      {
        type: "user",
        text: "initial",
        contextCheckpoint: { editable: false, contextTokens: null },
      },
      { type: "ai", blocks: [{ type: "text", text: "Before compaction" }], metadata: null },
      {
        type: "system",
        text: CONTEXT_COMPACTION_FINISHED_TEXT,
        color: "muted",
        metadata: activeSuffix[1].metadata,
      },
    ]);
    expect(snapshot.pendingAI?.blocks).toEqual([]);
  });

  test("includes transient streaming messages for active conversations", () => {
    const id = mkId("display-transient");
    create(id, "openai", "gpt-5.5");

    const conv = get(id)!;
    conv.messages.push({ role: "user", content: "initial", metadata: null });

    setActiveJob(id, new AbortController(), Date.now());
    replaceStreamingDisplayMessages(id, [
      { role: "assistant", content: "First tool round done", metadata: null },
      { role: "user", content: "queued next turn", metadata: null },
    ]);
    setStreamingCommittedBlockCount(id, 1);

    const data = getDisplayData(id)!;
    expect(data.entries).toHaveLength(3);
    expect(data.entries[0]).toMatchObject({ type: "user", text: "initial" });
    expect(data.entries[1].type).toBe("ai");
    if (data.entries[1].type !== "ai") throw new Error("expected ai entry");
    expect(data.entries[1].blocks).toEqual([{ type: "text", text: "First tool round done" }]);
    expect(data.entries[2]).toMatchObject({ type: "user", text: "queued next turn" });

    const snapshot = getRenderSnapshot(id)!;
    expect(snapshot.pendingAI).toMatchObject({ blocks: [], blockOffset: 1 });
  });

  test("fingerprints a canonical streaming suffix with its persisted prefix", () => {
    const id = mkId("display-transient-fingerprint");
    const conv = create(id, "openai", "gpt-5.5");
    conv.messages.push(
      { role: "user", content: "initial", metadata: null },
      { role: "assistant", content: "first answer", metadata: null },
      { role: "user", content: "queued next turn", metadata: null },
    );
    setActiveJob(id, new AbortController(), Date.now());
    replaceStreamingDisplayMessages(id, structuredClone(conv.messages.slice(1)));

    const target = getDisplayData(id)!.entries.find(
      (entry) => entry.type === "user" && entry.text === "queued next turn",
    );
    expect(target).toMatchObject({
      type: "user",
      unwindFingerprint: historyPrefixHash(conv.messages, 3),
    });
  });

  test("can omit historical tool_result payloads while still exposing patch data", () => {
    const id = mkId("display-tool-outputs");
    create(id, "openai", "gpt-5.5");
    const conv = get(id)!;
    conv.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "read", input: { file_path: "/tmp/x" } }],
      metadata: null,
    });
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "tool output" }],
      metadata: null,
    });

    const compact = getDisplayData(id, false)!;
    expect(compact.toolOutputsIncluded).toBe(false);
    expect(compact.entries[0].type).toBe("ai");
    if (compact.entries[0].type !== "ai") throw new Error("expected ai entry");
    expect(compact.entries[0].blocks[1]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "",
      output: "",
      isError: false,
    });
    expect(getToolOutputs(id)).toEqual([{ toolCallId: "call-1", output: "tool output" }]);
  });
});
