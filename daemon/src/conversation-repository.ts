import type {
  Conversation,
  PersistedConversationSummary,
  PersistedFolderSummary,
} from "./messages";
import type { ToolOutputInfo } from "./protocol";
import type { StoredDisplayHistoryPage } from "./display-page-store";
import type {
  ConversationBtwPersistenceState,
  LoadConversationIndexResult,
  PersistedQueuedMessage,
  SaveUnwindOptions,
  TrashStackEntry,
} from "./json-persistence";

/**
 * Backend-independent durable conversation contract.
 *
 * Domain callers continue to own mutable Conversation objects between load/save.
 * Repositories return committed snapshots and reject stale generation writes.
 */
export interface ConversationRepository {
  close(): void;

  has(id: string): boolean;
  load(id: string): Conversation | null;
  loadAllConversations(): Conversation[];
  listSummaries(): PersistedConversationSummary[];
  loadConversationIndex(): LoadConversationIndexResult;
  getSummary(id: string): PersistedConversationSummary | null;
  save(conv: Conversation, options?: { forceMessages?: boolean }): void;

  loadFolders(): PersistedFolderSummary[];
  saveFolders(folders: PersistedFolderSummary[]): void;
  loadFolderInstructions(): Map<string, string>;
  saveFolderInstructions(instructions: Map<string, string>): void;

  loadUnreadConversationIds(): string[];
  saveUnreadConversationIds(ids: Iterable<string>): void;
  loadQueuedMessages(): PersistedQueuedMessage[];
  saveQueuedMessages(messages: PersistedQueuedMessage[]): void;
  loadConversationBtwState(): ConversationBtwPersistenceState;
  saveConversationBtwState(state: ConversationBtwPersistenceState): void;

  pushTrashEntry(entry: TrashStackEntry): void;
  pushUndoEntry(entry: TrashStackEntry): void;
  pushRedoEntry(entry: TrashStackEntry): void;
  popUndoEntry(): TrashStackEntry | null;
  popRedoEntry(): TrashStackEntry | null;
  trashConversations(ids: string[], recordUndo?: boolean): string[];
  restoreConversationsFromTrash(ids: string[]): Conversation[];

  saveUnwind(
    base: Conversation,
    result: Conversation,
    targetHistoryCount: number,
    options: SaveUnwindOptions,
  ): void;

  loadDisplayPage(id: string, turns: number, beforeEntryIndex?: number): StoredDisplayHistoryPage | null;
  loadToolOutputs(id: string): ToolOutputInfo[] | null;
}

export interface ConversationTransactionResult<T> {
  committed: boolean;
  generation?: number;
  value?: T;
  error?: "not_found" | "stale_generation" | "constraint" | "io";
  message?: string;
}
