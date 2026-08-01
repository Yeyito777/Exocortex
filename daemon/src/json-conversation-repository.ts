import type { ConversationRepository } from "./conversation-repository";
import type { Conversation, PersistedConversationSummary } from "./messages";
import { collectToolOutputs } from "./display";
import * as json from "./json-persistence";
import * as displayPages from "./display-page-store";

/** Compatibility repository used by rollback, importer tests, and baselines. */
export class JsonConversationRepository implements ConversationRepository {
  close(): void { /* no open handle */ }

  has(id: string): boolean {
    return this.getSummary(id) !== null;
  }

  load(id: string): Conversation | null {
    return json.load(id);
  }

  loadAllConversations(): Conversation[] {
    return json.loadAllConversations();
  }

  listSummaries(): PersistedConversationSummary[] {
    return json.loadConversationIndex().summaries;
  }

  loadConversationIndex(): json.LoadConversationIndexResult {
    return json.loadConversationIndex();
  }

  getSummary(id: string): PersistedConversationSummary | null {
    return this.listSummaries().find((summary) => summary.id === id) ?? null;
  }

  save(conv: Conversation): void {
    json.save(conv);
  }

  loadFolders() { return json.loadFolders(); }
  saveFolders(folders: Parameters<typeof json.saveFolders>[0]) { json.saveFolders(folders); }
  loadFolderInstructions() { return json.loadFolderInstructions(); }
  saveFolderInstructions(value: Parameters<typeof json.saveFolderInstructions>[0]) { json.saveFolderInstructions(value); }
  loadUnreadConversationIds() { return json.loadUnreadConversationIds(); }
  saveUnreadConversationIds(value: Iterable<string>) { json.saveUnreadConversationIds(value); }
  loadQueuedMessages() { return json.loadQueuedMessages(); }
  saveQueuedMessages(value: Parameters<typeof json.saveQueuedMessages>[0]) { json.saveQueuedMessages(value); }
  loadConversationBtwState() { return json.loadConversationBtwState(); }
  saveConversationBtwState(value: Parameters<typeof json.saveConversationBtwState>[0]) { json.saveConversationBtwState(value); }
  pushTrashEntry(value: json.TrashStackEntry) { json.pushTrashEntry(value); }
  pushUndoEntry(value: json.TrashStackEntry) { json.pushUndoEntry(value); }
  pushRedoEntry(value: json.TrashStackEntry) { json.pushRedoEntry(value); }
  popUndoEntry() { return json.popUndoEntry(); }
  popRedoEntry() { return json.popRedoEntry(); }
  trashConversations(ids: string[], recordUndo = true) { return json.trashConversations(ids, recordUndo); }
  restoreConversationsFromTrash(ids: string[]) { return json.restoreConversationsFromTrash(ids); }
  saveUnwind(base: Conversation, result: Conversation, target: number, options: json.SaveUnwindOptions) {
    json.saveUnwind(base, result, target, options);
  }

  loadDisplayPage(id: string, turns: number, beforeEntryIndex?: number) {
    let page = displayPages.loadDisplayPage(id, turns, beforeEntryIndex);
    if (page) return page;
    const conv = json.loadForDisplayProjection(id);
    const signature = displayPages.getConversationSourceSignature(id);
    if (!conv || !signature || !displayPages.writeDisplayProjection(conv, signature)) return null;
    page = displayPages.loadDisplayPage(id, turns, beforeEntryIndex);
    return page;
  }

  loadToolOutputs(id: string) {
    const conv = json.load(id);
    return conv ? collectToolOutputs(conv.messages) : null;
  }
}
