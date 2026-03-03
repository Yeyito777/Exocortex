/**
 * Conversation persistence — versioned JSON files.
 *
 * Reads/writes conversation files to ~/.config/exocortex/conversations/.
 * Schema is versioned — migrations run on load to upgrade old formats.
 *
 * This is the only file that touches the conversations directory.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { log } from "./log";
import type { Conversation, ApiMessage, ModelId, ConversationSummary } from "./messages";

// ── Schema version ──────────────────────────────────────────────────

const CURRENT_VERSION = 1;

interface ConversationFileV1 {
  version: 1;
  id: string;
  model: ModelId;
  messages: ApiMessage[];
  createdAt: number;
  updatedAt: number;
}

type ConversationFile = ConversationFileV1;

// ── Migrations ──────────────────────────────────────────────────────

/**
 * Migrate a raw parsed file to the current version.
 * Add migration steps here as the schema evolves:
 *   if (data.version === 1) data = migrateV1toV2(data);
 *   if (data.version === 2) data = migrateV2toV3(data);
 *   ...
 */
function migrate(data: Record<string, unknown>): ConversationFile {
  const version = (data.version as number) ?? 0;

  if (version === CURRENT_VERSION) {
    return data as unknown as ConversationFile;
  }

  // Unknown/future version — best effort
  log("warn", `persistence: unknown schema version ${version}, attempting to load as v${CURRENT_VERSION}`);
  return data as unknown as ConversationFile;
}

// ── Paths ───────────────────────────────────────────────────────────

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "exocortex");
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
  };
}

function fromFile(file: ConversationFile): Conversation {
  return {
    id: file.id,
    model: file.model,
    messages: file.messages,
    createdAt: file.createdAt,
  };
}

// ── Public API ──────────────────────────────────────────────────────

/** Save a conversation to disk. */
export function save(conv: Conversation): void {
  ensureDir();
  const file = toFile(conv);
  writeFileSync(convPath(conv.id), JSON.stringify(file, null, 2), { mode: 0o600 });
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
      });
    } catch (err) {
      log("error", `persistence: failed to load summary for ${filename}: ${err}`);
    }
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/** Extract a short preview from the first user message. */
function extractPreview(messages: ApiMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content.slice(0, 80);
    }
  }
  return "";
}
