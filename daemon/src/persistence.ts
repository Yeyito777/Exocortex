/**
 * Conversation persistence — versioned JSON files.
 *
 * Reads/writes conversation files to ~/.config/exocortex/data/conversations/.
 * Trash (soft-delete) lives in a sibling data/trash/ directory with a
 * stack-ordered trash.json for undo support.
 * Schema is versioned — migrations run on load to upgrade old formats.
 *
 * This is the only file that touches the conversations and trash directories.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync, statSync } from "fs";
import { log } from "./log";
import { conversationsDir, dataDir, trashDir } from "@exocortex/shared/paths";
import type { Conversation, StoredMessage, ApiMessage, ProviderId, ModelId, EffortLevel, ConversationSummary, PersistedConversationSummary } from "./messages";
import { DEFAULT_EFFORT, countConversationMessages, sortConversations, summarizeConversation } from "./messages";

// ── Schema version ──────────────────────────────────────────────────

const CURRENT_VERSION = 11;

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

type ConversationFile = ConversationFileV11;

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
  return {
    ...data,
    version: 11,
    provider: data.provider ?? "anthropic",
    fastMode: false,
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
const INDEX_FILE = join(DATA_DIR, "conversations-index.json");

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

/** Read the trash stack (array of conversation IDs, last = most recent). */
function readTrashStack(): string[] {
  try {
    if (!existsSync(TRASH_META)) return [];
    return JSON.parse(readFileSync(TRASH_META, "utf-8"));
  } catch {
    return [];
  }
}

/** Write the trash stack back to disk. */
function writeTrashStack(stack: string[]): void {
  writeFileSync(TRASH_META, JSON.stringify(stack, null, 2), { mode: 0o600 });
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
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    lastContextTokens: conv.lastContextTokens,
    marked: conv.marked,
    pinned: conv.pinned,
    sortOrder: conv.sortOrder,
    title: conv.title,
  };
}

function fromFile(file: ConversationFile): Conversation {
  return {
    id: file.id,
    provider: file.provider,
    model: file.model,
    effort: file.effort,
    fastMode: file.fastMode,
    messages: file.messages,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    lastContextTokens: file.lastContextTokens,
    marked: file.marked,
    pinned: file.pinned,
    sortOrder: file.sortOrder,
    title: file.title,
  };
}

// ── Summary index ───────────────────────────────────────────────────

const INDEX_VERSION = 1;

export interface ConversationIndexEntry extends PersistedConversationSummary {
  fileSize: number;
  fileMtimeMs: number;
}

interface ConversationIndexFile {
  version: 1;
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
}

/** Move a conversation file to trash instead of deleting it. */
export function trashFile(id: string): void {
  assertSafeId(id);
  const src = convPath(id);
  try {
    if (!existsSync(src)) return;
    ensureTrashDir();
    const dst = trashPath(id);
    renameSync(src, dst);
    const stack = readTrashStack();
    stack.push(id);
    writeTrashStack(stack);
    log("info", `persistence: trashed ${id}`);
  } catch (err) {
    log("error", `persistence: failed to trash ${id}: ${err}`);
  }
}

/**
 * Restore the most recently trashed conversation.
 * Moves the file back to conversations/ and returns the restored conversation,
 * or null if the trash is empty.
 */
export function restoreLatest(): Conversation | null {
  try {
    ensureTrashDir();
    const stack = readTrashStack();
    if (stack.length === 0) return null;

    const id = stack.pop()!;
    writeTrashStack(stack);

    const src = trashPath(id);
    if (!existsSync(src)) {
      log("warn", `persistence: trashed file missing for ${id}`);
      return null;
    }

    ensureDir();
    const dst = convPath(id);
    renameSync(src, dst);
    log("info", `persistence: restored ${id} from trash`);
    return load(id);
  } catch (err) {
    log("error", `persistence: failed to restore from trash: ${err}`);
    return null;
  }
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
    id: conv.id,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort,
    fastMode: conv.fastMode,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: countConversationMessages(conv.messages),
    title: conv.title,
    marked: conv.marked,
    pinned: conv.pinned,
    streaming: false,
    unread: false,
    sortOrder: conv.sortOrder,
  }));
  sortConversations(summaries);
  return summaries;
}
