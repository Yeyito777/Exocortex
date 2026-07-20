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
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "fs";
import { log } from "./log";
import { conversationsDir, dataDir, trashDir } from "@exocortex/shared/paths";
import type { Conversation, StoredMessage, ApiMessage, ProviderId, ModelId, EffortLevel, ConversationSummary, PersistedConversationSummary, PersistedFolderSummary, SidebarItemRef, ConversationGoal } from "./messages";
import { DEFAULT_EFFORT, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, DEFAULT_PROVIDER_ORDER, MAX_EXO_SUBAGENT_DEPTH, activeContextCompactionHistoryCount, historyPrefixHash, isValidActiveContext, isValidActiveContextCached, rewindActiveContextToHistoryCount, sortConversations, summarizeConversation } from "./messages";
import type { QueuedMessageInfo } from "./protocol";

// ── Schema version ──────────────────────────────────────────────────

const CURRENT_VERSION = 17;

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

export interface PersistedUnwindReceipt {
  operationId: string;
  userMessageIndex: number;
  historyTotalEntries: number;
}

interface ConversationFileV17 extends Omit<ConversationFileV16, "version"> {
  version: 17;
  storageGeneration: number;
  lastUnwindReceipt: PersistedUnwindReceipt | null;
}

type ConversationFile = ConversationFileV17;

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

/** v16 → v17: Add a durable generation for targeted mutation overlays. */
function migrateV16toV17(data: ConversationFileV16): ConversationFileV17 {
  return {
    ...data,
    version: 17,
    storageGeneration: 1,
    lastUnwindReceipt: null,
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
  if (data.version < 17) data = migrateV16toV17(data);

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

/** Small durable overlay used until the next ordinary full conversation save. */
function unwindPath(id: string): string {
  assertSafeId(id);
  return join(CONV_DIR, `${id}.unwind`);
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

interface ConversationStorageState {
  /** Generation currently materialized in the base JSON file. */
  baseGeneration: number;
  /** Latest logical generation, including an active unwind overlay. */
  currentGeneration: number;
  lastUnwindReceipt: PersistedUnwindReceipt | null;
}

const conversationStorageState = new WeakMap<Conversation, ConversationStorageState>();
const knownStorageGenerations = new Map<string, number>();

function storageStateFor(conv: Conversation): ConversationStorageState {
  return conversationStorageState.get(conv) ?? {
    baseGeneration: 0,
    currentGeneration: 0,
    lastUnwindReceipt: null,
  };
}

function normalizeUnwindReceipt(value: unknown): PersistedUnwindReceipt | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Partial<PersistedUnwindReceipt>;
  if (typeof receipt.operationId !== "string" || receipt.operationId.length === 0
      || !isNonNegativeSafeInteger(receipt.userMessageIndex)
      || !isNonNegativeSafeInteger(receipt.historyTotalEntries)) return null;
  return {
    operationId: receipt.operationId,
    userMessageIndex: receipt.userMessageIndex,
    historyTotalEntries: receipt.historyTotalEntries,
  };
}

export function getLastUnwindReceipt(conv: Conversation): PersistedUnwindReceipt | null {
  const receipt = storageStateFor(conv).lastUnwindReceipt;
  return receipt ? { ...receipt } : null;
}

function toFile(
  conv: Conversation,
  storageGeneration: number,
  lastUnwindReceipt: PersistedUnwindReceipt | null,
): ConversationFile {
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
    storageGeneration,
    lastUnwindReceipt,
  };
}

function fromFile(file: ConversationFile, validateActiveContext = true): Conversation {
  const provider = normalizeProviderId(file.provider);
  const activeContext = file.activeContext
    && (!validateActiveContext || isValidActiveContextCached(file.activeContext, file.messages))
    ? file.activeContext
    : null;
  if (validateActiveContext && file.activeContext && !activeContext) {
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
    lastContextTokens: validateActiveContext && file.activeContext && !activeContext ? null : file.lastContextTokens,
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
  const generation = isNonNegativeSafeInteger(file.storageGeneration) && file.storageGeneration > 0
    ? file.storageGeneration
    : 1;
  conversationStorageState.set(conv, {
    baseGeneration: generation,
    currentGeneration: generation,
    lastUnwindReceipt: normalizeUnwindReceipt(file.lastUnwindReceipt),
  });
  knownStorageGenerations.set(conv.id, generation);
  return conv;
}

// ── Summary index ───────────────────────────────────────────────────

const INDEX_VERSION = 3;

export interface ConversationIndexEntry extends PersistedConversationSummary {
  fileSize: number;
  fileMtimeMs: number;
  storageGeneration: number;
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

interface ConversationUnwindFile {
  version: 1;
  id: string;
  operationId: string;
  baseGeneration: number;
  resultGeneration: number;
  keepMessageCount: number;
  targetHistoryCount: number;
  userMessageIndex: number;
  historyTotalEntries: number;
  messageCount: number;
  lastContextTokens: number | null;
  updatedAt: number;
  supersededQueueIds: string[];
}

function baseConversationFileStat(id: string): { fileSize: number; fileMtimeMs: number } {
  const stat = statSync(convPath(id));
  return { fileSize: stat.size, fileMtimeMs: stat.mtimeMs };
}

export function getConversationFileStat(id: string): { fileSize: number; fileMtimeMs: number } {
  return baseConversationFileStat(id);
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
  const storageGeneration = storageStateFor(conv).currentGeneration;
  knownStorageGenerations.set(conv.id, storageGeneration);
  return {
    ...summarizeConversation(conv),
    ...stat,
    storageGeneration,
  };
}

export function indexEntryFromSummary(summary: PersistedConversationSummary): ConversationIndexEntry {
  const stat = statConversationFile(summary.id) ?? { fileSize: 0, fileMtimeMs: 0 };
  return {
    ...summary,
    ...stat,
    storageGeneration: knownStorageGenerations.get(summary.id) ?? 1,
  };
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
      entries.push(overlayCachedIndexEntry(cached));
      reused++;
      continue;
    }

    const conv = load(id);
    if (conv) {
      entries.push(indexEntryFromConversation(conv));
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
  knownStorageGenerations.clear();
  for (const entry of entries) knownStorageGenerations.set(entry.id, entry.storageGeneration);
  if (saved) saveConversationIndex(entries);

  return {
    summaries: entries.map(({ fileSize: _fileSize, fileMtimeMs: _fileMtimeMs, storageGeneration: _storageGeneration, ...summary }) => summary),
    reused,
    rebuilt,
    removed,
    saved,
  };
}

// ── Public API ──────────────────────────────────────────────────────

function removeUnwindFile(id: string): void {
  try {
    unlinkSync(unwindPath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("warn", `persistence: failed to remove unwind overlay for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseUnwindFile(id: string): ConversationUnwindFile | null {
  const path = unwindPath(id);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ConversationUnwindFile>;
  if (parsed.version !== 1
      || parsed.id !== id
      || typeof parsed.operationId !== "string" || parsed.operationId.length === 0
      || !isNonNegativeSafeInteger(parsed.baseGeneration) || parsed.baseGeneration < 1
      || !isNonNegativeSafeInteger(parsed.resultGeneration) || parsed.resultGeneration <= parsed.baseGeneration
      || !isNonNegativeSafeInteger(parsed.keepMessageCount)
      || !isNonNegativeSafeInteger(parsed.targetHistoryCount)
      || !isNonNegativeSafeInteger(parsed.userMessageIndex)
      || !isNonNegativeSafeInteger(parsed.historyTotalEntries)
      || !isNonNegativeSafeInteger(parsed.messageCount)
      || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)
      || !Array.isArray(parsed.supersededQueueIds)
      || parsed.supersededQueueIds.some((queueId) => typeof queueId !== "string" || queueId.length === 0)
      || (parsed.lastContextTokens !== null
        && (typeof parsed.lastContextTokens !== "number"
          || !Number.isFinite(parsed.lastContextTokens)
          || parsed.lastContextTokens < 0))) {
    throw new Error(`Invalid conversation unwind overlay for ${id}`);
  }
  return parsed as ConversationUnwindFile;
}

function activeUnwindForBaseGeneration(id: string, baseGeneration: number): ConversationUnwindFile | null {
  const unwind = parseUnwindFile(id);
  if (!unwind) return null;
  if (baseGeneration === unwind.baseGeneration) return unwind;
  if (baseGeneration >= unwind.resultGeneration) {
    if (unwind.supersededQueueIds.length === 0) removeUnwindFile(id);
    return null;
  }
  throw new Error(
    `Conflicting conversation unwind overlay for ${id} `
    + `(base=${baseGeneration}, expected=${unwind.baseGeneration}, result=${unwind.resultGeneration})`,
  );
}

function overlayCachedIndexEntry(cached: ConversationIndexEntry): ConversationIndexEntry {
  const unwind = parseUnwindFile(cached.id);
  if (!unwind) return cached;
  // Several targeted cuts can accumulate over one unchanged base file. An
  // independently saved index may therefore contain any logical generation
  // between the sidecar's base and latest result; all describe the same base
  // bytes and are safely advanced to the latest overlay summary in memory.
  if (cached.storageGeneration >= unwind.baseGeneration
      && cached.storageGeneration <= unwind.resultGeneration) {
    return {
      ...cached,
      updatedAt: unwind.updatedAt,
      messageCount: unwind.messageCount,
      storageGeneration: unwind.resultGeneration,
    };
  }
  if (cached.storageGeneration > unwind.resultGeneration) {
    if (unwind.supersededQueueIds.length === 0) removeUnwindFile(cached.id);
    return cached;
  }
  throw new Error(
    `Conversation index conflicts with unwind overlay for ${cached.id} `
    + `(index=${cached.storageGeneration}, base=${unwind.baseGeneration}, result=${unwind.resultGeneration})`,
  );
}

function applyUnwindFile(
  conv: Conversation,
  baseGeneration: number,
  validateActiveContext = true,
): Conversation {
  const unwind = activeUnwindForBaseGeneration(conv.id, baseGeneration);
  if (!unwind) return conv;
  if (unwind.keepMessageCount > conv.messages.length) {
    throw new Error(`Conversation unwind overlay for ${conv.id} retains unavailable messages`);
  }
  conv.messages.splice(unwind.keepMessageCount);
  // Compact display projections only need the immutable compaction boundary.
  // Keep the persisted checkpoint shape without re-hashing the retained prefix;
  // the canonical model-replay load still validates and rewinds it normally.
  if (validateActiveContext) {
    conv.activeContext = conv.activeContext
      ? rewindActiveContextToHistoryCount(conv.activeContext, conv.messages, unwind.targetHistoryCount)
      : null;
  }
  conv.lastContextTokens = unwind.lastContextTokens;
  conv.updatedAt = unwind.updatedAt;
  conversationStorageState.set(conv, {
    baseGeneration,
    currentGeneration: unwind.resultGeneration,
    lastUnwindReceipt: {
      operationId: unwind.operationId,
      userMessageIndex: unwind.userMessageIndex,
      historyTotalEntries: unwind.historyTotalEntries,
    },
  });
  knownStorageGenerations.set(conv.id, unwind.resultGeneration);
  return conv;
}

export interface SaveUnwindOptions {
  operationId: string;
  userMessageIndex: number;
  historyTotalEntries: number;
  messageCount: number;
  supersededQueueIds: string[];
}

/**
 * Persist only an unwind boundary and its scalar derived state. The immutable
 * history prefix remains in the base JSON file; the next ordinary save folds
 * this overlay into that file and removes it.
 */
export function saveUnwind(
  baseConversation: Conversation,
  resultConversation: Conversation,
  targetHistoryCount: number,
  options: SaveUnwindOptions,
): void {
  assertSafeId(baseConversation.id);
  if (resultConversation.id !== baseConversation.id) throw new Error("Unwind result conversation ID mismatch");
  ensureDir();
  if (!existsSync(convPath(baseConversation.id))) {
    throw new Error(`Cannot persist unwind for missing conversation ${baseConversation.id}`);
  }
  const state = storageStateFor(baseConversation);
  const resultGeneration = state.currentGeneration + 1;
  const previous = parseUnwindFile(baseConversation.id);
  const previousIsActive = previous?.baseGeneration === state.baseGeneration
    && previous.resultGeneration === state.currentGeneration;
  const previousIsMaterialized = previous != null
    && previous.resultGeneration <= state.baseGeneration;
  if (previous && !previousIsActive && !previousIsMaterialized) {
    throw new Error(
      `Cannot replace conflicting unwind overlay for ${baseConversation.id} `
      + `(overlay=${previous.baseGeneration}..${previous.resultGeneration}, state=${state.baseGeneration}..${state.currentGeneration})`,
    );
  }
  // A previous queue-file acknowledgement may have failed. Preserve those
  // exact tombstones when replacing the history overlay so a crash cannot
  // resurrect queue entries superseded by an earlier cut.
  const supersededQueueIds = new Set(previous?.supersededQueueIds ?? []);
  for (const queueId of options.supersededQueueIds) supersededQueueIds.add(queueId);
  const file: ConversationUnwindFile = {
    version: 1,
    id: baseConversation.id,
    operationId: options.operationId,
    baseGeneration: state.baseGeneration,
    resultGeneration,
    keepMessageCount: resultConversation.messages.length,
    targetHistoryCount,
    userMessageIndex: options.userMessageIndex,
    historyTotalEntries: options.historyTotalEntries,
    messageCount: options.messageCount,
    lastContextTokens: resultConversation.lastContextTokens,
    updatedAt: resultConversation.updatedAt,
    supersededQueueIds: [...supersededQueueIds],
  };
  const dest = unwindPath(baseConversation.id);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, dest);
  conversationStorageState.set(baseConversation, {
    baseGeneration: state.baseGeneration,
    currentGeneration: resultGeneration,
    lastUnwindReceipt: {
      operationId: options.operationId,
      userMessageIndex: options.userMessageIndex,
      historyTotalEntries: options.historyTotalEntries,
    },
  });
  knownStorageGenerations.set(baseConversation.id, resultGeneration);
}

/** Queue identities committed as superseded by active unwind overlays. */
export function loadUnwindQueueTombstones(): Set<string> {
  ensureDir();
  const tombstones = new Set<string>();
  for (const filename of readdirSync(CONV_DIR)) {
    if (!filename.endsWith(".unwind")) continue;
    const id = filename.slice(0, -".unwind".length);
    const unwind = parseUnwindFile(id);
    if (!unwind) continue;
    if (!existsSync(convPath(id))) {
      // A crash can leave the queue receipt behind after its conversation was
      // moved to trash. Keep suppressing those exact entries until the repaired
      // queue file is durable; recovery below then removes the orphan receipt.
      for (const queueId of unwind.supersededQueueIds) tombstones.add(queueId);
      continue;
    }
    const baseFile = parseConversationFile(convPath(id));
    const isActive = baseFile.storageGeneration === unwind.baseGeneration;
    const isMaterialized = baseFile.storageGeneration >= unwind.resultGeneration;
    if (!isActive && !isMaterialized) {
      throw new Error(
        `Conflicting queue tombstone overlay for ${id} `
        + `(base=${baseFile.storageGeneration}, expected=${unwind.baseGeneration}, result=${unwind.resultGeneration})`,
      );
    }
    for (const queueId of unwind.supersededQueueIds) tombstones.add(queueId);
    if (isMaterialized && unwind.supersededQueueIds.length === 0) removeUnwindFile(id);
  }
  return tombstones;
}

/** Complete startup queue recovery after its canonical queue rewrite succeeds. */
export function acknowledgeRecoveredUnwindQueueCleanup(): void {
  ensureDir();
  for (const filename of readdirSync(CONV_DIR)) {
    if (!filename.endsWith(".unwind")) continue;
    const id = filename.slice(0, -".unwind".length);
    const unwind = parseUnwindFile(id);
    if (!unwind || unwind.supersededQueueIds.length === 0) continue;
    if (!existsSync(convPath(id))) {
      removeUnwindFile(id);
      continue;
    }
    const dest = unwindPath(id);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...unwind, supersededQueueIds: [] }, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
  }
}

/** Remove a now-ownerless receipt after delete has durably cleared its queue. */
export function removeConversationUnwindReceipt(id: string): void {
  assertSafeId(id);
  removeUnwindFile(id);
}

export function hasConversationUnwindReceipt(id: string): boolean {
  assertSafeId(id);
  return existsSync(unwindPath(id));
}

/** Mark exact queue tombstones durable in the queue file after sidecar commit. */
export function acknowledgeUnwindQueueCleanup(id: string, operationId: string): void {
  const unwind = parseUnwindFile(id);
  if (!unwind || unwind.operationId !== operationId || unwind.supersededQueueIds.length === 0) return;
  const dest = unwindPath(id);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...unwind, supersededQueueIds: [] }, null, 2), { mode: 0o600 });
  renameSync(tmp, dest);
}

/** Save a conversation to disk (atomic write-then-rename). */
export function save(conv: Conversation): void {
  assertSafeId(conv.id);
  ensureDir();
  const state = storageStateFor(conv);
  const unwindBeforeSave = parseUnwindFile(conv.id);
  const nextGeneration = state.currentGeneration + 1;
  const file = toFile(conv, nextGeneration, state.lastUnwindReceipt);
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
  conversationStorageState.set(conv, {
    baseGeneration: nextGeneration,
    currentGeneration: nextGeneration,
    lastUnwindReceipt: state.lastUnwindReceipt,
  });
  knownStorageGenerations.set(conv.id, nextGeneration);
  if (!unwindBeforeSave || unwindBeforeSave.supersededQueueIds.length === 0) {
    removeUnwindFile(conv.id);
  }
}

function moveConversationFilesToTrash(ids: string[]): { moved: string[]; failed: string[] } {
  const moved: string[] = [];
  const failed: string[] = [];
  ensureTrashDir();
  for (const id of ids) {
    try {
      assertSafeId(id);
      const src = convPath(id);
      if (!existsSync(src)) {
        failed.push(id);
        continue;
      }
      // Trash/undo moves one canonical file. Fold any pending targeted unwind into
      // it first so undo cannot resurrect the discarded suffix.
      if (existsSync(unwindPath(id))) {
        const effective = load(id);
        if (!effective) throw new Error(`Cannot materialize unwind overlay for ${id} before trashing`);
        save(effective);
      }
      renameSync(src, trashPath(id));
      moved.push(id);
    } catch (err) {
      failed.push(id);
      log("error", `persistence: failed to trash ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { moved, failed };
}

/** Move one or more conversation files to trash instead of deleting them. */
export function trashConversations(ids: string[], recordUndo = true): string[] {
  const uniqueIds = [...new Set(ids)];
  const { moved } = moveConversationFilesToTrash(uniqueIds);
  if (moved.length === 0) return [];
  if (recordUndo) {
    try {
      pushTrashEntry(moved.length === 1 ? { type: "conversation", id: moved[0] } : { type: "conversations", ids: moved });
    } catch (err) {
      // The files are already durably moved. Report success rather than leaving
      // live memory pointing at missing files merely because undo metadata failed.
      log("error", `persistence: failed to record trash undo metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log("info", `persistence: trashed ${moved.length === 1 ? moved[0] : `${moved.length} conversations`}`);
  return moved;
}

/** Move a conversation file to trash instead of deleting it. */
export function trashFile(id: string): void {
  trashConversations([id]);
}

/** Move a folder's conversations to trash and optionally push one undo entry for the whole folder tree. */
export function trashFolderRecursive(entry: Extract<TrashStackEntry, { type: "folder_recursive" }>, recordUndo = true): boolean {
  try {
    const { moved, failed } = moveConversationFilesToTrash(entry.conversationIds);
    if (failed.length > 0) {
      // A folder tree cannot be partially removed without leaving live
      // conversations pointing at deleted folders. Roll back successful renames.
      for (const id of moved) renameSync(trashPath(id), convPath(id));
      return false;
    }
    if (recordUndo) {
      try {
        pushTrashEntry({ ...entry, conversationIds: moved });
      } catch (err) {
        for (const id of moved) renameSync(trashPath(id), convPath(id));
        throw err;
      }
    }
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
    const file = parseConversationFile(path);
    return applyUnwindFile(fromFile(file), file.storageGeneration);
  } catch (err) {
    log("error", `persistence: failed to load ${id}: ${err}`);
    return null;
  }
}

/**
 * Load a conversation solely to build its disposable compact display index.
 * Provider replay never uses this result, so active-context integrity hashing is
 * intentionally deferred until the canonical `load()` path is actually needed.
 */
export function loadForDisplayProjection(id: string): Conversation | null {
  assertSafeId(id);
  const path = convPath(id);
  if (!existsSync(path)) return null;
  try {
    const file = parseConversationFile(path);
    return applyUnwindFile(fromFile(file, false), file.storageGeneration, false);
  } catch (err) {
    log("error", `persistence: failed to load display projection source ${id}: ${err}`);
    return null;
  }
}

/** Load all conversations from disk in one pass. */
export function loadAllConversations(): Conversation[] {
  ensureDir();
  const conversations: Conversation[] = [];

  for (const filename of readdirSync(CONV_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const id = filename.slice(0, -".json".length);
    const conv = load(id);
    if (conv) conversations.push(conv);
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
