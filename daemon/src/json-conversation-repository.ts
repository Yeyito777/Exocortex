import type { ConversationRepository } from "./conversation-repository";
import { summarizeConversation, type Conversation, type PersistedConversationSummary } from "./messages";
import { collectToolOutputs } from "./display";
import * as json from "./json-persistence";
import * as displayPages from "./display-page-store";
import { clonedConversationValue, type ConversationCloneTarget } from "./conversation-clone";

/** Compatibility repository used by rollback, importer tests, and baselines. */
export class JsonConversationRepository implements ConversationRepository {
  close(): void { /* no open handle */ }

  has(id: string): boolean {
    return this.getSummary(id) !== null;
  }

  hasDeleted(id: string): boolean {
    return json.hasDeletedConversation(id);
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

  loadToolPolicyState(id: string) {
    const conversation = json.load(id);
    if (!conversation) return null;
    return {
      id: conversation.id,
      subagentMaxDepth: conversation.subagentMaxDepth ?? null,
      subagentPolicy: conversation.subagentPolicy ?? null,
      toolPolicy: conversation.toolPolicy ?? null,
    };
  }

  cloneConversation(sourceId: string, target: ConversationCloneTarget): PersistedConversationSummary | null {
    const source = json.load(sourceId);
    if (!source) return null;
    const cloned = clonedConversationValue(source, target);
    json.save(cloned);
    json.pushTrashEntry({ type: "conversation_removed", id: cloned.id });
    return summarizeConversation(cloned);
  }

  save(conv: Conversation): void {
    json.save(conv);
  }

  appendMessages(conv: Conversation, expectedStoredMessageCount: number): void {
    const durable = json.load(conv.id);
    const durableCount = durable?.messages.length ?? 0;
    if (durableCount !== expectedStoredMessageCount
        || conv.messages.length < expectedStoredMessageCount) {
      throw new Error(
        `Stale conversation append boundary for ${conv.id}: expected=${expectedStoredMessageCount}, durable=${durableCount}, current=${conv.messages.length}`,
      );
    }
    // The compatibility backend is intentionally monolithic. It preserves the
    // append contract and safety boundary while SQLite supplies the bounded hot
    // path used in production.
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

  displayEntryCountBeforeUser() { return null; }

  loadDisplayPage(id: string, turns: number, beforeEntryIndex?: number) {
    let page = displayPages.loadDisplayPage(id, turns, beforeEntryIndex);
    if (page) return page;
    const conv = json.loadForDisplayProjection(id);
    const signature = displayPages.getConversationSourceSignature(id);
    if (!conv || !signature || !displayPages.writeDisplayProjection(conv, signature)) return null;
    page = displayPages.loadDisplayPage(id, turns, beforeEntryIndex);
    return page;
  }

  loadToolOutputs(id: string, toolCallIds?: readonly string[]) {
    const conv = json.load(id);
    return conv
      ? collectToolOutputs(conv.messages, toolCallIds ? new Set(toolCallIds) : undefined)
      : null;
  }
}
