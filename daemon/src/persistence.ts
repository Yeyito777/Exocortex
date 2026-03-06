/**
 * Conversation persistence — versioned JSON files.
 *
 * Reads/writes conversation files to ~/.config/exocortex/conversations/.
 * Schema is versioned — migrations run on load to upgrade old formats.
 *
 * This is the only file that touches the conversations directory.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { log } from "./log";
import { CONFIG_DIR } from "./store";
import type { Conversation, StoredMessage, ApiMessage, ModelId, ConversationSummary } from "./messages";

// ── Schema version ──────────────────────────────────────────────────

const CURRENT_VERSION = 4;

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

type ConversationFile = ConversationFileV4;

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

  if (version === CURRENT_VERSION) {
    return data as unknown as ConversationFile;
  }

  log("warn", `persistence: unknown schema version ${version}, attempting to load as v${CURRENT_VERSION}`);
  return data as unknown as ConversationFile;
}

// ── Paths ───────────────────────────────────────────────────────────

const CONV_DIR = join(CONFIG_DIR, "conversations");

function ensureDir(): void {
  if (!existsSync(CONV_DIR)) {
    mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 });
  }
}

function convPath(id: string): string {
  return join(CONV_DIR, `${id}.json`);
}

// ── Serialize / Deserialize ─────────────────────────────────────────

function toFile(conv: Conversation): ConversationFile {
  return {
    version: CURRENT_VERSION,
    id: conv.id,
    model: conv.model,
    messages: conv.messages,
    createdAt: conv.createdAt,
    updatedAt: Date.now(),
    lastContextTokens: conv.lastContextTokens,
    marked: conv.marked,
  };
}

function fromFile(file: ConversationFile): Conversation {
  return {
    id: file.id,
    model: file.model,
    messages: file.messages,
    createdAt: file.createdAt,
    lastContextTokens: file.lastContextTokens,
    marked: file.marked,
  };
}

// ── Public API ──────────────────────────────────────────────────────

/** Save a conversation to disk. */
export function save(conv: Conversation): void {
  ensureDir();
  const file = toFile(conv);
  writeFileSync(convPath(conv.id), JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** Delete a conversation file from disk. */
export function deleteFile(id: string): void {
  const path = convPath(id);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    log("error", `persistence: failed to delete ${id}: ${err}`);
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

/** Load all conversations from disk, returning summaries sorted by updatedAt desc. */
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
        marked: file.marked,
      });
    } catch (err) {
      log("error", `persistence: failed to load summary for ${filename}: ${err}`);
    }
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/** Extract a short preview from the first user message. */
function extractPreview(messages: StoredMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content.slice(0, 80);
    }
  }
  return "";
}
