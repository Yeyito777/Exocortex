/**
 * Conversation persistence — versioned JSON files.
 *
 * Reads/writes conversation files to ~/.config/exocortex/conversations/.
 * Trash (soft-delete) lives in a sibling trash/ directory with a
 * stack-ordered trash.json for undo support.
 * Schema is versioned — migrations run on load to upgrade old formats.
 *
 * This is the only file that touches the conversations and trash directories.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from "fs";
import { log } from "./log";
import { conversationsDir, trashDir } from "@exocortex/shared/paths";
import type { Conversation, StoredMessage, ApiMessage, ModelId, ConversationSummary } from "./messages";
import { sortConversations, extractPreview } from "./messages";

// ── Schema version ──────────────────────────────────────────────────

const CURRENT_VERSION = 7;

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

type ConversationFile = ConversationFileV7;

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

function migrate(data: Record<string, unknown>): ConversationFile {
  let version = (data.version as number) ?? 1;

  if (version === 1) {
    data = migrateV1toV2(data as unknown as ConversationFileV1) as unknown as Record<string, unknown>;
    version = 2;
  }

  if (version === 2) {
    data = migrateV2toV3(data as unknown as ConversationFileV2) as unknown as Record<string, unknown>;
    version = 3;
  }

  if (version === 3) {
    data = migrateV3toV4(data as unknown as ConversationFileV3) as unknown as Record<string, unknown>;
    version = 4;
  }

  if (version === 4) {
    data = migrateV4toV5(data as unknown as ConversationFileV4) as unknown as Record<string, unknown>;
    version = 5;
  }

  if (version === 5) {
    data = migrateV5toV6(data as unknown as ConversationFileV5) as unknown as Record<string, unknown>;
    version = 6;
  }

  if (version === 6) {
    data = migrateV6toV7(data as unknown as ConversationFileV6) as unknown as Record<string, unknown>;
    version = 7;
  }

  if (version === CURRENT_VERSION) {
    return data as unknown as ConversationFile;
  }

  log("warn", `persistence: unknown schema version ${version}, attempting to load as v${CURRENT_VERSION}`);
  return data as unknown as ConversationFile;
}

// ── Paths ───────────────────────────────────────────────────────────

const CONV_DIR = conversationsDir();
const TRASH_DIR = trashDir();
const TRASH_META = join(TRASH_DIR, "trash.json");

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
  return join(CONV_DIR, `${id}.json`);
}

function trashPath(id: string): string {
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

/** Save a conversation to disk. */
export function save(conv: Conversation): void {
  ensureDir();
  const file = toFile(conv);
  writeFileSync(convPath(conv.id), JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** Move a conversation file to trash instead of deleting it. */
export function trashFile(id: string): void {
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
      const preview = extractPreview(file.messages);
      summaries.push({
        id: file.id,
        model: file.model,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        messageCount: file.messages.length,
        preview,
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