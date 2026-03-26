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
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from "fs";
import { log } from "./log";
import { conversationsDir, trashDir } from "@exocortex/shared/paths";
import type { Conversation, StoredMessage, ApiMessage, ModelId, EffortLevel, ConversationSummary } from "./messages";
import { DEFAULT_EFFORT, sortConversations } from "./messages";

// ── Schema version ──────────────────────────────────────────────────

const CURRENT_VERSION = 9;

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

type ConversationFile = ConversationFileV9;

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

  if (data.version !== CURRENT_VERSION) {
    log("warn", `persistence: unknown schema version ${data.version}, attempting to load as v${CURRENT_VERSION}`);
  }

  return data as ConversationFile;
}

// ── Paths ───────────────────────────────────────────────────────────

const CONV_DIR = conversationsDir();
const TRASH_DIR = trashDir();
const TRASH_META = join(TRASH_DIR, "trash.json");

/** Reject IDs that contain path separators or parent-directory traversal sequences. */
function assertSafeId(id: string): void {
  if (/[\/\\]|\.\./.test(id)) {
    throw new Error(`Invalid conversation ID (path traversal attempt): ${id}`);
  }
}

function ensureDir(): void {
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
    model: conv.model,
    effort: conv.effort ?? DEFAULT_EFFORT,
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
    model: file.model,
    effort: file.effort,
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

/** Load a single conversation from disk. Returns null if not found or corrupt. */
export function load(id: string): Conversation | null {
  assertSafeId(id);
  const path = convPath(id);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const file = migrate(raw);
    return fromFile(file);
  } catch (err) {
    log("error", `persistence: failed to load ${id}: ${err}`);
    return null;
  }
}

/** Load all conversations from disk, returning summaries sorted by sortOrder. */
export function loadAll(): ConversationSummary[] {
  ensureDir();
  const summaries: ConversationSummary[] = [];

  for (const filename of readdirSync(CONV_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const path = join(CONV_DIR, filename);
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const file = migrate(raw);
      summaries.push({
        id: file.id,
        model: file.model,
        effort: file.effort,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        messageCount: file.messages.length,
        title: file.title,
        marked: file.marked,
        pinned: file.pinned,
        streaming: false,
        unread: false,
        sortOrder: file.sortOrder,
      });
    } catch (err) {
      log("error", `persistence: failed to load summary for ${filename}: ${err}`);
    }
  }

  sortConversations(summaries);
  return summaries;
}