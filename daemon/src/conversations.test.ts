/**
 * Tests for conversations.ts behavior.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { bumpToTop, clearUnread, clone, create, createFolder, createWithInitialUserMessage, deleteFolder, ensureTopLevelFolder, findTopLevelFolderByName, get, getDisplayData, getEffectiveFolderInstructions, getEffectiveSystemInstructions, getFolderInstructions, getRenderSnapshot, getSummary, getToolOutputs, isUnread, listSidebarState, listRunningConversationIds, loadFromDisk, mark, markUnread, moveConversationToFolder, moveSidebarItem, moveSidebarItems, pin, pinFolder, pinSidebarItems, redoDelete, remove, removeMany, rename, renameFolder, setFolderInstructions, setModel, setSystemInstructions, trimConversation, undoDelete, unwindTo } from "./conversations";
import { setActiveJob, replaceStreamingDisplayMessages, clearActiveJob } from "./streaming";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, historyPrefixHash } from "./messages";

const IDS: string[] = [];
const FOLDER_IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `test-conv-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

beforeEach(() => {
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
  for (const id of FOLDER_IDS.splice(0)) {
    deleteFolder(id);
  }
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

    expect(setFolderInstructions(folder.id, "Use repo-local conventions.")).toBe(true);
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
  test("clears context usage measured against the removed transcript suffix", async () => {
    const id = mkId("unwind-context-usage");
    const conv = create(id, "openai", "gpt-5.6-sol");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    conv.lastContextTokens = 350_000;

    expect(await unwindTo(id, 1)).toBe(true);
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    expect(get(id)?.lastContextTokens).toBeNull();
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

    expect(await unwindTo(id, 1)).toBe(true);
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    expect(get(id)?.activeContext).toEqual(checkpoint);
    expect(get(id)?.lastContextTokens).toBeNull();
  });

  test("restores the pre-abort checkpoint when abort recovery advances past the unwind point", async () => {
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
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    const checkpoint = structuredClone(conv.activeContext);
    conv.messages.push({ role: "user", content: "remove", metadata: null });

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

    expect(await unwindTo(id, 1)).toBe(true);
    expect(get(id)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    expect(get(id)?.activeContext).toEqual(checkpoint);
  });

  test("discards a checkpoint when unwinding inside its represented prefix", async () => {
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
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };

    expect(await unwindTo(id, 0)).toBe(true);
    expect(get(id)?.messages).toEqual([]);
    expect(get(id)?.activeContext).toBeNull();
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

    expect(snapshot.entries).toEqual([
      { type: "user", text: "initial" },
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

    const data = getDisplayData(id)!;
    expect(data.entries).toHaveLength(3);
    expect(data.entries[0]).toEqual({ type: "user", text: "initial" });
    expect(data.entries[1].type).toBe("ai");
    if (data.entries[1].type !== "ai") throw new Error("expected ai entry");
    expect(data.entries[1].blocks).toEqual([{ type: "text", text: "First tool round done" }]);
    expect(data.entries[2]).toEqual({ type: "user", text: "queued next turn" });
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
