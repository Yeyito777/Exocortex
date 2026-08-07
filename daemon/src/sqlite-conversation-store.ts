import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDir, conversationsDir, trashDir, isWindows } from "@exocortex/shared/paths";
import type {
  Conversation,
  ConversationBtw,
  PersistedConversationSummary,
  PersistedFolderSummary,
  StoredMessage,
} from "./messages";
import {
  activeContextCompactionHistoryCount,
  countConversationMessages,
  isRealUserMessage,
  isReplayHistoryMessage,
  isValidActiveContextCached,
  summarizeConversation,
} from "./messages";
import type { ToolOutputInfo } from "./protocol";
import { buildDisplayData } from "./display";
import { summarizeTool } from "./tools/registry";
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
import type { StoredDisplayHistoryPage } from "./display-page-store";
import * as legacy from "./json-persistence";
import { log } from "./log";
import type { ConversationRepository, ConversationToolPolicyState } from "./conversation-repository";

const SCHEMA_VERSION = 8;
const DEFAULT_FILE = "exocortex.sqlite3";
const RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES = 8;

export interface SqliteConversationStoreOptions {
  path?: string;
  autoImportLegacy?: boolean;
  readonly?: boolean;
  /** Test-only schema checkpoint builder. Production always migrates to the latest version. */
  targetSchemaVersion?: number;
  /** Test-only crash/fault boundary hook; throwing rolls back the active transaction. */
  faultInjection?: (point: string) => void;
}

export interface IntegrityReport {
  ok: boolean;
  quickCheck: string[];
  foreignKeyErrors: Array<Record<string, unknown>>;
}

export interface LegacyImportReport {
  status: "not-needed" | "complete" | "incomplete";
  discovered: number;
  imported: number;
  reused: number;
  skipped: Array<{ id: string; error: string }>;
  startedAt: number;
  completedAt: number;
}

export interface ExportManifest {
  version: 1;
  exportedAt: number;
  conversations: Array<{ id: string; sha256: string; bytes: number; deleted?: boolean }>;
  files: Record<string, string>;
}

export interface StoreDiagnostics {
  databasePath: string;
  schemaVersion: number;
  databaseBytes: number;
  walBytes: number;
  pageSize: number;
  pageCount: number;
  freePages: number;
  liveConversations: number;
  deletedConversations: number;
  messages: number;
  canonicalContentBytes: number;
  messageBlobs: number;
  messageBlobBytes: number;
  displayEntries: number;
  toolOutputReferences: number;
  queuedMessages: number;
  undoEntries: number;
  redoEntries: number;
  importStatus: string | null;
}

interface ConversationRow {
  id: string;
  provider: Conversation["provider"];
  model: string;
  effort: Conversation["effort"];
  fast_mode: number;
  created_at: number;
  updated_at: number;
  last_context_tokens: number | null;
  marked: number;
  pinned: number;
  muted: number;
  sort_order: number;
  folder_id: string | null;
  title: string;
  goal_json: string | null;
  subagent_max_depth: number | null;
  subagent_policy_json: string | null;
  tool_policy_json: string | null;
  storage_generation: number;
  message_count: number;
  stored_message_count: number;
  display_entry_count: number;
  content_bytes: number;
  deleted_at: number | null;
}

interface MessageRow {
  sequence: number;
  role: StoredMessage["role"];
  content_json: string;
  metadata_json: string | null;
  provider_data_json: string | null;
  context_tokens_json: string | null;
  context_checkpoint_json: string | null;
  has_provider_data: number;
  has_context_tokens: number;
  has_context_checkpoint: number;
}

interface MessageBlobRow {
  message_sequence: number;
  ordinal: number;
  kind: "tool_result" | "image";
  payload_json: string;
}

interface LoadedMessageSnapshot {
  ref: StoredMessage;
  role: StoredMessage["role"];
  contentRef: unknown;
  contentString: string | null;
  metadataJson: string | null;
  providerDataRef: unknown;
  hasProviderData: boolean;
  contextTokensJson: string | null;
  hasContextTokens: boolean;
  checkpointJson: string | null;
  hasCheckpoint: boolean;
}

interface LoadedConversationState {
  generation: number;
  messages: LoadedMessageSnapshot[];
  activeContextRef: Conversation["activeContext"];
  lastUnwindReceipt: PersistedUnwindReceipt | null;
}

function optionalJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseOptional<T>(value: string | null): T | null {
  return value == null ? null : JSON.parse(value) as T;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeId(id: string): void {
  if (!id || id === "." || id.length > 240 || /[\/\\]|\.\.|\0/.test(id)) {
    throw new Error(`Invalid conversation ID: ${id}`);
  }
}

function messageFingerprint(message: StoredMessage): string {
  return sha256(JSON.stringify({
    role: message.role,
    content: message.content,
    metadata: message.metadata,
    providerData: message.providerData ?? null,
    contextTokens: message.contextTokens ?? null,
    contextCheckpoint: message.contextCheckpoint ?? null,
  }));
}

function messageSnapshot(message: StoredMessage): LoadedMessageSnapshot {
  return {
    ref: message,
    role: message.role,
    contentRef: message.content,
    contentString: typeof message.content === "string" ? message.content : null,
    metadataJson: optionalJson(message.metadata),
    providerDataRef: message.providerData,
    hasProviderData: Object.hasOwn(message, "providerData"),
    contextTokensJson: optionalJson(message.contextTokens),
    hasContextTokens: Object.hasOwn(message, "contextTokens"),
    checkpointJson: optionalJson(message.contextCheckpoint),
    hasCheckpoint: Object.hasOwn(message, "contextCheckpoint"),
  };
}

function messageChangedExceptContextAttribution(snapshot: LoadedMessageSnapshot, message: StoredMessage): boolean {
  if (snapshot.ref !== message || snapshot.role !== message.role) return true;
  if (snapshot.contentRef !== message.content) return true;
  if (typeof message.content === "string" && snapshot.contentString !== message.content) return true;
  if (snapshot.providerDataRef !== message.providerData || snapshot.hasProviderData !== Object.hasOwn(message, "providerData")) return true;
  if (snapshot.metadataJson !== optionalJson(message.metadata)) return true;
  return snapshot.hasCheckpoint !== Object.hasOwn(message, "contextCheckpoint")
    || snapshot.checkpointJson !== optionalJson(message.contextCheckpoint);
}

function messageContextAttributionChanged(snapshot: LoadedMessageSnapshot, message: StoredMessage): boolean {
  return snapshot.hasContextTokens !== Object.hasOwn(message, "contextTokens")
    || snapshot.contextTokensJson !== optionalJson(message.contextTokens);
}

function messageShallowChanged(snapshot: LoadedMessageSnapshot, message: StoredMessage): boolean {
  return messageChangedExceptContextAttribution(snapshot, message)
    || messageContextAttributionChanged(snapshot, message);
}

function storedMessageFromRow(row: MessageRow, blobs: MessageBlobRow[] = []): StoredMessage {
  const content = JSON.parse(row.content_json);
  if (Array.isArray(content)) {
    for (const blob of blobs) {
      const payload = JSON.parse(blob.payload_json) as { blockIndex: number; value: unknown };
      const block = content[payload.blockIndex];
      if (!block || typeof block !== "object") continue;
      if (blob.kind === "tool_result" && block.type === "tool_result") block.content = payload.value;
      if (blob.kind === "image" && block.type === "image" && block.source) block.source.data = payload.value;
    }
  }
  const message: StoredMessage = {
    role: row.role,
    content,
    metadata: parseOptional(row.metadata_json),
  };
  const providerData = parseOptional<NonNullable<StoredMessage["providerData"]>>(row.provider_data_json);
  if (row.has_provider_data === 1) (message as unknown as Record<string, unknown>).providerData = providerData;
  if (row.has_context_tokens === 1) message.contextTokens = parseOptional(row.context_tokens_json);
  const checkpoint = parseOptional<NonNullable<StoredMessage["contextCheckpoint"]>>(row.context_checkpoint_json);
  if (row.has_context_checkpoint === 1) (message as unknown as Record<string, unknown>).contextCheckpoint = checkpoint;
  return message;
}

function normalizeFolder(folder: PersistedFolderSummary): PersistedFolderSummary {
  return {
    id: folder.id,
    name: folder.name || "Folder",
    parentId: folder.parentId ?? null,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    pinned: folder.pinned === true,
    muted: folder.muted === true,
    sortOrder: folder.sortOrder,
  };
}

function pagedUserFingerprint(convId: string, userIndex: number, message: StoredMessage): string {
  const hash = createHash("sha256");
  hash.update(convId);
  hash.update("\n");
  hash.update(String(userIndex));
  hash.update("\n");
  hash.update(JSON.stringify({ role: message.role, content: message.content, providerData: message.providerData ?? null }));
  return `page-v1:${hash.digest("hex").slice(0, 24)}`;
}

function projectedEditableHistoryStart(conv: Conversation): number | null | undefined {
  const active = conv.activeContext;
  if (active) {
    const count = activeContextCompactionHistoryCount(active, conv.messages);
    return count == null ? null : count;
  }
  return conv.messages.some((message) => message.metadata?.kind === "context_compaction_finished")
    ? null
    : undefined;
}

/** The domain has already validated this active context before committing an unwind. */
function validatedUnwindEditableHistoryStart(conv: Conversation): number | null | undefined {
  const active = conv.activeContext;
  if (active) {
    // Modern contexts persist this immutable boundary. Legacy contexts still
    // require the cheap divider scan in activeContextCompactionHistoryCount().
    return active.compactionHistoryCount ?? activeContextCompactionHistoryCount(active, conv.messages);
  }
  return conv.messages.some((message) => message.metadata?.kind === "context_compaction_finished")
    ? null
    : undefined;
}

function compactOldImages(entry: any, index: number, total: number): any {
  if (entry?.type !== "user" || !entry.images?.length || index >= total - RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES) {
    return entry;
  }
  return {
    ...entry,
    images: entry.images.map((image: any) => ({ ...image, base64: "" })),
  };
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

export function sqliteConversationStorePath(): string {
  return join(dataDir(), DEFAULT_FILE);
}

export class SqliteConversationStore implements ConversationRepository {
  readonly path: string;
  readonly db: Database;
  private loadedState = new WeakMap<Conversation, LoadedConversationState>();
  private loadedById = new Map<string, WeakRef<Conversation>>();
  private closed = false;
  private readonly readOnly: boolean;
  private readonly faultInjection?: (point: string) => void;

  constructor(options: SqliteConversationStoreOptions = {}) {
    this.path = resolve(options.path ?? sqliteConversationStorePath());
    this.readOnly = options.readonly ?? false;
    this.faultInjection = options.faultInjection;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new Database(this.path, { create: !options.readonly, readonly: options.readonly ?? false });
    try {
      try { chmodSync(this.path, 0o600); } catch { /* best effort, especially on Windows */ }
      this.configure();
      this.migrate(options.targetSchemaVersion ?? SCHEMA_VERSION);
      if (options.autoImportLegacy) this.importLegacyIfNeeded();
    } catch (err) {
      // A constructor that throws must not leave the database locked. This is
      // observable immediately on Windows and matters to restore/repair flows.
      try { this.db.close(); } catch { /* preserve the initialization error */ }
      this.closed = true;
      if (isWindows) Bun.gc(true);
      throw err;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite conversation store is closed");
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    if (!this.readOnly) {
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=NORMAL");
      this.db.exec("PRAGMA wal_autocheckpoint=1000");
    }
    const foreignKeys = this.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys;
    if (foreignKeys !== 1) throw new Error("SQLite foreign key enforcement could not be enabled");
  }

  private migrate(targetVersion: number): void {
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion > SCHEMA_VERSION) {
      throw new Error(`Invalid target conversation schema version: ${targetVersion}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    const current = this.db.query<{ version: number }, []>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()!.version;
    if (current > SCHEMA_VERSION) {
      throw new Error(`Unsupported future conversation database schema ${current}; this binary supports ${SCHEMA_VERSION}`);
    }
    if (current < 1) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE store_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;

          CREATE TABLE folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
            sort_order REAL NOT NULL
          ) STRICT;

          CREATE TABLE folder_instructions (
            folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
            text TEXT NOT NULL
          ) STRICT;

          CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            effort TEXT NOT NULL,
            fast_mode INTEGER NOT NULL CHECK (fast_mode IN (0,1)),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_context_tokens INTEGER,
            marked INTEGER NOT NULL CHECK (marked IN (0,1)),
            pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
            sort_order REAL NOT NULL,
            -- Folder IDs are deliberately not foreign-keyed: soft-deleted
            -- conversations retain membership while their folder tree is in the
            -- undo stack and temporarily absent from the live folders table.
            folder_id TEXT,
            title TEXT NOT NULL,
            goal_json TEXT,
            subagent_max_depth INTEGER,
            subagent_policy_json TEXT,
            storage_generation INTEGER NOT NULL CHECK (storage_generation > 0),
            message_count INTEGER NOT NULL DEFAULT 0,
            stored_message_count INTEGER NOT NULL DEFAULT 0,
            display_entry_count INTEGER NOT NULL DEFAULT 0,
            deleted_at INTEGER
          ) STRICT;

          CREATE TABLE active_contexts (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            transcript_history_count INTEGER NOT NULL,
            transcript_prefix_hash TEXT NOT NULL,
            compaction_history_count INTEGER,
            compaction_prefix_hash TEXT,
            window_id TEXT NOT NULL,
            window_number INTEGER NOT NULL,
            compacted_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL
          ) STRICT;

          CREATE TABLE messages (
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK (sequence >= 0),
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            metadata_json TEXT,
            provider_data_json TEXT,
            context_tokens_json TEXT,
            context_checkpoint_json TEXT,
            is_real_user INTEGER NOT NULL CHECK (is_real_user IN (0,1)),
            is_replay_history INTEGER NOT NULL CHECK (is_replay_history IN (0,1)),
            content_bytes INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            message_hash TEXT NOT NULL,
            PRIMARY KEY (conversation_id, sequence)
          ) WITHOUT ROWID, STRICT;

          CREATE TABLE tool_outputs (
            conversation_id TEXT NOT NULL,
            message_sequence INTEGER NOT NULL,
            ordinal INTEGER NOT NULL,
            tool_call_id TEXT NOT NULL,
            output TEXT NOT NULL,
            is_error INTEGER NOT NULL CHECK (is_error IN (0,1)),
            PRIMARY KEY (conversation_id, message_sequence, ordinal),
            FOREIGN KEY (conversation_id, message_sequence)
              REFERENCES messages(conversation_id, sequence) ON DELETE CASCADE
          ) WITHOUT ROWID, STRICT;

          CREATE TABLE display_entries (
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
            entry_index INTEGER NOT NULL CHECK (entry_index >= 0),
            user_index INTEGER,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (conversation_id, pinned, entry_index)
          ) WITHOUT ROWID, STRICT;

          CREATE TABLE unread_conversations (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            marked_at INTEGER NOT NULL
          ) STRICT;

          CREATE TABLE queued_messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            timing TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL
          ) STRICT;

          CREATE TABLE sidebar_history (
            stack TEXT NOT NULL CHECK (stack IN ('undo','redo')),
            position INTEGER NOT NULL,
            entry_json TEXT NOT NULL,
            PRIMARY KEY (stack, position)
          ) WITHOUT ROWID, STRICT;

          CREATE TABLE unwind_receipts (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            operation_id TEXT NOT NULL,
            user_message_index INTEGER NOT NULL,
            history_total_entries INTEGER NOT NULL,
            superseded_queue_ids_json TEXT NOT NULL
          ) STRICT;

          CREATE TABLE btw_sessions (
            -- BTW can be restored before conversation summaries finish loading.
            conversation_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL
          ) STRICT;

          CREATE TABLE btw_receipts (
            conversation_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            PRIMARY KEY (conversation_id, session_id)
          ) WITHOUT ROWID, STRICT;

          CREATE TABLE import_sources (
            conversation_id TEXT PRIMARY KEY,
            source_size INTEGER NOT NULL,
            source_mtime_ms REAL NOT NULL,
            source_generation INTEGER NOT NULL,
            source_sha256 TEXT NOT NULL,
            imported_at INTEGER NOT NULL
          ) STRICT;

          CREATE INDEX conversations_live_sidebar_idx
            ON conversations(deleted_at, folder_id, pinned DESC, sort_order, id);
          CREATE INDEX conversations_live_updated_idx
            ON conversations(deleted_at, updated_at DESC, id);
          CREATE INDEX conversations_goal_idx
            ON conversations(deleted_at, goal_json) WHERE goal_json IS NOT NULL;
          CREATE INDEX messages_page_idx
            ON messages(conversation_id, is_real_user, sequence);
          CREATE INDEX display_user_page_idx
            ON display_entries(conversation_id, pinned, user_index, entry_index);
          CREATE INDEX queue_position_idx ON queued_messages(position, id);
          CREATE INDEX queue_target_idx ON queued_messages(conversation_id, position);
          CREATE INDEX history_stack_idx ON sidebar_history(stack, position DESC);
        `);
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(1, "normalized conversation store", Date.now());
      })();
    }
    if (current < 2 && targetVersion >= 2) {
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE messages ADD COLUMN has_provider_data INTEGER NOT NULL DEFAULT 0 CHECK (has_provider_data IN (0,1));
          ALTER TABLE messages ADD COLUMN has_context_tokens INTEGER NOT NULL DEFAULT 0 CHECK (has_context_tokens IN (0,1));
          ALTER TABLE messages ADD COLUMN has_context_checkpoint INTEGER NOT NULL DEFAULT 0 CHECK (has_context_checkpoint IN (0,1));
          UPDATE messages SET has_provider_data=1 WHERE provider_data_json IS NOT NULL;
          UPDATE messages SET has_context_tokens=1 WHERE context_tokens_json IS NOT NULL;
          UPDATE messages SET has_context_checkpoint=1 WHERE context_checkpoint_json IS NOT NULL;
        `);
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(2, "preserve optional message field presence", Date.now());
      })();
    }
    if (current < 3 && targetVersion >= 3) {
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE conversations ADD COLUMN content_bytes INTEGER NOT NULL DEFAULT 0;
          UPDATE conversations SET content_bytes=(
            SELECT COALESCE(SUM(content_bytes), 0) FROM messages
            WHERE messages.conversation_id=conversations.id
          );
        `);
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(3, "constant-time conversation byte totals", Date.now());
      })();
    }
    if (current < 4 && targetVersion >= 4) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE VIRTUAL TABLE conversation_title_fts USING fts5(
            conversation_id UNINDEXED,
            title,
            tokenize='unicode61'
          );
          INSERT INTO conversation_title_fts(conversation_id, title)
            SELECT id, title FROM conversations;
          CREATE TRIGGER conversation_title_fts_insert AFTER INSERT ON conversations BEGIN
            INSERT INTO conversation_title_fts(conversation_id, title) VALUES (new.id, new.title);
          END;
          CREATE TRIGGER conversation_title_fts_update AFTER UPDATE OF title ON conversations BEGIN
            DELETE FROM conversation_title_fts WHERE conversation_id=old.id;
            INSERT INTO conversation_title_fts(conversation_id, title) VALUES (new.id, new.title);
          END;
          CREATE TRIGGER conversation_title_fts_delete AFTER DELETE ON conversations BEGIN
            DELETE FROM conversation_title_fts WHERE conversation_id=old.id;
          END;
        `);
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(4, "indexed title search", Date.now());
      })();
    }
    if (current < 5 && targetVersion >= 5) {
      this.db.transaction(() => {
        // Canonical content already owns tool-result bytes. Keep only the direct
        // lookup identity here so large outputs are not duplicated in storage.
        this.db.query("UPDATE tool_outputs SET output='' WHERE output<>''").run();
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(5, "deduplicate tool output payloads", Date.now());
      })();
    }
    if (current < 6 && targetVersion >= 6) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE message_blobs (
            conversation_id TEXT NOT NULL,
            message_sequence INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('tool_result','image')),
            ordinal INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            payload_bytes INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            PRIMARY KEY (conversation_id, message_sequence, kind, ordinal),
            FOREIGN KEY (conversation_id, message_sequence)
              REFERENCES messages(conversation_id, sequence) ON DELETE CASCADE
          ) WITHOUT ROWID, STRICT;
          CREATE INDEX message_blobs_lookup_idx
            ON message_blobs(conversation_id, kind, message_sequence, ordinal);
        `);
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(6, "separate large message payloads", Date.now());
      })();
    }
    if (current < 7 && targetVersion >= 7) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE conversations ADD COLUMN tool_policy_json TEXT;");
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(7, "per-conversation tool policy", Date.now());
      })();
    }
    if (current < 8 && targetVersion >= 8) {
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE conversations ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1));
          ALTER TABLE folders ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1));
        `);
        this.db.query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(8, "conversation and folder muting", Date.now());
      })();
    }
  }

  close(): void {
    if (this.closed) return;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    this.db.close();
    this.closed = true;
    // sqlite3_close_v2 defers the underlying close while prepared transaction
    // helpers are awaiting collection. Windows keeps the file locked until then.
    if (isWindows) Bun.gc(true);
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    this.assertOpen();
    this.db.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  integrityCheck(): IntegrityReport {
    this.assertOpen();
    const quickCheck = this.db.query<Record<string, string>, []>("PRAGMA quick_check").all().flatMap((row) => Object.values(row));
    const foreignKeyErrors = this.db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
    return { ok: quickCheck.length === 1 && quickCheck[0] === "ok" && foreignKeyErrors.length === 0, quickCheck, foreignKeyErrors };
  }

  diagnostics(): StoreDiagnostics {
    this.assertOpen();
    const scalar = (sql: string): number => {
      const row = this.db.query<Record<string, number>, []>(sql).get();
      return Number(row ? Object.values(row)[0] : 0);
    };
    return {
      databasePath: this.path,
      schemaVersion: scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migrations"),
      databaseBytes: existsSync(this.path) ? statSync(this.path).size : 0,
      walBytes: existsSync(`${this.path}-wal`) ? statSync(`${this.path}-wal`).size : 0,
      pageSize: scalar("PRAGMA page_size"),
      pageCount: scalar("PRAGMA page_count"),
      freePages: scalar("PRAGMA freelist_count"),
      liveConversations: scalar("SELECT COUNT(*) FROM conversations WHERE deleted_at IS NULL"),
      deletedConversations: scalar("SELECT COUNT(*) FROM conversations WHERE deleted_at IS NOT NULL"),
      messages: scalar("SELECT COUNT(*) FROM messages"),
      canonicalContentBytes: scalar("SELECT COALESCE(SUM(content_bytes), 0) FROM conversations"),
      messageBlobs: scalar("SELECT COUNT(*) FROM message_blobs"),
      messageBlobBytes: scalar("SELECT COALESCE(SUM(payload_bytes), 0) FROM message_blobs"),
      displayEntries: scalar("SELECT COUNT(*) FROM display_entries"),
      toolOutputReferences: scalar("SELECT COUNT(*) FROM tool_outputs"),
      queuedMessages: scalar("SELECT COUNT(*) FROM queued_messages"),
      undoEntries: scalar("SELECT COUNT(*) FROM sidebar_history WHERE stack='undo'"),
      redoEntries: scalar("SELECT COUNT(*) FROM sidebar_history WHERE stack='redo'"),
      importStatus: this.metadata("legacy_import_complete") === "1"
        ? "complete"
        : (this.metadata("legacy_import_report") ? "incomplete" : "not-run"),
    };
  }

  backup(destination: string): string {
    this.assertOpen();
    const dest = resolve(destination);
    if (dest === this.path) throw new Error("Backup destination must differ from the active database");
    if (existsSync(dest)) throw new Error(`Backup destination already exists: ${dest}`);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    try {
      this.checkpoint("FULL");
      this.db.query("VACUUM INTO ?").run(tmp);
      const check = new Database(tmp, { readonly: true });
      try {
        const result = check.query<Record<string, string>, []>("PRAGMA quick_check").all().flatMap((row) => Object.values(row));
        if (result.length !== 1 || result[0] !== "ok") throw new Error(`Backup integrity check failed: ${result.join(", ")}`);
      } finally {
        check.close();
      }
      renameSync(tmp, dest);
      try { chmodSync(dest, 0o600); } catch { /* best effort */ }
      return dest;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  restoreToNewFile(source: string, destination: string): string {
    const src = resolve(source);
    const dest = resolve(destination);
    if (dest === this.path) throw new Error("Restore refuses to overwrite the active database");
    if (existsSync(dest)) throw new Error(`Restore destination already exists: ${dest}`);
    const sourceDb = new Database(src, { readonly: true });
    try {
      const result = sourceDb.query<Record<string, string>, []>("PRAGMA quick_check").all().flatMap((row) => Object.values(row));
      if (result.length !== 1 || result[0] !== "ok") throw new Error(`Restore source integrity check failed: ${result.join(", ")}`);
    } finally {
      sourceDb.close();
    }
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    try {
      copyFileSync(src, tmp);
      renameSync(tmp, dest);
      try { chmodSync(dest, 0o600); } catch { /* best effort */ }
      return dest;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private metadata(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM store_metadata WHERE key=?").get(key)?.value ?? null;
  }

  private setMetadata(key: string, value: string): void {
    this.db.query(`
      INSERT INTO store_metadata(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, Date.now());
  }

  private row(id: string, includeDeleted = false): ConversationRow | null {
    assertSafeId(id);
    return this.db.query<ConversationRow, [string]>(`
      SELECT * FROM conversations WHERE id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
    `).get(id) ?? null;
  }

  has(id: string): boolean {
    return this.row(id) !== null;
  }

  hasDeleted(id: string): boolean {
    const row = this.row(id, true);
    return row !== null && row.deleted_at !== null;
  }

  private summaryFromRow(row: ConversationRow): PersistedConversationSummary {
    return {
      id: row.id,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      fastMode: row.fast_mode === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      title: row.title,
      goal: parseOptional(row.goal_json),
      marked: row.marked === 1,
      pinned: row.pinned === 1,
      muted: row.muted === 1,
      sortOrder: row.sort_order,
      folderId: row.folder_id,
    };
  }

  listSummaries(): PersistedConversationSummary[] {
    // Array-valued rows avoid allocating 20+ keyed properties per conversation,
    // and selecting only summary columns keeps startup proportional to compact
    // metadata rather than the complete canonical row shape.
    const rows = this.db.query(`
      SELECT id, provider, model, effort, fast_mode, created_at, updated_at,
             message_count, title, goal_json, marked, pinned, muted, sort_order, folder_id
      FROM conversations
      WHERE deleted_at IS NULL
      ORDER BY pinned DESC, sort_order, id
    `).values() as Array<[string, Conversation["provider"], string, Conversation["effort"], number, number, number, number, string, string | null, number, number, number, number, string | null]>;
    return rows.map(([
      id, provider, model, effort, fastMode, createdAt, updatedAt,
      messageCount, title, goalJson, marked, pinned, muted, sortOrder, folderId,
    ]) => ({
      id,
      provider,
      model,
      effort,
      fastMode: fastMode === 1,
      createdAt,
      updatedAt,
      messageCount,
      title,
      goal: parseOptional(goalJson),
      marked: marked === 1,
      pinned: pinned === 1,
      muted: muted === 1,
      sortOrder,
      folderId,
    }));
  }

  getSummary(id: string): PersistedConversationSummary | null {
    const row = this.row(id);
    return row ? this.summaryFromRow(row) : null;
  }

  /** Read only the compact fields needed to resolve current tool availability. */
  loadToolPolicyState(
    id: string,
  ): ConversationToolPolicyState | null {
    const row = this.row(id);
    if (!row) return null;
    return {
      id: row.id,
      subagentMaxDepth: row.subagent_max_depth,
      subagentPolicy: parseOptional(row.subagent_policy_json),
      toolPolicy: parseOptional(row.tool_policy_json),
    };
  }

  getConversationFileStat(id: string): { fileSize: number; fileMtimeMs: number } {
    const row = this.db.query<{ content_bytes: number; updated_at: number }, [string]>(`
      SELECT content_bytes, updated_at FROM conversations WHERE id=? AND deleted_at IS NULL
    `).get(id);
    if (!row) throw new Error(`Conversation not found: ${id}`);
    return { fileSize: row.content_bytes, fileMtimeMs: row.updated_at };
  }

  indexEntryFromConversation(conv: Conversation): ConversationIndexEntry {
    const stat = this.getConversationFileStat(conv.id);
    const generation = this.loadedState.get(conv)?.generation ?? this.row(conv.id, true)?.storage_generation ?? 1;
    return { ...summarizeConversation(conv), ...stat, storageGeneration: generation };
  }

  indexEntryFromSummary(summary: PersistedConversationSummary): ConversationIndexEntry {
    const stat = this.getConversationFileStat(summary.id);
    const generation = this.row(summary.id, true)?.storage_generation ?? 1;
    return { ...summary, ...stat, storageGeneration: generation };
  }

  loadConversationIndex(): LoadConversationIndexResult {
    return { summaries: this.listSummaries(), reused: this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM conversations WHERE deleted_at IS NULL").get()!.count, rebuilt: 0, removed: 0, saved: false };
  }

  private loadMessages(id: string): StoredMessage[] {
    const rows = this.db.query<MessageRow, [string]>(`
      SELECT sequence, role, content_json, metadata_json, provider_data_json,
             context_tokens_json, context_checkpoint_json, has_provider_data,
             has_context_tokens, has_context_checkpoint
      FROM messages WHERE conversation_id=? ORDER BY sequence
    `).all(id);
    const blobsBySequence = new Map<number, MessageBlobRow[]>();
    for (const blob of this.db.query<MessageBlobRow, [string]>(`
      SELECT message_sequence, ordinal, kind, payload_json FROM message_blobs
      WHERE conversation_id=? ORDER BY message_sequence, kind, ordinal
    `).all(id)) {
      const blobs = blobsBySequence.get(blob.message_sequence) ?? [];
      blobs.push(blob);
      blobsBySequence.set(blob.message_sequence, blobs);
    }
    return rows.map((row) => storedMessageFromRow(row, blobsBySequence.get(row.sequence)));
  }

  load(id: string, includeDeleted = false): Conversation | null {
    const row = this.row(id, includeDeleted);
    if (!row) return null;
    try {
      const messages = this.loadMessages(id);
      const activeRow = this.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM active_contexts WHERE conversation_id=?").get(id);
      const persistedActive = activeRow ? JSON.parse(activeRow.payload_json) as NonNullable<Conversation["activeContext"]> : null;
      const activeContext = persistedActive && isValidActiveContextCached(persistedActive, messages) ? persistedActive : null;
      if (persistedActive && !activeContext) log("warn", `sqlite: discarded invalid active context for ${id}; full transcript will be replayed`);
      const conv: Conversation = {
        id: row.id,
        provider: row.provider,
        model: row.model,
        effort: row.effort,
        fastMode: row.fast_mode === 1,
        messages,
        ...(activeContext ? { activeContext } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastContextTokens: persistedActive && !activeContext ? null : row.last_context_tokens,
        marked: row.marked === 1,
        pinned: row.pinned === 1,
        muted: row.muted === 1,
        sortOrder: row.sort_order,
        folderId: row.folder_id,
        title: row.title,
        goal: parseOptional(row.goal_json),
        subagentMaxDepth: row.subagent_max_depth,
        subagentPolicy: parseOptional(row.subagent_policy_json),
        toolPolicy: parseOptional(row.tool_policy_json),
      };
      const receiptRow = this.db.query<{
        operation_id: string;
        user_message_index: number;
        history_total_entries: number;
      }, [string]>("SELECT operation_id, user_message_index, history_total_entries FROM unwind_receipts WHERE conversation_id=?").get(id);
      const receipt = receiptRow ? {
        operationId: receiptRow.operation_id,
        userMessageIndex: receiptRow.user_message_index,
        historyTotalEntries: receiptRow.history_total_entries,
      } : null;
      this.loadedState.set(conv, { generation: row.storage_generation, messages: messages.map(messageSnapshot), activeContextRef: conv.activeContext, lastUnwindReceipt: receipt });
      this.loadedById.set(conv.id, new WeakRef(conv));
      return conv;
    } catch (error) {
      log("error", `sqlite: failed to load ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  loadAllConversations(): Conversation[] {
    return this.listSummaries().map((summary) => this.load(summary.id)).filter((conv): conv is Conversation => conv !== null);
  }

  private insertMessage(id: string, sequence: number, message: StoredMessage): number {
    const fullContentJson = JSON.stringify(message.content);
    const contentBytes = Buffer.byteLength(fullContentJson);
    const blobs: Array<{ kind: "tool_result" | "image"; ordinal: number; payload: string }> = [];
    const tools: Array<{ ordinal: number; toolCallId: string; isError: boolean }> = [];
    let storedContent: StoredMessage["content"] = message.content;
    if (Array.isArray(message.content)) {
      let toolOrdinal = 0;
      let imageOrdinal = 0;
      storedContent = message.content.map((part, blockIndex) => {
        if (part.type === "tool_result") {
          const ordinal = toolOrdinal++;
          blobs.push({ kind: "tool_result", ordinal, payload: JSON.stringify({ blockIndex, value: part.content }) });
          tools.push({ ordinal, toolCallId: part.tool_use_id, isError: part.is_error === true });
          return { ...part, content: "" };
        }
        if (part.type === "image") {
          const ordinal = imageOrdinal++;
          blobs.push({ kind: "image", ordinal, payload: JSON.stringify({ blockIndex, value: part.source.data }) });
          return { ...part, source: { ...part.source, data: "" } };
        }
        return part;
      });
    }
    const contentJson = JSON.stringify(storedContent);
    const metadataJson = optionalJson(message.metadata);
    const providerDataJson = optionalJson(message.providerData);
    const contextTokensJson = optionalJson(message.contextTokens);
    const checkpointJson = optionalJson(message.contextCheckpoint);
    this.db.query(`
      INSERT INTO messages(
        conversation_id, sequence, role, content_json, metadata_json,
        provider_data_json, context_tokens_json, context_checkpoint_json,
        is_real_user, is_replay_history, content_bytes, content_hash, message_hash,
        has_provider_data, has_context_tokens, has_context_checkpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sequence,
      message.role,
      contentJson,
      metadataJson,
      providerDataJson,
      contextTokensJson,
      checkpointJson,
      isRealUserMessage(message) ? 1 : 0,
      isReplayHistoryMessage(message) ? 1 : 0,
      contentBytes,
      sha256(fullContentJson),
      messageFingerprint(message),
      Object.hasOwn(message, "providerData") ? 1 : 0,
      Object.hasOwn(message, "contextTokens") ? 1 : 0,
      Object.hasOwn(message, "contextCheckpoint") ? 1 : 0,
    );
    for (const tool of tools) {
      this.db.query(`
        INSERT INTO tool_outputs(conversation_id, message_sequence, ordinal, tool_call_id, output, is_error)
        VALUES (?, ?, ?, ?, '', ?)
      `).run(id, sequence, tool.ordinal, tool.toolCallId, tool.isError ? 1 : 0);
    }
    for (const blob of blobs) {
      this.db.query(`
        INSERT INTO message_blobs(
          conversation_id, message_sequence, kind, ordinal, payload_json, payload_bytes, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sequence, blob.kind, blob.ordinal, blob.payload, Buffer.byteLength(blob.payload), sha256(blob.payload));
    }
    return contentBytes;
  }

  private upsertConversationRow(conv: Conversation, generation: number): void {
    const summary = summarizeConversation(conv);
    this.db.query(`
      INSERT INTO conversations(
        id, provider, model, effort, fast_mode, created_at, updated_at,
        last_context_tokens, marked, pinned, muted, sort_order, folder_id, title,
        goal_json, subagent_max_depth, subagent_policy_json, tool_policy_json, storage_generation,
        message_count, stored_message_count, display_entry_count, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET
        provider=excluded.provider, model=excluded.model, effort=excluded.effort,
        fast_mode=excluded.fast_mode, created_at=excluded.created_at,
        updated_at=excluded.updated_at, last_context_tokens=excluded.last_context_tokens,
        marked=excluded.marked, pinned=excluded.pinned, muted=excluded.muted, sort_order=excluded.sort_order,
        folder_id=excluded.folder_id, title=excluded.title, goal_json=excluded.goal_json,
        subagent_max_depth=excluded.subagent_max_depth,
        subagent_policy_json=excluded.subagent_policy_json,
        tool_policy_json=excluded.tool_policy_json,
        storage_generation=excluded.storage_generation, message_count=excluded.message_count,
        stored_message_count=excluded.stored_message_count, deleted_at=NULL
    `).run(
      conv.id,
      conv.provider,
      conv.model,
      conv.effort,
      conv.fastMode ? 1 : 0,
      conv.createdAt,
      conv.updatedAt,
      conv.lastContextTokens,
      conv.marked ? 1 : 0,
      conv.pinned ? 1 : 0,
      conv.muted ? 1 : 0,
      conv.sortOrder,
      conv.folderId ?? null,
      conv.title,
      optionalJson(conv.goal?.status === "complete" ? null : conv.goal),
      conv.subagentMaxDepth ?? null,
      optionalJson(conv.subagentPolicy),
      optionalJson(conv.toolPolicy),
      generation,
      summary.messageCount,
      conv.messages.length,
    );
  }

  private saveActiveContext(conv: Conversation): void {
    this.db.query("DELETE FROM active_contexts WHERE conversation_id=?").run(conv.id);
    const active = conv.activeContext;
    if (!active) return;
    this.db.query(`
      INSERT INTO active_contexts(
        conversation_id, kind, provider, model, transcript_history_count,
        transcript_prefix_hash, compaction_history_count, compaction_prefix_hash,
        window_id, window_number, compacted_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conv.id,
      active.kind,
      active.provider,
      active.model,
      active.transcriptHistoryCount,
      active.transcriptPrefixHash,
      active.compactionHistoryCount ?? null,
      active.compactionPrefixHash ?? null,
      active.windowId,
      active.windowNumber,
      active.compactedAt,
      JSON.stringify(active),
    );
  }

  private firstChangedMessage(conv: Conversation, forceMessages: boolean): number | null {
    const state = this.loadedState.get(conv);
    if (!state) return 0;
    const common = Math.min(state.messages.length, conv.messages.length);
    if (forceMessages) {
      const rows = this.db.query<{ sequence: number; message_hash: string }, [string]>(
        "SELECT sequence, message_hash FROM messages WHERE conversation_id=? ORDER BY sequence",
      ).all(conv.id);
      for (let i = 0; i < common; i++) {
        if (rows[i]?.sequence !== i || rows[i].message_hash !== messageFingerprint(conv.messages[i])) return i;
      }
    } else {
      for (let i = 0; i < common; i++) {
        if (messageShallowChanged(state.messages[i], conv.messages[i])) return i;
      }
    }
    return state.messages.length === conv.messages.length ? null : common;
  }

  private rebuildDisplay(
    conv: Conversation,
    changedAt: number,
    options: { validatedUnwind?: boolean } = {},
  ): void {
    // Rebuild only from the last affected real user turn. Starting at a user
    // boundary keeps assistant/tool-result grouping deterministic.
    let startSequence = 0;
    for (let i = Math.min(changedAt, conv.messages.length - 1); i >= 0; i--) {
      if (isRealUserMessage(conv.messages[i])) {
        startSequence = i;
        break;
      }
    }
    if (startSequence > 0 && conv.messages.slice(0, startSequence).some((message) => message.role === "system_instructions" && changedAt <= startSequence)) {
      startSequence = 0;
    }
    const userOffset = conv.messages.slice(0, startSequence).filter(isRealUserMessage).length;
    const replayOffset = conv.messages.slice(0, startSequence).filter(isReplayHistoryMessage).length;
    let entryStart = 0;
    if (startSequence > 0) {
      const found = this.db.query<{ entry_index: number }, [string, number]>(`
        SELECT entry_index FROM display_entries
        WHERE conversation_id=? AND pinned=0 AND user_index=? LIMIT 1
      `).get(conv.id, userOffset);
      entryStart = found?.entry_index ?? this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM display_entries WHERE conversation_id=? AND pinned=0",
      ).get(conv.id)!.count;
      this.db.query("DELETE FROM display_entries WHERE conversation_id=? AND pinned=0 AND entry_index>=?").run(conv.id, entryStart);
    } else {
      this.db.query("DELETE FROM display_entries WHERE conversation_id=?").run(conv.id);
    }

    const suffix = conv.messages.slice(startSequence);
    const data = buildDisplayData(
      conv.id,
      conv.provider,
      conv.model,
      conv.effort,
      conv.fastMode,
      suffix,
      conv.lastContextTokens,
      summarizeTool,
      {
        includeToolOutputs: false,
        includeUnwindFingerprints: false,
        replayHistoryPrefixCount: replayOffset,
        editableUserHistoryStart: options.validatedUnwind
          ? validatedUnwindEditableHistoryStart(conv)
          : projectedEditableHistoryStart(conv),
      },
    );
    const realUsers = suffix.filter(isRealUserMessage);
    let localUser = 0;
    let historyIndex = entryStart;
    let pinnedIndex = startSequence === 0 ? 0 : this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM display_entries WHERE conversation_id=? AND pinned=1",
    ).get(conv.id)!.count;
    for (const rawEntry of data.entries) {
      let entry: any = rawEntry;
      let userIndex: number | null = null;
      if (entry.type === "user") {
        userIndex = userOffset + localUser;
        const source = realUsers[localUser++];
        if (!source) throw new Error(`Display/user mismatch while indexing ${conv.id}`);
        entry = { ...entry, unwindFingerprint: pagedUserFingerprint(conv.id, userIndex, source) };
      }
      const pinned = entry.type === "system_instructions" ? 1 : 0;
      const index = pinned ? pinnedIndex++ : historyIndex++;
      this.db.query(`
        INSERT INTO display_entries(conversation_id, pinned, entry_index, user_index, type, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(conv.id, pinned, index, userIndex, entry.type, JSON.stringify(entry));
    }
    if (localUser !== realUsers.length) throw new Error(`Display/user mismatch while indexing ${conv.id}: ${localUser}/${realUsers.length}`);
    const displayCount = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM display_entries WHERE conversation_id=? AND pinned=0",
    ).get(conv.id)!.count;
    this.db.query("UPDATE conversations SET display_entry_count=? WHERE id=?").run(displayCount, conv.id);
  }

  save(conv: Conversation, options: { forceMessages?: boolean; generation?: number } = {}): void {
    assertSafeId(conv.id);
    const existing = this.row(conv.id, true);
    const loaded = this.loadedState.get(conv);
    if (existing && loaded && existing.storage_generation !== loaded.generation) {
      throw new Error(`Stale conversation generation for ${conv.id}: loaded=${loaded.generation}, current=${existing.storage_generation}`);
    }
    const generation = options.generation ?? ((existing?.storage_generation ?? 0) + 1);
    const changedAt = this.firstChangedMessage(conv, options.forceMessages === true);
    this.db.transaction(() => {
      this.upsertConversationRow(conv, generation);
      this.faultInjection?.("save.after-conversation");
      if (changedAt !== null) {
        const removedBytes = existing && changedAt < existing.stored_message_count
          ? this.db.query<{ bytes: number }, [string, number]>(`
              SELECT COALESCE(SUM(content_bytes), 0) AS bytes FROM messages
              WHERE conversation_id=? AND sequence>=?
            `).get(conv.id, changedAt)!.bytes
          : 0;
        this.db.query("DELETE FROM messages WHERE conversation_id=? AND sequence>=?").run(conv.id, changedAt);
        let insertedBytes = 0;
        for (let sequence = changedAt; sequence < conv.messages.length; sequence++) {
          insertedBytes += this.insertMessage(conv.id, sequence, conv.messages[sequence]);
        }
        this.faultInjection?.("save.after-messages");
        this.rebuildDisplay(conv, changedAt);
        this.db.query("UPDATE conversations SET content_bytes=? WHERE id=?")
          .run((existing?.content_bytes ?? 0) - removedBytes + insertedBytes, conv.id);
        this.faultInjection?.("save.after-display");
      }
      if (!existing || loaded?.activeContextRef !== conv.activeContext) this.saveActiveContext(conv);
      this.faultInjection?.("save.before-commit");
    })();
    const previousReceipt = loaded?.lastUnwindReceipt ?? null;
    this.loadedState.set(conv, {
      generation,
      messages: conv.messages.map(messageSnapshot),
      activeContextRef: conv.activeContext,
      lastUnwindReceipt: previousReceipt,
    });
    this.loadedById.set(conv.id, new WeakRef(conv));
  }

  saveContextAttribution(conv: Conversation): void {
    const existing = this.row(conv.id);
    const loaded = this.loadedState.get(conv);
    if (!existing) return this.save(conv);
    if (loaded && loaded.generation !== existing.storage_generation) throw new Error(`Stale conversation generation for ${conv.id}`);
    const generation = existing.storage_generation + 1;
    this.db.transaction(() => {
      for (let sequence = 0; sequence < conv.messages.length; sequence++) {
        const message = conv.messages[sequence];
        this.db.query("UPDATE messages SET context_tokens_json=?, has_context_tokens=? WHERE conversation_id=? AND sequence=?")
          .run(optionalJson(message.contextTokens), Object.hasOwn(message, "contextTokens") ? 1 : 0, conv.id, sequence);
      }
      this.upsertConversationRow(conv, generation);
      if (loaded?.activeContextRef !== conv.activeContext) this.saveActiveContext(conv);
    })();
    this.loadedState.set(conv, { generation, messages: conv.messages.map(messageSnapshot), activeContextRef: conv.activeContext, lastUnwindReceipt: loaded?.lastUnwindReceipt ?? null });
    this.loadedById.set(conv.id, new WeakRef(conv));
  }

  getLastUnwindReceipt(conv: Conversation): PersistedUnwindReceipt | null {
    const receipt = this.loadedState.get(conv)?.lastUnwindReceipt;
    if (receipt) return { ...receipt };
    const row = this.db.query<{ operation_id: string; user_message_index: number; history_total_entries: number }, [string]>(`
      SELECT operation_id, user_message_index, history_total_entries FROM unwind_receipts WHERE conversation_id=?
    `).get(conv.id);
    return row ? { operationId: row.operation_id, userMessageIndex: row.user_message_index, historyTotalEntries: row.history_total_entries } : null;
  }

  saveUnwind(base: Conversation, result: Conversation, _targetHistoryCount: number, options: SaveUnwindOptions): void {
    if (base.id !== result.id) throw new Error("Unwind result conversation ID mismatch");
    const existing = this.row(base.id);
    const loaded = this.loadedState.get(base);
    if (!existing) throw new Error(`Cannot persist unwind for missing conversation ${base.id}`);
    if (!loaded) throw new Error(`Cannot persist unwind for unloaded conversation ${base.id}`);
    if (loaded.generation !== existing.storage_generation) throw new Error(`Stale conversation generation for ${base.id}`);
    const cutSequence = result.messages.length;
    if (cutSequence > existing.stored_message_count || cutSequence > base.messages.length) {
      throw new Error(`Invalid unwind boundary for ${base.id}: ${cutSequence}/${existing.stored_message_count}`);
    }
    // A targeted unwind may only remove a suffix. Prefix replacement belongs to
    // the ordinary generation-checked save path and must not be smuggled into this
    // optimized delete-only transaction.
    const contextAttributionUpdates: number[] = [];
    for (let sequence = 0; sequence < cutSequence; sequence++) {
      const snapshot = loaded.messages[sequence];
      if (result.messages[sequence] !== base.messages[sequence]
          || !snapshot
          || messageChangedExceptContextAttribution(snapshot, result.messages[sequence])) {
        throw new Error(`Unwind changed retained message ${sequence} for ${base.id}`);
      }
      if (messageContextAttributionChanged(snapshot, result.messages[sequence])) {
        contextAttributionUpdates.push(sequence);
      }
    }
    const generation = existing.storage_generation + 1;
    const receipt: PersistedUnwindReceipt = {
      operationId: options.operationId,
      userMessageIndex: options.userMessageIndex,
      historyTotalEntries: options.historyTotalEntries,
    };
    this.db.transaction(() => {
      const removedBytes = this.db.query<{ bytes: number }, [string, number]>(`
        SELECT COALESCE(SUM(content_bytes), 0) AS bytes FROM messages
        WHERE conversation_id=? AND sequence>=?
      `).get(base.id, cutSequence)!.bytes;
      if (!Number.isSafeInteger(removedBytes) || removedBytes < 0 || removedBytes > existing.content_bytes) {
        throw new Error(`Invalid removed content byte count for ${base.id}: ${removedBytes}/${existing.content_bytes}`);
      }
      this.upsertConversationRow(result, generation);
      this.faultInjection?.("unwind.after-conversation");
      // Messages are gap-free and every dependent payload table cascades from
      // this key. Preserve the immutable prefix and delete only the doomed tail.
      this.db.query("DELETE FROM messages WHERE conversation_id=? AND sequence>=?").run(base.id, cutSequence);
      for (const sequence of contextAttributionUpdates) {
        const message = result.messages[sequence];
        // Match saveContextAttribution(): this field-level update deliberately
        // avoids reserializing large tool/image content merely to refresh the
        // force-save fingerprint.
        this.db.query(`
          UPDATE messages SET context_tokens_json=?, has_context_tokens=?
          WHERE conversation_id=? AND sequence=?
        `).run(
          optionalJson(message.contextTokens),
          Object.hasOwn(message, "contextTokens") ? 1 : 0,
          base.id,
          sequence,
        );
      }
      this.faultInjection?.("unwind.after-messages");
      this.rebuildDisplay(result, cutSequence, { validatedUnwind: true });
      // The domain-calculated count excludes non-visible/system/tool-receipt
      // messages. Preserve exactly the same unwind summary semantics as JSON.
      this.db.query("UPDATE conversations SET content_bytes=?, message_count=? WHERE id=?")
        .run(existing.content_bytes - removedBytes, options.messageCount, base.id);
      // An unwind beyond a lagging compact replay cursor leaves that immutable
      // checkpoint byte-for-byte unchanged; avoid rewriting its potentially large
      // payload. A rewind inside represented tail history installs a new object.
      if (result.activeContext !== base.activeContext) this.saveActiveContext(result);
      this.db.query(`
        INSERT INTO unwind_receipts(conversation_id, operation_id, user_message_index, history_total_entries, superseded_queue_ids_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          operation_id=excluded.operation_id,
          user_message_index=excluded.user_message_index,
          history_total_entries=excluded.history_total_entries,
          superseded_queue_ids_json=excluded.superseded_queue_ids_json
      `).run(base.id, options.operationId, options.userMessageIndex, options.historyTotalEntries, JSON.stringify(options.supersededQueueIds));
      if (options.supersededQueueIds.length > 0) {
        this.db.query(`DELETE FROM queued_messages WHERE id IN (${sqlPlaceholders(options.supersededQueueIds.length)})`).run(...options.supersededQueueIds);
      }
      this.faultInjection?.("unwind.before-commit");
    })();
    this.loadedState.set(base, {
      generation,
      messages: loaded.messages.slice(0, cutSequence),
      activeContextRef: result.activeContext,
      lastUnwindReceipt: receipt,
    });
    const savedSnapshots = this.loadedState.get(base)!.messages;
    for (const sequence of contextAttributionUpdates) {
      savedSnapshots[sequence] = messageSnapshot(result.messages[sequence]);
    }
    this.loadedById.set(base.id, new WeakRef(base));
  }

  displayEntryCountBeforeUser(id: string, userMessageIndex: number): number | null {
    const row = this.db.query<{ entry_index: number }, [string, number]>(`
      SELECT entry_index FROM display_entries
      WHERE conversation_id=? AND pinned=0 AND user_index=?
      LIMIT 1
    `).get(id, userMessageIndex);
    return row?.entry_index ?? null;
  }

  loadUnwindQueueTombstones(): Set<string> {
    const rows = this.db.query<{ superseded_queue_ids_json: string }, []>("SELECT superseded_queue_ids_json FROM unwind_receipts").all();
    return new Set(rows.flatMap((row) => JSON.parse(row.superseded_queue_ids_json) as string[]));
  }

  acknowledgeRecoveredUnwindQueueCleanup(): void {
    this.db.query("UPDATE unwind_receipts SET superseded_queue_ids_json='[]'").run();
  }

  acknowledgeUnwindQueueCleanup(id: string, operationId: string): void {
    this.db.query("UPDATE unwind_receipts SET superseded_queue_ids_json='[]' WHERE conversation_id=? AND operation_id=?").run(id, operationId);
  }

  removeConversationUnwindReceipt(id: string): void {
    this.db.query("DELETE FROM unwind_receipts WHERE conversation_id=?").run(id);
  }

  hasConversationUnwindReceipt(id: string): boolean {
    return this.db.query<{ ok: number }, [string]>("SELECT 1 AS ok FROM unwind_receipts WHERE conversation_id=?").get(id) != null;
  }

  saveConversationSidebarState(state: ConversationSidebarState): void {
    const row = this.row(state.id);
    if (!row) throw new Error(`Conversation not found: ${state.id}`);
    this.db.query(`
      UPDATE conversations SET folder_id=?, pinned=?, sort_order=?, storage_generation=storage_generation+1
      WHERE id=? AND deleted_at IS NULL
    `).run(state.folderId, state.pinned ? 1 : 0, state.sortOrder, state.id);
    const loaded = this.loadedById.get(state.id)?.deref();
    if (loaded) {
      const loadedState = this.loadedState.get(loaded);
      if (loadedState) loadedState.generation = row.storage_generation + 1;
    }
  }

  hasConversationSidebarState(_id: string): boolean {
    // SQLite applies targeted sidebar updates directly in the canonical row;
    // there is never a pending overlay to materialize before another mutation.
    return false;
  }

  loadFolders(): PersistedFolderSummary[] {
    return this.db.query<{
      id: string; name: string; parent_id: string | null; created_at: number; updated_at: number; pinned: number; muted: number; sort_order: number;
    }, []>("SELECT * FROM folders ORDER BY pinned DESC, sort_order, id").all().map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pinned: row.pinned === 1,
      muted: row.muted === 1,
      sortOrder: row.sort_order,
    }));
  }

  saveFolders(folders: PersistedFolderSummary[]): void {
    const normalized = folders.map(normalizeFolder);
    this.db.transaction(() => {
      const ids = new Set(normalized.map((folder) => folder.id));
      for (const folder of normalized) {
        this.db.query(`
          INSERT INTO folders(id, name, parent_id, created_at, updated_at, pinned, muted, sort_order)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, created_at=excluded.created_at,
            updated_at=excluded.updated_at, pinned=excluded.pinned, muted=excluded.muted, sort_order=excluded.sort_order
        `).run(folder.id, folder.name, folder.createdAt, folder.updatedAt, folder.pinned ? 1 : 0, folder.muted ? 1 : 0, folder.sortOrder);
      }
      for (const folder of normalized) {
        this.db.query("UPDATE folders SET parent_id=? WHERE id=?").run(folder.parentId && ids.has(folder.parentId) ? folder.parentId : null, folder.id);
      }
      const existing = this.db.query<{ id: string }, []>("SELECT id FROM folders").all();
      for (const row of existing) if (!ids.has(row.id)) this.db.query("DELETE FROM folders WHERE id=?").run(row.id);
    })();
  }

  loadFolderInstructions(): Map<string, string> {
    return new Map(this.db.query<{ folder_id: string; text: string }, []>("SELECT folder_id, text FROM folder_instructions").all().map((row) => [row.folder_id, row.text]));
  }

  saveFolderInstructions(instructions: Map<string, string>): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM folder_instructions").run();
      for (const [folderId, text] of instructions) {
        if (text.length > 0 && this.db.query("SELECT 1 FROM folders WHERE id=?").get(folderId)) {
          this.db.query("INSERT INTO folder_instructions(folder_id, text) VALUES (?, ?)").run(folderId, text);
        }
      }
    })();
  }

  loadUnreadConversationIds(): string[] {
    return this.db.query<{ conversation_id: string }, []>(`
      SELECT u.conversation_id FROM unread_conversations u
      JOIN conversations c ON c.id=u.conversation_id
      WHERE c.deleted_at IS NULL ORDER BY u.marked_at, u.conversation_id
    `).all().map((row) => row.conversation_id);
  }

  saveUnreadConversationIds(ids: Iterable<string>): void {
    const unique = [...new Set(ids)];
    this.db.transaction(() => {
      this.db.query("DELETE FROM unread_conversations").run();
      let markedAt = Date.now();
      for (const id of unique) if (this.has(id)) this.db.query("INSERT INTO unread_conversations(conversation_id, marked_at) VALUES (?, ?)").run(id, markedAt++);
    })();
  }

  loadQueuedMessages(): PersistedQueuedMessage[] {
    return this.db.query<{ payload_json: string }, []>("SELECT payload_json FROM queued_messages ORDER BY position, id").all().map((row) => JSON.parse(row.payload_json));
  }

  saveQueuedMessages(messages: PersistedQueuedMessage[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM queued_messages").run();
      messages.forEach((message, position) => {
        this.db.query(`
          INSERT INTO queued_messages(id, conversation_id, position, timing, source, created_at, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(message.id, message.convId, position, message.timing, message.source, message.createdAt, JSON.stringify(message));
      });
    })();
  }

  loadConversationBtwState(): ConversationBtwPersistenceState {
    const btws = new Map<string, ConversationBtw>();
    for (const row of this.db.query<{ conversation_id: string; payload_json: string }, []>("SELECT conversation_id, payload_json FROM btw_sessions").all()) {
      btws.set(row.conversation_id, JSON.parse(row.payload_json));
    }
    const seenSessionIds = new Map<string, Set<string>>();
    for (const row of this.db.query<{ conversation_id: string; session_id: string }, []>("SELECT conversation_id, session_id FROM btw_receipts").all()) {
      const ids = seenSessionIds.get(row.conversation_id) ?? new Set<string>();
      ids.add(row.session_id);
      seenSessionIds.set(row.conversation_id, ids);
    }
    return { btws, seenSessionIds };
  }

  saveConversationBtwState(state: ConversationBtwPersistenceState): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM btw_sessions").run();
      this.db.query("DELETE FROM btw_receipts").run();
      for (const [id, btw] of state.btws) this.db.query("INSERT INTO btw_sessions(conversation_id, payload_json) VALUES (?, ?)").run(id, JSON.stringify(btw));
      for (const [id, receipts] of state.seenSessionIds) for (const receipt of receipts) this.db.query("INSERT INTO btw_receipts(conversation_id, session_id) VALUES (?, ?)").run(id, receipt);
    })();
  }

  private readStack(stack: "undo" | "redo"): TrashStackEntry[] {
    return this.db.query<{ entry_json: string }, [string]>("SELECT entry_json FROM sidebar_history WHERE stack=? ORDER BY position").all(stack).map((row) => JSON.parse(row.entry_json));
  }

  private writeStack(stack: "undo" | "redo", entries: TrashStackEntry[]): void {
    this.db.query("DELETE FROM sidebar_history WHERE stack=?").run(stack);
    entries.forEach((entry, position) => this.db.query("INSERT INTO sidebar_history(stack, position, entry_json) VALUES (?, ?, ?)").run(stack, position, JSON.stringify(entry)));
  }

  pushTrashEntry(entry: TrashStackEntry): void {
    this.db.transaction(() => {
      const undo = this.readStack("undo");
      undo.push(entry);
      this.writeStack("undo", undo);
      this.writeStack("redo", []);
    })();
  }

  pushUndoEntry(entry: TrashStackEntry): void {
    this.db.transaction(() => { const entries = this.readStack("undo"); entries.push(entry); this.writeStack("undo", entries); })();
  }

  pushRedoEntry(entry: TrashStackEntry): void {
    this.db.transaction(() => { const entries = this.readStack("redo"); entries.push(entry); this.writeStack("redo", entries); })();
  }

  popUndoEntry(): TrashStackEntry | null {
    return this.db.transaction(() => { const entries = this.readStack("undo"); const entry = entries.pop() ?? null; this.writeStack("undo", entries); return entry; })();
  }

  popRedoEntry(): TrashStackEntry | null {
    return this.db.transaction(() => { const entries = this.readStack("redo"); const entry = entries.pop() ?? null; this.writeStack("redo", entries); return entry; })();
  }

  trashConversations(ids: string[], recordUndo = true): string[] {
    const unique = [...new Set(ids)].filter((id) => this.has(id));
    if (unique.length === 0) return [];
    this.db.transaction(() => {
      const now = Date.now();
      for (const id of unique) {
        this.db.query("UPDATE conversations SET deleted_at=?, storage_generation=storage_generation+1 WHERE id=? AND deleted_at IS NULL").run(now, id);
        this.db.query("DELETE FROM btw_sessions WHERE conversation_id=?").run(id);
        this.db.query("DELETE FROM btw_receipts WHERE conversation_id=?").run(id);
        this.db.query("DELETE FROM unread_conversations WHERE conversation_id=?").run(id);
      }
      this.faultInjection?.("delete.after-conversations");
      if (recordUndo) {
        const undo = this.readStack("undo");
        undo.push(unique.length === 1 ? { type: "conversation", id: unique[0] } : { type: "conversations", ids: unique });
        this.writeStack("undo", undo);
        this.writeStack("redo", []);
      }
      this.faultInjection?.("delete.before-commit");
    })();
    return unique;
  }

  trashFolderRecursive(entry: Extract<TrashStackEntry, { type: "folder_recursive" }>, recordUndo = true): boolean {
    const existing = entry.conversationIds.filter((id) => this.has(id));
    if (existing.length !== entry.conversationIds.length) return false;
    this.db.transaction(() => {
      const now = Date.now();
      for (const id of existing) {
        this.db.query("UPDATE conversations SET deleted_at=?, storage_generation=storage_generation+1 WHERE id=?").run(now, id);
        this.db.query("DELETE FROM btw_sessions WHERE conversation_id=?").run(id);
        this.db.query("DELETE FROM btw_receipts WHERE conversation_id=?").run(id);
        this.db.query("DELETE FROM unread_conversations WHERE conversation_id=?").run(id);
      }
      if (recordUndo) {
        const undo = this.readStack("undo");
        undo.push(entry);
        this.writeStack("undo", undo);
        this.writeStack("redo", []);
      }
    })();
    return true;
  }

  restoreConversationsFromTrash(ids: string[]): Conversation[] {
    const restored: Conversation[] = [];
    this.db.transaction(() => {
      for (const id of ids) {
        const row = this.row(id, true);
        if (!row || row.deleted_at === null) continue;
        this.db.query("UPDATE conversations SET deleted_at=NULL, storage_generation=storage_generation+1 WHERE id=?").run(id);
      }
    })();
    for (const id of ids) {
      const conv = this.load(id);
      if (conv) restored.push(conv);
    }
    return restored;
  }

  loadToolOutputs(id: string): ToolOutputInfo[] | null {
    if (!this.has(id)) return null;
    return this.db.query<{ tool_call_id: string; content_json: string; payload_json: string | null }, [string]>(`
      SELECT t.tool_call_id, m.content_json, b.payload_json FROM tool_outputs t
      JOIN messages m ON m.conversation_id=t.conversation_id AND m.sequence=t.message_sequence
      LEFT JOIN message_blobs b ON b.conversation_id=t.conversation_id
        AND b.message_sequence=t.message_sequence AND b.kind='tool_result' AND b.ordinal=t.ordinal
      WHERE t.conversation_id=? ORDER BY t.message_sequence, t.ordinal
    `).all(id).map((row) => {
      let raw: unknown;
      if (row.payload_json != null) {
        raw = (JSON.parse(row.payload_json) as { value: unknown }).value;
      } else {
        // Schema <=5 rows retain the complete content inline.
        const content = JSON.parse(row.content_json);
        const part = Array.isArray(content)
          ? content.find((candidate: any) => candidate?.type === "tool_result" && candidate.tool_use_id === row.tool_call_id)
          : null;
        raw = part?.content;
      }
      const output = typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.filter((item: any) => item?.type === "text").map((item: any) => item.text ?? "").join("\n")
          : String(raw ?? "");
      return { toolCallId: row.tool_call_id, output };
    });
  }

  loadDisplayPage(id: string, turns: number, beforeEntryIndex?: number): StoredDisplayHistoryPage | null {
    const row = this.row(id);
    if (!row) return null;
    const total = row.display_entry_count;
    const endIndex = Math.max(0, Math.min(beforeEntryIndex === undefined ? total : Math.floor(beforeEntryIndex), total));
    const usersBeforeEnd = this.db.query<{ count: number }, [string, number]>(`
      SELECT COUNT(*) AS count FROM display_entries
      WHERE conversation_id=? AND pinned=0 AND type='user' AND entry_index<?
    `).get(id, endIndex)!.count;
    const safeTurns = Math.max(1, Math.floor(Number.isFinite(turns) ? turns : 1));
    const startUserIndex = Math.max(0, usersBeforeEnd - safeTurns);
    const startIndex = usersBeforeEnd > 0
      ? this.db.query<{ entry_index: number }, [string, number]>(`
          SELECT entry_index FROM display_entries WHERE conversation_id=? AND pinned=0 AND user_index=? LIMIT 1
        `).get(id, startUserIndex)?.entry_index ?? 0
      : 0;
    const pinnedEntries = this.db.query<{ payload_json: string }, [string]>(`
      SELECT payload_json FROM display_entries WHERE conversation_id=? AND pinned=1 ORDER BY entry_index
    `).all(id).map((entry) => JSON.parse(entry.payload_json));
    const entries = this.db.query<{ entry_index: number; payload_json: string }, [string, number, number]>(`
      SELECT entry_index, payload_json FROM display_entries
      WHERE conversation_id=? AND pinned=0 AND entry_index>=? AND entry_index<? ORDER BY entry_index
    `).all(id, startIndex, endIndex).map((entry) => compactOldImages(JSON.parse(entry.payload_json), entry.entry_index, total));
    return {
      convId: id,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      fastMode: row.fast_mode === 1,
      contextTokens: row.last_context_tokens,
      toolOutputsIncluded: false,
      pinnedEntries,
      entries,
      startIndex,
      startUserIndex,
      endIndex,
      totalEntries: total,
      hasOlder: startIndex > 0,
      source: {
        baseSize: this.getConversationFileStat(id).fileSize,
        baseMtimeMs: row.updated_at,
        baseCtimeMs: row.updated_at,
        unwindSize: null,
        unwindMtimeMs: null,
        unwindHash: null,
      },
      storedMessageCount: row.stored_message_count,
    };
  }

  searchTitles(query: string, limit = 50): PersistedConversationSummary[] {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
    return this.db.query<ConversationRow, [string, number]>(`
      SELECT c.* FROM conversation_title_fts f
      JOIN conversations c ON c.id=f.conversation_id
      WHERE conversation_title_fts MATCH ? AND c.deleted_at IS NULL
      ORDER BY c.updated_at DESC LIMIT ?
    `).all(ftsQuery, Math.max(1, Math.floor(limit))).map((row) => this.summaryFromRow(row));
  }

  exportConversation(id: string, includeDeleted = false): Record<string, unknown> | null {
    const conv = this.load(id, includeDeleted);
    if (!conv) return null;
    const generation = this.row(id, includeDeleted)!.storage_generation;
    return {
      version: 20,
      id: conv.id,
      provider: conv.provider,
      model: conv.model,
      effort: conv.effort,
      fastMode: conv.fastMode,
      messages: conv.messages,
      activeContext: conv.activeContext ?? null,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      lastContextTokens: conv.lastContextTokens,
      marked: conv.marked,
      pinned: conv.pinned,
      muted: conv.muted === true,
      sortOrder: conv.sortOrder,
      folderId: conv.folderId ?? null,
      title: conv.title,
      goal: conv.goal ?? null,
      subagentMaxDepth: conv.subagentMaxDepth ?? null,
      subagentPolicy: conv.subagentPolicy ?? null,
      toolPolicy: conv.toolPolicy ?? null,
      storageGeneration: generation,
      lastUnwindReceipt: this.getLastUnwindReceipt(conv),
    };
  }

  exportAll(destination: string): ExportManifest {
    const dest = resolve(destination);
    if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`Export destination must be absent or empty: ${dest}`);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    const convDir = join(dest, "conversations");
    mkdirSync(convDir, { recursive: true, mode: 0o700 });
    const deletedDir = join(dest, "trash");
    mkdirSync(deletedDir, { recursive: true, mode: 0o700 });
    const manifest: ExportManifest = { version: 1, exportedAt: Date.now(), conversations: [], files: {} };
    for (const summary of this.listSummaries()) {
      const value = this.exportConversation(summary.id)!;
      const body = JSON.stringify(value, null, 2);
      writeFileSync(join(convDir, `${summary.id}.json`), body, { mode: 0o600 });
      manifest.conversations.push({ id: summary.id, sha256: sha256(body), bytes: Buffer.byteLength(body) });
    }
    const deletedIds = this.db.query<{ id: string }, []>(
      "SELECT id FROM conversations WHERE deleted_at IS NOT NULL ORDER BY id",
    ).all().map((row) => row.id);
    for (const id of deletedIds) {
      const value = this.exportConversation(id, true)!;
      const body = JSON.stringify(value, null, 2);
      writeFileSync(join(deletedDir, `${id}.json`), body, { mode: 0o600 });
      manifest.conversations.push({ id, sha256: sha256(body), bytes: Buffer.byteLength(body), deleted: true });
    }
    const auxiliary: Record<string, unknown> = {
      "folders.json": { version: 1, folders: this.loadFolders() },
      "folder-instructions.json": { version: 1, instructions: Object.fromEntries(this.loadFolderInstructions()) },
      "unread.json": { version: 1, conversationIds: this.loadUnreadConversationIds() },
      "message-queue.json": { version: 1, messages: this.loadQueuedMessages() },
      "btw.json": {
        version: 2,
        conversations: Object.fromEntries(this.loadConversationBtwState().btws),
        seenSessionIds: Object.fromEntries([...this.loadConversationBtwState().seenSessionIds].map(([id, ids]) => [id, [...ids]])),
      },
      "trash/trash.json": this.readStack("undo"),
      "trash/redo.json": this.readStack("redo"),
    };
    for (const [name, value] of Object.entries(auxiliary)) {
      const body = JSON.stringify(value, null, 2);
      writeFileSync(join(dest, name), body, { mode: 0o600 });
      manifest.files[name] = sha256(body);
    }
    writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  }

  importLegacyIfNeeded(): LegacyImportReport {
    const startedAt = Date.now();
    if (this.metadata("legacy_import_complete") === "1") {
      return { status: "not-needed", discovered: 0, imported: 0, reused: 0, skipped: [], startedAt, completedAt: Date.now() };
    }
    const liveDir = conversationsDir();
    const liveSources = (existsSync(liveDir) ? readdirSync(liveDir) : [])
      .filter((name) => name.endsWith(".json"))
      .map((filename) => ({
        id: filename.slice(0, -5),
        path: join(liveDir, filename),
        deleted: false,
      }));
    const deletedSources = legacy.listTrashedConversationIds().map((id) => ({
      id,
      path: join(trashDir(), `${id}.json`),
      deleted: true,
    }));
    const sources = [...liveSources, ...deletedSources]
      .sort((a, b) => a.id.localeCompare(b.id) || Number(a.deleted) - Number(b.deleted));
    const sourceCounts = new Map<string, number>();
    for (const source of sources) sourceCounts.set(source.id, (sourceCounts.get(source.id) ?? 0) + 1);
    const duplicateIds = new Set([...sourceCounts].filter(([, count]) => count > 1).map(([id]) => id));

    let imported = 0;
    let reused = 0;
    const skipped: Array<{ id: string; error: string }> = [...duplicateIds].map((id) => ({
      id,
      error: "conversation exists in both live and trash legacy directories",
    }));
    let lastProgressAt = startedAt;
    log("info", `sqlite import: starting ${sources.length} legacy conversation(s) (${liveSources.length} live, ${deletedSources.length} deleted)`);
    try {
      this.saveFolders(legacy.loadFolders());
      this.saveFolderInstructions(legacy.loadFolderInstructions());
    } catch (error) {
      return { status: "incomplete", discovered: sources.length, imported, reused, skipped: [...skipped, { id: "<folders>", error: String(error) }], startedAt, completedAt: Date.now() };
    }

    for (let index = 0; index < sources.length; index++) {
      const sourceInfo = sources[index];
      const { id, path, deleted } = sourceInfo;
      if (duplicateIds.has(id)) continue;
      try {
        const statBefore = statSync(path);
        const source = readFileSync(path);
        const hash = sha256(source);
        const prior = this.db.query<{ source_sha256: string }, [string]>("SELECT source_sha256 FROM import_sources WHERE conversation_id=?").get(id);
        const priorRow = this.row(id, true);
        if (prior?.source_sha256 === hash && priorRow && (priorRow.deleted_at !== null) === deleted) {
          reused++;
        } else {
          const conv = deleted ? legacy.loadTrashedConversation(id) : legacy.load(id);
          if (!conv) throw new Error("legacy loader rejected the conversation");
          const entry = legacy.indexEntryFromConversation(conv);
          const receipt = legacy.getLastUnwindReceipt(conv);
          const statAfter = statSync(path);
          if (statBefore.size !== statAfter.size || statBefore.mtimeMs !== statAfter.mtimeMs) throw new Error("source changed during stable read");
          this.db.transaction(() => {
            this.save(conv, { forceMessages: true, generation: Math.max(1, entry.storageGeneration) });
            this.db.query("DELETE FROM unwind_receipts WHERE conversation_id=?").run(id);
            if (receipt) {
              this.db.query(`
                INSERT INTO unwind_receipts(
                  conversation_id, operation_id, user_message_index,
                  history_total_entries, superseded_queue_ids_json
                ) VALUES (?, ?, ?, ?, '[]')
              `).run(id, receipt.operationId, receipt.userMessageIndex, receipt.historyTotalEntries);
            }
            if (deleted) {
              this.db.query("UPDATE conversations SET deleted_at=? WHERE id=?").run(startedAt, id);
              this.db.query("DELETE FROM unread_conversations WHERE conversation_id=?").run(id);
              this.db.query("DELETE FROM btw_sessions WHERE conversation_id=?").run(id);
              this.db.query("DELETE FROM btw_receipts WHERE conversation_id=?").run(id);
            }
            this.db.query(`
              INSERT INTO import_sources(conversation_id, source_size, source_mtime_ms, source_generation, source_sha256, imported_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(conversation_id) DO UPDATE SET source_size=excluded.source_size,
                source_mtime_ms=excluded.source_mtime_ms, source_generation=excluded.source_generation,
                source_sha256=excluded.source_sha256, imported_at=excluded.imported_at
            `).run(id, statBefore.size, statBefore.mtimeMs, entry.storageGeneration, hash, Date.now());
          })();
          imported++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push({ id, error: message });
        log("error", `sqlite import: skipped ${id}: ${message}`);
      }
      const now = Date.now();
      if (index + 1 === sources.length || (index + 1) % 100 === 0 || now - lastProgressAt >= 2_000) {
        log("info", `sqlite import: ${index + 1}/${sources.length} source(s), ${imported} imported, ${reused} reused, ${skipped.length} skipped`);
        lastProgressAt = now;
      }
    }

    if (skipped.length === 0) {
      try {
        this.db.transaction(() => {
          this.saveUnreadConversationIds(legacy.loadUnreadConversationIds());
          this.saveQueuedMessages(legacy.loadQueuedMessages());
          this.saveConversationBtwState(legacy.loadConversationBtwState());
          this.writeStack("undo", legacy.loadTrashStackSnapshot());
          this.writeStack("redo", legacy.loadRedoStackSnapshot());
        })();
      } catch (error) {
        skipped.push({ id: "<auxiliary>", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const status = skipped.length === 0 ? "complete" : "incomplete";
    if (status === "complete") {
      this.setMetadata("legacy_import_complete", "1");
      this.setMetadata("canonical_backend", "sqlite");
    }
    const report = { status, discovered: sources.length, imported, reused, skipped, startedAt, completedAt: Date.now() } satisfies LegacyImportReport;
    this.setMetadata("legacy_import_report", JSON.stringify(report));
    log(status === "complete" ? "info" : "error", `sqlite import: ${status} in ${report.completedAt - startedAt} ms (${imported} imported, ${reused} reused, ${skipped.length} skipped)`);
    return report;
  }

  explain(sql: string): Array<Record<string, unknown>> {
    if (!/^\s*select\b/i.test(sql)) throw new Error("EXPLAIN helper accepts SELECT statements only");
    return this.db.query<Record<string, unknown>, []>(`EXPLAIN QUERY PLAN ${sql}`).all();
  }
}
