/**
 * Conversation persistence facade.
 *
 * Production uses the normalized per-instance SQLite store. The versioned JSON
 * adapter remains available for explicit rollback, importer coverage, and
 * like-for-like performance baselines.
 */

import type { Conversation, ConversationSummary, PersistedConversationSummary, PersistedFolderSummary } from "./messages";
import type { ToolOutputInfo } from "./protocol";
import type { StoredDisplayHistoryPage } from "./display-page-store";
import type { ConversationToolPolicyState } from "./conversation-repository";
import * as jsonPersistence from "./json-persistence";
import { SqliteConversationStore, sqliteConversationStorePath, type IntegrityReport, type LegacyImportReport } from "./sqlite-conversation-store";

export type {
  ConversationBtwPersistenceState,
  ConversationIndexEntry,
  ConversationSidebarState,
  LoadConversationIndexResult,
  PersistedQueuedMessage,
  PersistedUnwindReceipt,
  SaveUnwindOptions,
  TrashSidebarItemSnapshot,
  TrashStackEntry,
} from "./json-persistence";
export { SqliteConversationStore, sqliteConversationStorePath } from "./sqlite-conversation-store";
export type { IntegrityReport, LegacyImportReport, ExportManifest, SqliteConversationStoreOptions } from "./sqlite-conversation-store";

import type {
  ConversationBtwPersistenceState,
  ConversationIndexEntry,
  ConversationSidebarState,
  LoadConversationIndexResult,
  PersistedQueuedMessage,
  PersistedUnwindReceipt,
  SaveUnwindOptions,
  TrashStackEntry,
} from "./json-persistence";

export type ConversationPersistenceBackend = "json" | "sqlite";

function configuredBackend(): ConversationPersistenceBackend {
  const configured = process.env.EXOCORTEX_CONVERSATION_STORE?.trim().toLowerCase();
  if (configured === "json" || configured === "sqlite") return configured;
  // Existing migration/sidecar tests deliberately exercise the compatibility
  // adapter. SQLite has its own backend contract and integration suites.
  return process.env.EXOCORTEX_TEST === "1" ? "json" : "sqlite";
}

const backend = configuredBackend();
let sqlite: SqliteConversationStore | null = null;

function store(): SqliteConversationStore {
  if (backend !== "sqlite") throw new Error("SQLite conversation store is not selected");
  if (!sqlite) {
    sqlite = new SqliteConversationStore();
    const report = sqlite.importLegacyIfNeeded();
    if (report.status === "incomplete") {
      const detail = report.skipped.slice(0, 5).map((item) => `${item.id}: ${item.error}`).join("; ");
      throw new Error(`SQLite legacy import incomplete (${report.skipped.length} error(s)): ${detail}`);
    }
  }
  return sqlite;
}

export function conversationPersistenceBackend(): ConversationPersistenceBackend {
  return backend;
}

export function isSqliteConversationStore(): boolean {
  return backend === "sqlite";
}

/** Whether an ID is still reserved by a recoverable soft-deleted conversation. */
export function hasDeletedConversation(id: string): boolean {
  return backend === "sqlite" ? store().hasDeleted(id) : jsonPersistence.hasDeletedConversation(id);
}

export function closeConversationPersistence(): void {
  sqlite?.close();
  sqlite = null;
}

export function getConversationFileStat(id: string): { fileSize: number; fileMtimeMs: number } {
  return backend === "sqlite" ? store().getConversationFileStat(id) : jsonPersistence.getConversationFileStat(id);
}

export function indexEntryFromConversation(conv: Conversation): ConversationIndexEntry {
  return backend === "sqlite" ? store().indexEntryFromConversation(conv) : jsonPersistence.indexEntryFromConversation(conv);
}

export function indexEntryFromSummary(summary: PersistedConversationSummary): ConversationIndexEntry {
  return backend === "sqlite" ? store().indexEntryFromSummary(summary) : jsonPersistence.indexEntryFromSummary(summary);
}

export function saveConversationIndex(entries: ConversationIndexEntry[]): void {
  if (backend === "json") jsonPersistence.saveConversationIndex(entries);
}

export function loadConversationIndex(): LoadConversationIndexResult {
  return backend === "sqlite" ? store().loadConversationIndex() : jsonPersistence.loadConversationIndex();
}

export function loadFolders(): PersistedFolderSummary[] {
  return backend === "sqlite" ? store().loadFolders() : jsonPersistence.loadFolders();
}

export function saveFolders(folders: PersistedFolderSummary[]): void {
  if (backend === "sqlite") store().saveFolders(folders);
  else jsonPersistence.saveFolders(folders);
}

export function loadFolderInstructions(): Map<string, string> {
  return backend === "sqlite" ? store().loadFolderInstructions() : jsonPersistence.loadFolderInstructions();
}

export function saveFolderInstructions(instructions: Map<string, string>): void {
  if (backend === "sqlite") store().saveFolderInstructions(instructions);
  else jsonPersistence.saveFolderInstructions(instructions);
}

export function loadUnreadConversationIds(): string[] {
  return backend === "sqlite" ? store().loadUnreadConversationIds() : jsonPersistence.loadUnreadConversationIds();
}

export function saveUnreadConversationIds(ids: Iterable<string>): void {
  if (backend === "sqlite") store().saveUnreadConversationIds(ids);
  else jsonPersistence.saveUnreadConversationIds(ids);
}

export function loadConversationBtwState(): ConversationBtwPersistenceState {
  return backend === "sqlite" ? store().loadConversationBtwState() : jsonPersistence.loadConversationBtwState();
}

export function saveConversationBtwState(state: ConversationBtwPersistenceState): void {
  if (backend === "sqlite") store().saveConversationBtwState(state);
  else jsonPersistence.saveConversationBtwState(state);
}

export function loadQueuedMessages(): PersistedQueuedMessage[] {
  return backend === "sqlite" ? store().loadQueuedMessages() : jsonPersistence.loadQueuedMessages();
}

export function saveQueuedMessages(messages: PersistedQueuedMessage[]): void {
  if (backend === "sqlite") store().saveQueuedMessages(messages);
  else jsonPersistence.saveQueuedMessages(messages);
}

export function pushTrashEntry(entry: TrashStackEntry): void {
  if (backend === "sqlite") store().pushTrashEntry(entry);
  else jsonPersistence.pushTrashEntry(entry);
}

export function pushUndoEntry(entry: TrashStackEntry): void {
  if (backend === "sqlite") store().pushUndoEntry(entry);
  else jsonPersistence.pushUndoEntry(entry);
}

export function pushRedoEntry(entry: TrashStackEntry): void {
  if (backend === "sqlite") store().pushRedoEntry(entry);
  else jsonPersistence.pushRedoEntry(entry);
}

export function popUndoEntry(): TrashStackEntry | null {
  return backend === "sqlite" ? store().popUndoEntry() : jsonPersistence.popUndoEntry();
}

export function popRedoEntry(): TrashStackEntry | null {
  return backend === "sqlite" ? store().popRedoEntry() : jsonPersistence.popRedoEntry();
}

export function getLastUnwindReceipt(conv: Conversation): PersistedUnwindReceipt | null {
  return backend === "sqlite" ? store().getLastUnwindReceipt(conv) : jsonPersistence.getLastUnwindReceipt(conv);
}

export function saveConversationSidebarState(state: ConversationSidebarState): void {
  if (backend === "sqlite") store().saveConversationSidebarState(state);
  else jsonPersistence.saveConversationSidebarState(state);
}

export function hasConversationSidebarState(id: string): boolean {
  return backend === "sqlite" ? store().hasConversationSidebarState(id) : jsonPersistence.hasConversationSidebarState(id);
}

export function saveUnwind(base: Conversation, result: Conversation, targetHistoryCount: number, options: SaveUnwindOptions): void {
  if (backend === "sqlite") store().saveUnwind(base, result, targetHistoryCount, options);
  else jsonPersistence.saveUnwind(base, result, targetHistoryCount, options);
}

export function displayEntryCountBeforeUser(id: string, userMessageIndex: number): number | null {
  return backend === "sqlite" ? store().displayEntryCountBeforeUser(id, userMessageIndex) : null;
}

export function loadUnwindQueueTombstones(): Set<string> {
  return backend === "sqlite" ? store().loadUnwindQueueTombstones() : jsonPersistence.loadUnwindQueueTombstones();
}

export function acknowledgeRecoveredUnwindQueueCleanup(): void {
  if (backend === "sqlite") store().acknowledgeRecoveredUnwindQueueCleanup();
  else jsonPersistence.acknowledgeRecoveredUnwindQueueCleanup();
}

export function removeConversationUnwindReceipt(id: string): void {
  if (backend === "sqlite") store().removeConversationUnwindReceipt(id);
  else jsonPersistence.removeConversationUnwindReceipt(id);
}

export function hasConversationUnwindReceipt(id: string): boolean {
  return backend === "sqlite" ? store().hasConversationUnwindReceipt(id) : jsonPersistence.hasConversationUnwindReceipt(id);
}

export function acknowledgeUnwindQueueCleanup(id: string, operationId: string): void {
  if (backend === "sqlite") store().acknowledgeUnwindQueueCleanup(id, operationId);
  else jsonPersistence.acknowledgeUnwindQueueCleanup(id, operationId);
}

export interface SaveConversationOptions {
  forceMessages?: boolean;
  contextAttributionOnly?: boolean;
}

export function save(conv: Conversation, options: SaveConversationOptions = {}): void {
  if (backend === "sqlite") {
    if (options.contextAttributionOnly) store().saveContextAttribution(conv);
    else store().save(conv, { forceMessages: options.forceMessages });
  } else {
    jsonPersistence.save(conv);
  }
}

/** Commit only the canonical tail beginning at an exact durable boundary. */
export function appendMessages(conv: Conversation, expectedStoredMessageCount: number): void {
  if (backend === "sqlite") {
    store().appendMessages(conv, expectedStoredMessageCount);
    return;
  }
  const durableCount = jsonPersistence.load(conv.id)?.messages.length ?? 0;
  if (durableCount !== expectedStoredMessageCount
      || conv.messages.length < expectedStoredMessageCount) {
    throw new Error(
      `Stale conversation append boundary for ${conv.id}: expected=${expectedStoredMessageCount}, durable=${durableCount}, current=${conv.messages.length}`,
    );
  }
  jsonPersistence.save(conv);
}

export function trashConversations(ids: string[], recordUndo = true): string[] {
  return backend === "sqlite" ? store().trashConversations(ids, recordUndo) : jsonPersistence.trashConversations(ids, recordUndo);
}

export function trashFile(id: string): void {
  if (backend === "sqlite") store().trashConversations([id]);
  else jsonPersistence.trashFile(id);
}

export function trashFolderRecursive(entry: Extract<TrashStackEntry, { type: "folder_recursive" }>, recordUndo = true): boolean {
  return backend === "sqlite" ? store().trashFolderRecursive(entry, recordUndo) : jsonPersistence.trashFolderRecursive(entry, recordUndo);
}

export function restoreConversationsFromTrash(ids: string[]): Conversation[] {
  return backend === "sqlite" ? store().restoreConversationsFromTrash(ids) : jsonPersistence.restoreConversationsFromTrash(ids);
}

export function load(id: string): Conversation | null {
  return backend === "sqlite" ? store().load(id) : jsonPersistence.load(id);
}

/**
 * Load the small capability-policy projection without materializing SQLite
 * message history. The JSON compatibility backend has no columnar projection,
 * so it falls back to its canonical conversation file.
 */
export function loadToolPolicyState(
  id: string,
): ConversationToolPolicyState | null {
  if (backend === "sqlite") return store().loadToolPolicyState(id);
  const conversation = jsonPersistence.load(id);
  if (!conversation) return null;
  return {
    id: conversation.id,
    subagentMaxDepth: conversation.subagentMaxDepth ?? null,
    subagentPolicy: conversation.subagentPolicy ?? null,
    toolPolicy: conversation.toolPolicy ?? null,
  };
}

export function loadForDisplayProjection(id: string): Conversation | null {
  return backend === "sqlite" ? store().load(id) : jsonPersistence.loadForDisplayProjection(id);
}

export function loadAllConversations(): Conversation[] {
  return backend === "sqlite" ? store().loadAllConversations() : jsonPersistence.loadAllConversations();
}

export function loadAll(): ConversationSummary[] {
  if (backend === "json") return jsonPersistence.loadAll();
  return store().listSummaries().map((summary) => ({ ...summary, streaming: false, restartRecoverable: false, unread: false, subagentCount: 0, backgroundTaskCount: 0, tasks: [], integrations: [] }));
}

export function loadDisplayPage(id: string, turns: number, beforeEntryIndex?: number): StoredDisplayHistoryPage | null {
  return backend === "sqlite" ? store().loadDisplayPage(id, turns, beforeEntryIndex) : null;
}

export function loadToolOutputs(id: string): ToolOutputInfo[] | null {
  return backend === "sqlite" ? store().loadToolOutputs(id) : null;
}

export function searchConversationTitles(query: string, limit = 50): PersistedConversationSummary[] {
  if (backend === "sqlite") return store().searchTitles(query, limit);
  const lowered = query.toLowerCase();
  return jsonPersistence.loadConversationIndex().summaries.filter((summary) => summary.title.toLowerCase().includes(lowered)).slice(0, limit);
}

export function checkConversationStoreIntegrity(): IntegrityReport | null {
  return backend === "sqlite" ? store().integrityCheck() : null;
}

export function backupConversationStore(destination: string): string {
  if (backend !== "sqlite") throw new Error("Online backup is available only for SQLite conversation storage");
  return store().backup(destination);
}

export function exportConversation(id: string): Record<string, unknown> | null {
  if (backend !== "sqlite") {
    const conv = jsonPersistence.load(id);
    return conv ? JSON.parse(JSON.stringify(conv)) : null;
  }
  return store().exportConversation(id);
}

export function exportConversationStore(destination: string): import("./sqlite-conversation-store").ExportManifest {
  if (backend !== "sqlite") throw new Error("Normalized full export currently requires SQLite conversation storage");
  return store().exportAll(destination);
}

export function importLegacyConversationStore(): LegacyImportReport {
  if (backend !== "sqlite") throw new Error("Legacy import requires SQLite conversation storage");
  return store().importLegacyIfNeeded();
}
