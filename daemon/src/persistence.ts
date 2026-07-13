/**
 * Conversation persistence — versioned JSON files.
 *
 * Reads/writes conversation files to ~/.config/exocortex/data/conversations/.
 * Trash (soft-delete) lives in a sibling data/trash/ directory.  Its
 * stack-ordered trash.json also stores sidebar undo records for non-delete
 * actions such as moves, pins, and folder creation.
 * Schema is versioned — migrations run on load to upgrade old formats.
 *
 * This is the only file that touches the conversations and trash directories.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, statSync, utimesSync } from "fs";
import { log } from "./log";
import { conversationsDir, dataDir, trashDir } from "@exocortex/shared/paths";
import type { Conversation, StoredMessage, ApiMessage, ProviderId, ModelId, EffortLevel, ConversationSummary, PersistedConversationSummary, PersistedFolderSummary, SidebarItemRef, ConversationGoal } from "./messages";
import { DEFAULT_EFFORT, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, DEFAULT_PROVIDER_ORDER, MAX_EXO_SUBAGENT_DEPTH, activeContextCompactionHistoryCount, historyPrefixHash, isValidActiveContext, isValidActiveContextCached, sortConversations, summarizeConversation } from "./messages";
import type { QueuedMessageInfo } from "./protocol";

// ── Schema version ──────────────────────────────────────────────────

const CURRENT_VERSION = 16;

interface ConversationFileV1 {
  version: 1;
  id: string;
  model: ModelId;
  messages: ApiMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ConversationFileV2 {
  version: 2;
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ConversationFileV3 {
  version: 3;
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
}

interface ConversationFileV4 {
  version: 4;
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
}

interface ConversationFileV5 {
  version: 5;
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
}

interface ConversationFileV6 {
  version: 6;
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
}

interface ConversationFileV7 {
  version: 7;
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  title: string | null;
}

interface ConversationFileV8 {
  version: 8;
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  /** Non-nullable title. Naming logic lives in the client. */
  title: string;
}

interface ConversationFileV9 {
  version: 9;
  id: string;
  model: ModelId;
  effort: EffortLevel;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  title: string;
}

interface ConversationFileV10 {
  version: 10;
  id: string;
  /**
   * Optional for compatibility: feat-system-instructions also used v10
   * before provider was introduced.
   */
  provider?: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  title: string;
}

interface ConversationFileV11 {
  version: 11;
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  title: string;
}

interface ConversationFileV12 {
  version: 12;
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  folderId: string | null;
  title: string;
}

interface ConversationFileV13 {
  version: 13;
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  folderId: string | null;
  title: string;
  goal: ConversationGoal | null;
}

interface ConversationFileV14 extends Omit<ConversationFileV13, "version"> {
  version: 14;
  activeContext: Conversation["activeContext"];
}

interface ConversationFileV15 extends Omit<ConversationFileV14, "version"> {
  version: 15;
  subagentMaxDepth: number | null;
}

interface ConversationFileV16 extends Omit<ConversationFileV15, "version"> {
  version: 16;
}

type ConversationFile = ConversationFileV16;

function normalizeProviderId(provider: unknown): ProviderId {
  return typeof provider === "string" && (DEFAULT_PROVIDER_ORDER as readonly string[]).includes(provider)
    ? provider as ProviderId
    : DEFAULT_PROVIDER_ID;
}

// ── Migrations ──────────────────────────────────────────────────────

/** v1 → v2: Add null metadata to all messages. */
function migrateV1toV2(data: ConversationFileV1): ConversationFileV2 {
  return {
    ...data,
    version: 2,
    messages: data.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      metadata: null,
    })),
  };
}

/** v2 → v3: Add lastContextTokens. */
function migrateV2toV3(data: ConversationFileV2): ConversationFileV3 {
  return {
    ...data,
    version: 3,
    lastContextTokens: null,
  };
}

/** v3 → v4: Add marked flag. */
function migrateV3toV4(data: ConversationFileV3): ConversationFileV4 {
  return {
    ...data,
    version: 4,
    marked: false,
  };
}

/** v4 → v5: Add pinned flag. */
function migrateV4toV5(data: ConversationFileV4): ConversationFileV5 {
  return {
    ...data,
    version: 5,
    pinned: false,
  };
}

/** v5 → v6: Add sortOrder. Use negative updatedAt so more recent = lower value = first. */
function migrateV5toV6(data: ConversationFileV5): ConversationFileV6 {
  return {
    ...data,
    version: 6,
    sortOrder: -data.updatedAt,
  };
}

/** v6 → v7: Add title field. */
function migrateV6toV7(data: ConversationFileV6): ConversationFileV7 {
  return {
    ...data,
    version: 7,
    title: null,
  };
}

/** Extract a short preview from the first user message (used only for one-time v7→v8 migration). */
function legacyPreview(messages: StoredMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content.slice(0, 80);
    if (Array.isArray(msg.content)) {
      const tb = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
      if (tb) return tb.text.slice(0, 80);
      return "📎 Image";
    }
  }
  return "";
}

/** v7 → v8: Make title non-nullable. Existing null titles get a one-time preview from messages. */
function migrateV7toV8(data: ConversationFileV7): ConversationFileV8 {
  return {
    ...data,
    version: 8,
    title: data.title ?? legacyPreview(data.messages),
  };
}

/** v8 → v9: Add effort field. */
function migrateV8toV9(data: ConversationFileV8): ConversationFileV9 {
  return {
    ...data,
    version: 9,
    effort: DEFAULT_EFFORT,
  };
}

/**
 * v9 → v10: Support system_instructions message role.
 *
 * No structural change — feat-system-instructions originally used v10 for
 * this semantic expansion before provider/fastMode were added in a later schema bump.
 */
function migrateV9toV10(data: ConversationFileV9): ConversationFileV10 {
  return {
    ...data,
    version: 10,
  };
}

/** v10 → v11: Add provider and fastMode fields. */
function migrateV10toV11(data: ConversationFileV10): ConversationFileV11 {
  const provider = normalizeProviderId(data.provider);
  return {
    ...data,
    version: 11,
    provider,
    model: data.provider && provider === data.provider ? data.model : DEFAULT_MODEL_BY_PROVIDER[provider],
    fastMode: false,
  };
}

/** v11 → v12: Add sidebar folder membership. */
function migrateV11toV12(data: ConversationFileV11): ConversationFileV12 {
  return {
    ...data,
    version: 12,
    folderId: null,
  };
}

/** v12 → v13: Add persistent conversation goal state. */
function migrateV12toV13(data: ConversationFileV12): ConversationFileV13 {
  return {
    ...data,
    version: 13,
    goal: null,
  };
}

/** v13 → v14: Separate compact model replay from the visible transcript. */
function migrateV13toV14(data: ConversationFileV13): ConversationFileV14 {
  return {
    ...data,
    version: 14,
    activeContext: null,
  };
}

/** v14 → v15: Persist the native exo nesting budget across autonomous continuations. */
function migrateV14toV15(data: ConversationFileV14): ConversationFileV15 {
  return {
    ...data,
    version: 15,
    subagentMaxDepth: null,
  };
}

/** v15 → v16: Persist the fixed cursor of legacy active compaction windows. */
function migrateV15toV16(data: ConversationFileV15): ConversationFileV16 {
  const activeContext = data.activeContext && isValidActiveContext(data.activeContext, data.messages)
    ? structuredClone(data.activeContext)
    : data.activeContext;
  if (activeContext && isValidActiveContext(activeContext, data.messages)) {
    const compactionHistoryCount = activeContextCompactionHistoryCount(activeContext, data.messages);
    if (compactionHistoryCount != null) {
      const legacyTailCount = activeContext.transcriptHistoryCount - compactionHistoryCount;
      if (legacyTailCount > 0) {
        activeContext.messages.splice(activeContext.messages.length - legacyTailCount, legacyTailCount);
        activeContext.transcriptHistoryCount = compactionHistoryCount;
        activeContext.transcriptPrefixHash = historyPrefixHash(data.messages, compactionHistoryCount);
      }
      activeContext.compactionHistoryCount = compactionHistoryCount;
      activeContext.compactionPrefixHash = historyPrefixHash(data.messages, compactionHistoryCount);
    }
  }
  return {
    ...data,
    version: 16,
    activeContext,
  };
}

function migrate(raw: Record<string, unknown>): ConversationFile {
  // Progressive migration — each function validates and upgrades one version.
  // `any` is intentional at this deserialization boundary: the data is parsed
  // JSON and each migration step is the type-level validation.
  let data = raw as any;

  if ((data.version ?? 1) < 2) data = migrateV1toV2(data);
  if (data.version < 3) data = migrateV2toV3(data);
  if (data.version < 4) data = migrateV3toV4(data);
  if (data.version < 5) data = migrateV4toV5(data);
  if (data.version < 6) data = migrateV5toV6(data);
  if (data.version < 7) data = migrateV6toV7(data);
  if (data.version < 8) data = migrateV7toV8(data);
  if (data.version < 9) data = migrateV8toV9(data);
  if (data.version < 10) data = migrateV9toV10(data);
  if (data.version < 11) data = migrateV10toV11(data);
  if (data.version < 12) data = migrateV11toV12(data);
  if (data.version < 13) data = migrateV12toV13(data);
  if (data.version < 14) data = migrateV13toV14(data);
  if (data.version < 15) data = migrateV14toV15(data);
  if (data.version < 16) data = migrateV15toV16(data);

  if (data.version !== CURRENT_VERSION) {
    log("warn", `persistence: unknown schema version ${data.version}, attempting to load as v${CURRENT_VERSION}`);
  }

  return data as ConversationFile;
}

// ── Paths ───────────────────────────────────────────────────────────

const CONV_DIR = conversationsDir();
const DATA_DIR = dataDir();
const TRASH_DIR = trashDir();
const TRASH_META = join(TRASH_DIR, "trash.json");
const REDO_META = join(TRASH_DIR, "redo.json");
const INDEX_FILE = join(DATA_DIR, "conversations-index.json");
const FOLDERS_FILE = join(DATA_DIR, "folders.json");
const FOLDER_INSTRUCTIONS_FILE = join(DATA_DIR, "folder-instructions.json");
const UNREAD_FILE = join(DATA_DIR, "unread.json");
const MESSAGE_QUEUE_FILE = join(DATA_DIR, "message-queue.json");
let lastConversationSaveMtime = 0;

/** Reject IDs that contain path separators or parent-directory traversal sequences. */
function assertSafeId(id: string): void {
  if (/[\/\\]|\.\./.test(id)) {
    throw new Error(`Invalid conversation ID (path traversal attempt): ${id}`);
  }
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function ensureDir(): void {
  ensureDataDir();
  if (!existsSync(CONV_DIR)) {
    mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 });
  }
}

function ensureTrashDir(): void {
  if (!existsSync(TRASH_DIR)) {
    mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 });
  }
}

function convPath(id: string): string {
  assertSafeId(id);
  return join(CONV_DIR, `${id}.json`);
}

function trashPath(id: string): string {
  assertSafeId(id);
  return join(TRASH_DIR, `${id}.json`);
}

export interface TrashSidebarItemSnapshot {
  item: SidebarItemRef;
  parentId: string | null;
  pinned: boolean;
  sortOrder: number;
}

export type TrashStackEntry =
  | { type: "conversation"; id: string }
  | { type: "conversations"; ids: string[] }
  | { type: "conversation_removed"; id: string }
  | { type: "conversations_removed"; ids: string[] }
  | { type: "folder_recursive"; folderId: string; folders: PersistedFolderSummary[]; conversationIds: string[] }
  | { type: "folder_recursive_removed"; folderId: string }
  | { type: "folder_unwrap"; folder: PersistedFolderSummary; children: TrashSidebarItemSnapshot[] }
  | { type: "folder_unwrapped"; folderId: string }
  | { type: "sidebar_items"; items: TrashSidebarItemSnapshot[] }
  | { type: "folder_create"; folder: PersistedFolderSummary; items: SidebarItemRef[] }
  | { type: "folder_created"; folder: PersistedFolderSummary; movedItems: TrashSidebarItemSnapshot[] }
  | { type: "folder_renamed"; folderId: string; previousName: string; previousUpdatedAt: number }
  | { type: "conversation_marked"; convId: string; marked: boolean }
  | { type: "conversation_renamed"; convId: string; title: string }
  | { type: "conversation_cloned"; convId: string }
  | { type: "folder_instructions"; folderId: string; text: string };

function normalizeFolderSummary(folder: Partial<PersistedFolderSummary>): PersistedFolderSummary {
  return {
    id: String(folder.id),
    name: String(folder.name || "Folder"),
    parentId: folder.parentId ?? null,
    createdAt: Number(folder.createdAt) || Date.now(),
    updatedAt: Number(folder.updatedAt) || Date.now(),
    pinned: folder.pinned === true,
    sortOrder: Number(folder.sortOrder) || 0,
  };
}

function normalizeSidebarItemSnapshot(raw: unknown): TrashSidebarItemSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const snapshot = raw as Record<string, unknown>;
  const item = snapshot.item as Partial<SidebarItemRef> | undefined;
  if (!item || (item.type !== "conversation" && item.type !== "folder") || typeof item.id !== "string") return null;
  return {
    item: { type: item.type, id: item.id },
    parentId: typeof snapshot.parentId === "string" ? snapshot.parentId : null,
    pinned: snapshot.pinned === true,
    sortOrder: Number(snapshot.sortOrder) || 0,
  };
}

function normalizeSidebarItemSnapshots(raw: unknown): TrashSidebarItemSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeSidebarItemSnapshot)
    .filter((snapshot): snapshot is TrashSidebarItemSnapshot => snapshot !== null);
}

function normalizeSidebarItemRef(raw: unknown): SidebarItemRef | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<SidebarItemRef>;
  if ((item.type !== "conversation" && item.type !== "folder") || typeof item.id !== "string") return null;
  return { type: item.type, id: item.id };
}

function normalizeSidebarItemRefs(raw: unknown): SidebarItemRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeSidebarItemRef)
    .filter((item): item is SidebarItemRef => item !== null);
}

function normalizeTrashEntry(entry: unknown): TrashStackEntry | null {
  if (typeof entry === "string") return { type: "conversation", id: entry };
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (record.type === "conversation" && typeof record.id === "string") {
    return { type: "conversation", id: record.id };
  }
  if (record.type === "conversations" && Array.isArray(record.ids)) {
    return { type: "conversations", ids: record.ids.map(String).filter(Boolean) };
  }
  if (record.type === "conversation_removed" && typeof record.id === "string") {
    return { type: "conversation_removed", id: record.id };
  }
  if (record.type === "conversations_removed" && Array.isArray(record.ids)) {
    return { type: "conversations_removed", ids: record.ids.map(String).filter(Boolean) };
  }
  if (record.type === "folder_recursive" && typeof record.folderId === "string" && Array.isArray(record.folders)) {
    return {
      type: "folder_recursive",
      folderId: record.folderId,
      folders: record.folders.map(folder => normalizeFolderSummary(folder as Partial<PersistedFolderSummary>)),
      conversationIds: Array.isArray(record.conversationIds) ? record.conversationIds.map(String) : [],
    };
  }
  if (record.type === "folder_recursive_removed" && typeof record.folderId === "string") {
    return { type: "folder_recursive_removed", folderId: record.folderId };
  }
  if (record.type === "folder_unwrap" && record.folder && Array.isArray(record.children)) {
    return { type: "folder_unwrap", folder: normalizeFolderSummary(record.folder as Partial<PersistedFolderSummary>), children: normalizeSidebarItemSnapshots(record.children) };
  }
  if (record.type === "folder_unwrapped" && typeof record.folderId === "string") {
    return { type: "folder_unwrapped", folderId: record.folderId };
  }
  if (record.type === "sidebar_items" && Array.isArray(record.items)) {
    return { type: "sidebar_items", items: normalizeSidebarItemSnapshots(record.items) };
  }
  if (record.type === "folder_create" && record.folder) {
    return {
      type: "folder_create",
      folder: normalizeFolderSummary(record.folder as Partial<PersistedFolderSummary>),
      items: normalizeSidebarItemRefs(record.items),
    };
  }
  if (record.type === "folder_created" && record.folder) {
    return {
      type: "folder_created",
      folder: normalizeFolderSummary(record.folder as Partial<PersistedFolderSummary>),
      movedItems: normalizeSidebarItemSnapshots(record.movedItems),
    };
  }
  if (record.type === "folder_renamed" && typeof record.folderId === "string") {
    return {
      type: "folder_renamed",
      folderId: record.folderId,
      previousName: String(record.previousName || "Folder"),
      previousUpdatedAt: Number(record.previousUpdatedAt) || Date.now(),
    };
  }
  if (record.type === "conversation_marked" && typeof record.convId === "string") {
    return { type: "conversation_marked", convId: record.convId, marked: record.marked === true };
  }
  if (record.type === "conversation_renamed" && typeof record.convId === "string") {
    return { type: "conversation_renamed", convId: record.convId, title: String(record.title ?? "") };
  }
  if (record.type === "conversation_cloned" && typeof record.convId === "string") {
    return { type: "conversation_cloned", convId: record.convId };
  }
  if (record.type === "folder_instructions" && typeof record.folderId === "string") {
    return { type: "folder_instructions", folderId: record.folderId, text: String(record.text ?? "") };
  }
  return null;
}

/** Read a sidebar undo/redo stack (last = most recent). Legacy string entries are single trashed conversations. */
function readStack(path: string): TrashStackEntry[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTrashEntry).filter((entry): entry is TrashStackEntry => entry !== null);
  } catch {
    return [];
  }
}

function readTrashStack(): TrashStackEntry[] {
  return readStack(TRASH_META);
}

function readRedoStack(): TrashStackEntry[] {
  return readStack(REDO_META);
}

/** Write a sidebar undo/redo stack back to disk. */
function writeStack(path: string, stack: TrashStackEntry[]): void {
  ensureTrashDir();
  writeFileSync(path, JSON.stringify(stack, null, 2), { mode: 0o600 });
}

function writeTrashStack(stack: TrashStackEntry[]): void {
  writeStack(TRASH_META, stack);
}

function writeRedoStack(stack: TrashStackEntry[]): void {
  writeStack(REDO_META, stack);
}

export function pushTrashEntry(entry: TrashStackEntry): void {
  ensureTrashDir();
  const stack = readTrashStack();
  stack.push(entry);
  writeTrashStack(stack);
  writeRedoStack([]);
}

export function pushUndoEntry(entry: TrashStackEntry): void {
  const stack = readTrashStack();
  stack.push(entry);
  writeTrashStack(stack);
}

export function pushRedoEntry(entry: TrashStackEntry): void {
  const stack = readRedoStack();
  stack.push(entry);
  writeRedoStack(stack);
}

export function popUndoEntry(): TrashStackEntry | null {
  ensureTrashDir();
  const stack = readTrashStack();
  const entry = stack.pop() ?? null;
  if (entry) writeTrashStack(stack);
  return entry;
}

export function popRedoEntry(): TrashStackEntry | null {
  ensureTrashDir();
  const stack = readRedoStack();
  const entry = stack.pop() ?? null;
  if (entry) writeRedoStack(stack);
  return entry;
}

// ── Serialize / Deserialize ─────────────────────────────────────────

function toFile(conv: Conversation): ConversationFile {
  return {
    version: CURRENT_VERSION,
    id: conv.id,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort ?? DEFAULT_EFFORT,
    fastMode: conv.fastMode ?? false,
    messages: conv.messages,
    activeContext: conv.activeContext ?? null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    lastContextTokens: conv.lastContextTokens,
    marked: conv.marked,
    pinned: conv.pinned,
    sortOrder: conv.sortOrder,
    folderId: conv.folderId ?? null,
    title: conv.title,
    goal: conv.goal ?? null,
    subagentMaxDepth: conv.subagentMaxDepth ?? null,
  };
}

function fromFile(file: ConversationFile): Conversation {
  const provider = normalizeProviderId(file.provider);
  const activeContext = file.activeContext
    && isValidActiveContextCached(file.activeContext, file.messages)
    ? file.activeContext
    : null;
  if (file.activeContext && !activeContext) {
    log("warn", `persistence: discarded invalid active context for ${file.id}; full transcript will be replayed`);
  }
  const conv: Conversation = {
    id: file.id,
    provider,
    model: provider === file.provider ? file.model : DEFAULT_MODEL_BY_PROVIDER[provider],
    effort: file.effort,
    fastMode: file.fastMode,
    messages: file.messages,
    ...(activeContext ? { activeContext } : {}),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    // A token total measured against a discarded compact replay is no longer a
    // meaningful projection for the full transcript fallback.
    lastContextTokens: file.activeContext && !activeContext ? null : file.lastContextTokens,
    marked: file.marked,
    pinned: file.pinned,
    sortOrder: file.sortOrder,
    title: file.title,
  };
  if (typeof file.subagentMaxDepth === "number"
      && Number.isInteger(file.subagentMaxDepth)
      && file.subagentMaxDepth >= 0
      && file.subagentMaxDepth <= MAX_EXO_SUBAGENT_DEPTH) {
    conv.subagentMaxDepth = file.subagentMaxDepth;
  }
  if (file.folderId != null) conv.folderId = file.folderId;
  if (file.goal != null && file.goal.status !== "complete") conv.goal = file.goal;
  return conv;
}

// ── Summary index ───────────────────────────────────────────────────

const INDEX_VERSION = 2;

export interface ConversationIndexEntry extends PersistedConversationSummary {
  fileSize: number;
  fileMtimeMs: number;
}

interface ConversationIndexFile {
  version: number;
  updatedAt: number;
  conversations: ConversationIndexEntry[];
}

export interface LoadConversationIndexResult {
  summaries: PersistedConversationSummary[];
  reused: number;
  rebuilt: number;
  removed: number;
  saved: boolean;
}

export function getConversationFileStat(id: string): { fileSize: number; fileMtimeMs: number } {
  const stat = statSync(convPath(id));
  return { fileSize: stat.size, fileMtimeMs: stat.mtimeMs };
}

function statConversationFile(id: string): { fileSize: number; fileMtimeMs: number } | null {
  try {
    return getConversationFileStat(id);
  } catch {
    return null;
  }
}

export function indexEntryFromConversation(conv: Conversation): ConversationIndexEntry {
  const stat = statConversationFile(conv.id) ?? { fileSize: 0, fileMtimeMs: 0 };
  return { ...summarizeConversation(conv), ...stat };
}

function readConversationIndex(): ConversationIndexFile | null {
  try {
    if (!existsSync(INDEX_FILE)) return null;
    const parsed = JSON.parse(readFileSync(INDEX_FILE, "utf-8")) as ConversationIndexFile;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.conversations)) return null;
    return parsed;
  } catch (err) {
    log("warn", `persistence: failed to read conversation index: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function saveConversationIndex(entries: ConversationIndexEntry[]): void {
  ensureDataDir();
  const file: ConversationIndexFile = {
    version: INDEX_VERSION,
    updatedAt: Date.now(),
    conversations: entries,
  };
  const tmp = `${INDEX_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, INDEX_FILE);
}

interface FoldersFile {
  version: 1;
  updatedAt: number;
  folders: PersistedFolderSummary[];
}

interface FolderInstructionsFile {
  version: 1;
  updatedAt: number;
  instructions: Record<string, string>;
}

export function loadFolders(): PersistedFolderSummary[] {
  ensureDataDir();
  try {
    if (!existsSync(FOLDERS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(FOLDERS_FILE, "utf-8")) as FoldersFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.folders)) return [];
    return parsed.folders.map((folder) => normalizeFolderSummary(folder));
  } catch (err) {
    log("warn", `persistence: failed to read folders: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function saveFolders(folders: PersistedFolderSummary[]): void {
  ensureDataDir();
  const file: FoldersFile = { version: 1, updatedAt: Date.now(), folders };
  const tmp = `${FOLDERS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, FOLDERS_FILE);
}

export function loadFolderInstructions(): Map<string, string> {
  ensureDataDir();
  try {
    if (!existsSync(FOLDER_INSTRUCTIONS_FILE)) return new Map();
    const parsed = JSON.parse(readFileSync(FOLDER_INSTRUCTIONS_FILE, "utf-8")) as FolderInstructionsFile;
    if (parsed.version !== 1 || !parsed.instructions || typeof parsed.instructions !== "object") return new Map();
    const result = new Map<string, string>();
    for (const [folderId, text] of Object.entries(parsed.instructions)) {
      if (typeof text === "string" && text.length > 0) result.set(folderId, text);
    }
    return result;
  } catch (err) {
    log("warn", `persistence: failed to read folder instructions: ${err instanceof Error ? err.message : err}`);
    return new Map();
  }
}

export function saveFolderInstructions(instructions: Map<string, string>): void {
  ensureDataDir();
  const file: FolderInstructionsFile = {
    version: 1,
    updatedAt: Date.now(),
    instructions: Object.fromEntries([...instructions.entries()].filter(([, text]) => text.length > 0)),
  };
  const tmp = `${FOLDER_INSTRUCTIONS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, FOLDER_INSTRUCTIONS_FILE);
}

interface UnreadFile {
  version: 1;
  updatedAt: number;
  conversationIds: string[];
}

/** Load persisted unread conversation IDs. Invalid/corrupt files are treated as empty. */
export function loadUnreadConversationIds(): string[] {
  ensureDataDir();
  try {
    if (!existsSync(UNREAD_FILE)) return [];
    const parsed = JSON.parse(readFileSync(UNREAD_FILE, "utf-8")) as UnreadFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.conversationIds)) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.conversationIds) {
      if (typeof raw !== "string" || seen.has(raw)) continue;
      try {
        assertSafeId(raw);
      } catch {
        continue;
      }
      seen.add(raw);
      ids.push(raw);
    }
    return ids;
  } catch (err) {
    log("warn", `persistence: failed to read unread state: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** Persist unread conversation IDs in a small sidecar file. */
export function saveUnreadConversationIds(conversationIds: Iterable<string>): void {
  ensureDataDir();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of conversationIds) {
    if (seen.has(id)) continue;
    assertSafeId(id);
    seen.add(id);
    ids.push(id);
  }
  const file: UnreadFile = { version: 1, updatedAt: Date.now(), conversationIds: ids };
  const tmp = `${UNREAD_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, UNREAD_FILE);
}

// ── Persistent daemon-owned message queue ───────────────────────────

export interface PersistedQueuedMessage extends QueuedMessageInfo {
  /** Delegation budget installed if this queue entry starts a later turn. */
  subagentMaxDepth?: number | null;
  /** Durable completion notification represented by this queue item. */
  subagentNotificationId?: string;
}

interface MessageQueueFile {
  version: 1;
  updatedAt: number;
  messages: PersistedQueuedMessage[];
}

function normalizeQueuedMessage(raw: unknown): PersistedQueuedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  if (typeof entry.convId !== "string" || !entry.convId) return null;
  if (typeof entry.text !== "string") return null;
  if (entry.timing !== "next-turn" && entry.timing !== "message-end") return null;
  if (entry.source !== "daemon" && entry.source !== "global-idle") return null;

  const normalized: PersistedQueuedMessage = {
    id: entry.id,
    convId: entry.convId,
    text: entry.text,
    timing: entry.timing,
    source: entry.source,
    createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : Date.now(),
  };
  if (Array.isArray(entry.images)) normalized.images = entry.images as PersistedQueuedMessage["images"];
  if (entry.target === "conversation" || entry.target === "new-conversation") normalized.target = entry.target;
  if (typeof entry.provider === "string") normalized.provider = entry.provider as ProviderId;
  if (typeof entry.model === "string") normalized.model = entry.model;
  if (typeof entry.effort === "string") normalized.effort = entry.effort as EffortLevel;
  if (typeof entry.fastMode === "boolean") normalized.fastMode = entry.fastMode;
  if (typeof entry.folderId === "string" || entry.folderId === null) normalized.folderId = entry.folderId;
  if (entry.waitTarget && typeof entry.waitTarget === "object") {
    const target = entry.waitTarget as Record<string, unknown>;
    if (target.type === "global") normalized.waitTarget = { type: "global" };
    else if (target.type === "conversation" && typeof target.convId === "string" && typeof target.label === "string") {
      normalized.waitTarget = { type: "conversation", convId: target.convId, label: target.label };
    } else if (target.type === "folder" && typeof target.folderId === "string" && typeof target.label === "string") {
      normalized.waitTarget = { type: "folder", folderId: target.folderId, label: target.label };
    }
  }
  if (typeof entry.subagentMaxDepth === "number" || entry.subagentMaxDepth === null) {
    normalized.subagentMaxDepth = entry.subagentMaxDepth;
  }
  if (typeof entry.subagentNotificationId === "string") normalized.subagentNotificationId = entry.subagentNotificationId;
  return normalized;
}

/** Load the durable queue. Invalid entries are ignored; corrupt files are treated as empty. */
export function loadQueuedMessages(): PersistedQueuedMessage[] {
  ensureDataDir();
  try {
    if (!existsSync(MESSAGE_QUEUE_FILE)) return [];
    const parsed = JSON.parse(readFileSync(MESSAGE_QUEUE_FILE, "utf-8")) as Partial<MessageQueueFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return [];
    return parsed.messages
      .map(normalizeQueuedMessage)
      .filter((entry): entry is PersistedQueuedMessage => entry !== null);
  } catch (err) {
    log("warn", `persistence: failed to read message queue: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** Atomically replace the durable queue snapshot. */
export function saveQueuedMessages(messages: PersistedQueuedMessage[]): void {
  ensureDataDir();
  const file: MessageQueueFile = { version: 1, updatedAt: Date.now(), messages };
  const tmp = `${MESSAGE_QUEUE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, MESSAGE_QUEUE_FILE);
}

/** Load summaries from the index, repairing stale/missing entries by parsing only those conversation files. */
export function loadConversationIndex(): LoadConversationIndexResult {
  ensureDir();
  const index = readConversationIndex();
  const indexed = new Map<string, ConversationIndexEntry>();
  for (const entry of index?.conversations ?? []) indexed.set(entry.id, entry);

  const entries: ConversationIndexEntry[] = [];
  let reused = 0;
  let rebuilt = 0;
  let removed = 0;
  let saved = index === null;
  const seen = new Set<string>();

  for (const filename of readdirSync(CONV_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const id = filename.slice(0, -".json".length);
    seen.add(id);
    const stat = statConversationFile(id);
    if (!stat) continue;

    const cached = indexed.get(id);
    if (cached && cached.fileSize === stat.fileSize && cached.fileMtimeMs === stat.fileMtimeMs) {
      entries.push(cached);
      reused++;
      continue;
    }

    const conv = load(id);
    if (conv) {
      entries.push({ ...summarizeConversation(conv), ...stat });
      rebuilt++;
      saved = true;
    } else {
      saved = true;
    }
  }

  for (const id of indexed.keys()) {
    if (!seen.has(id)) {
      removed++;
      saved = true;
    }
  }

  sortConversations(entries);
  if (saved) saveConversationIndex(entries);

  return {
    summaries: entries.map(({ fileSize: _fileSize, fileMtimeMs: _fileMtimeMs, ...summary }) => summary),
    reused,
    rebuilt,
    removed,
    saved,
  };
}

// ── Public API ──────────────────────────────────────────────────────

/** Save a conversation to disk (atomic write-then-rename). */
export function save(conv: Conversation): void {
  assertSafeId(conv.id);
  ensureDir();
  const file = toFile(conv);
  const dest = convPath(conv.id);
  const tmp = dest + ".tmp";
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, dest);
  // The summary index validates cached entries using file size + mtime. Sidebar
  // moves can rewrite a conversation file multiple times within one filesystem
  // timestamp tick while preserving the JSON byte length (e.g. swapping two
  // same-width sortOrder values). Bump mtimes monotonically so a daemon reload can
  // reliably detect those stale index entries before the debounced index save runs.
  try {
    lastConversationSaveMtime = Math.max(Date.now(), lastConversationSaveMtime + 1);
    const mtime = new Date(lastConversationSaveMtime);
    utimesSync(dest, mtime, mtime);
  } catch {
    // Best effort: the file contents are already safely written.
  }
}

function moveConversationFilesToTrash(ids: string[]): string[] {
  const moved: string[] = [];
  ensureTrashDir();
  for (const id of ids) {
    assertSafeId(id);
    const src = convPath(id);
    if (!existsSync(src)) continue;
    renameSync(src, trashPath(id));
    moved.push(id);
  }
  return moved;
}

/** Move one or more conversation files to trash instead of deleting them. */
export function trashConversations(ids: string[], recordUndo = true): string[] {
  try {
    const uniqueIds = [...new Set(ids)];
    const moved = moveConversationFilesToTrash(uniqueIds);
    if (moved.length === 0) return [];
    if (recordUndo) pushTrashEntry(moved.length === 1 ? { type: "conversation", id: moved[0] } : { type: "conversations", ids: moved });
    log("info", `persistence: trashed ${moved.length === 1 ? moved[0] : `${moved.length} conversations`}`);
    return moved;
  } catch (err) {
    log("error", `persistence: failed to trash conversations: ${err}`);
    return [];
  }
}

/** Move a conversation file to trash instead of deleting it. */
export function trashFile(id: string): void {
  trashConversations([id]);
}

/** Move a folder's conversations to trash and optionally push one undo entry for the whole folder tree. */
export function trashFolderRecursive(entry: Extract<TrashStackEntry, { type: "folder_recursive" }>, recordUndo = true): boolean {
  try {
    const moved = moveConversationFilesToTrash(entry.conversationIds);
    if (recordUndo) pushTrashEntry({ ...entry, conversationIds: moved });
    log("info", `persistence: trashed folder ${entry.folderId} (${moved.length} conversations)`);
    return true;
  } catch (err) {
    log("error", `persistence: failed to trash folder ${entry.folderId}: ${err}`);
    return false;
  }
}

function restoreConversationFile(id: string): Conversation | null {
  const src = trashPath(id);
  if (!existsSync(src)) {
    log("warn", `persistence: trashed file missing for ${id}`);
    return null;
  }

  ensureDir();
  renameSync(src, convPath(id));
  log("info", `persistence: restored ${id} from trash`);
  return load(id);
}

export function restoreConversationsFromTrash(ids: string[]): Conversation[] {
  return ids
    .map(restoreConversationFile)
    .filter((conv): conv is Conversation => conv !== null);
}

function parseConversationFile(path: string): ConversationFile {
  return migrate(JSON.parse(readFileSync(path, "utf-8")));
}

/** Load a single conversation from disk. Returns null if not found or corrupt. */
export function load(id: string): Conversation | null {
  assertSafeId(id);
  const path = convPath(id);
  if (!existsSync(path)) return null;
  try {
    return fromFile(parseConversationFile(path));
  } catch (err) {
    log("error", `persistence: failed to load ${id}: ${err}`);
    return null;
  }
}

/** Load all conversations from disk in one pass. */
export function loadAllConversations(): Conversation[] {
  ensureDir();
  const conversations: Conversation[] = [];

  for (const filename of readdirSync(CONV_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const path = join(CONV_DIR, filename);
    try {
      conversations.push(fromFile(parseConversationFile(path)));
    } catch (err) {
      log("error", `persistence: failed to load ${filename}: ${err}`);
    }
  }

  sortConversations(conversations);
  return conversations;
}

/** Load all conversations from disk, returning summaries sorted by sortOrder. */
export function loadAll(): ConversationSummary[] {
  const summaries = loadAllConversations().map((conv) => ({
    ...summarizeConversation(conv),
    streaming: false,
    unread: false,
  }));
  sortConversations(summaries);
  return summaries;
}
