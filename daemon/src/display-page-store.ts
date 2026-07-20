/**
 * Persistent, page-addressable projection of conversation display history.
 *
 * The canonical conversation JSON remains the source of truth for provider
 * replay and mutations. This projection is deliberately compact and disposable:
 * tool-result bodies and image base64 are omitted, user identities are stored
 * beside their display entries, and pages can be read without parsing the
 * canonical transcript.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { dataDir, conversationsDir } from "@exocortex/shared/paths";
import type { DisplayEntry } from "./protocol";
import type { Conversation, StoredMessage } from "./messages";
import {
  CONTEXT_COMPACTION_FINISHED_KIND,
  isRealUserMessage,
  isReplayHistoryMessage,
} from "./messages";
import { buildDisplayData } from "./display";
import { summarizeTool } from "./tools/registry";

const STORE_VERSION = 2;
const CHUNK_ENTRY_COUNT = 64;
// Preserve the existing conversation-open contract: only images close to the
// newest edge are sent inline. Older images remain represented by metadata but
// their large base64 body is omitted.
const RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES = 8;
const STORE_DIR = join(dataDir(), "display-pages");

export interface ConversationSourceSignature {
  baseSize: number;
  baseMtimeMs: number;
  baseCtimeMs: number;
  unwindSize: number | null;
  unwindMtimeMs: number | null;
  /** Tiny unwind overlays can be rewritten within one filesystem timestamp tick. */
  unwindHash: string | null;
}

interface DisplayPageChunkDescriptor {
  file: string;
  startIndex: number;
  endIndex: number;
}

interface DisplayPageManifest {
  version: typeof STORE_VERSION;
  convId: string;
  buildId: string;
  source: ConversationSourceSignature;
  provider: Conversation["provider"];
  model: Conversation["model"];
  effort: Conversation["effort"];
  fastMode: boolean;
  contextTokens: number | null;
  storedMessageCount: number;
  pinnedEntries: DisplayEntry[];
  historyTotalEntries: number;
  userEntryIndices: number[];
  chunks: DisplayPageChunkDescriptor[];
}

interface DisplayPageChunkFile {
  version: typeof STORE_VERSION;
  startIndex: number;
  entries: DisplayEntry[];
}

export interface StoredDisplayHistoryPage {
  convId: string;
  provider: Conversation["provider"];
  model: Conversation["model"];
  effort: Conversation["effort"];
  fastMode: boolean;
  contextTokens: number | null;
  toolOutputsIncluded: false;
  pinnedEntries: DisplayEntry[];
  entries: DisplayEntry[];
  startIndex: number;
  startUserIndex: number;
  endIndex: number;
  totalEntries: number;
  hasOlder: boolean;
  source: ConversationSourceSignature;
  storedMessageCount: number;
}

export interface DisplayProjectionWriteDiagnostics {
  buildMs: number;
  writeMs: number;
  entries: number;
  chunks: number;
  bytes: number;
}

function assertSafeId(id: string): void {
  if (!id || id === "." || id.length > 240 || /[\/\\]|\.\.|\0/.test(id)) {
    throw new Error(`Invalid conversation ID: ${id}`);
  }
}

function conversationPath(id: string): string {
  assertSafeId(id);
  return join(conversationsDir(), `${id}.json`);
}

function unwindPath(id: string): string {
  assertSafeId(id);
  return join(conversationsDir(), `${id}.unwind`);
}

function statPart(path: string): { size: number; mtimeMs: number; ctimeMs: number } | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch {
    return null;
  }
}

export function getConversationSourceSignature(id: string): ConversationSourceSignature | null {
  const base = statPart(conversationPath(id));
  if (!base) return null;
  const unwind = statPart(unwindPath(id));
  let unwindHash: string | null = null;
  if (unwind) {
    try {
      unwindHash = createHash("sha256").update(readFileSync(unwindPath(id))).digest("hex").slice(0, 24);
    } catch {
      return null;
    }
  }
  return {
    baseSize: base.size,
    baseMtimeMs: base.mtimeMs,
    baseCtimeMs: base.ctimeMs,
    unwindSize: unwind?.size ?? null,
    unwindMtimeMs: unwind?.mtimeMs ?? null,
    unwindHash,
  };
}

function signaturesEqual(a: ConversationSourceSignature, b: ConversationSourceSignature): boolean {
  return a.baseSize === b.baseSize
    && a.baseMtimeMs === b.baseMtimeMs
    && a.baseCtimeMs === b.baseCtimeMs
    && a.unwindSize === b.unwindSize
    && a.unwindMtimeMs === b.unwindMtimeMs
    && a.unwindHash === b.unwindHash;
}

function conversationStoreDir(id: string): string {
  assertSafeId(id);
  return join(STORE_DIR, id);
}

function manifestPath(id: string): string {
  return join(conversationStoreDir(id), "manifest.json");
}

function readManifest(id: string): DisplayPageManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(id), "utf8")) as Partial<DisplayPageManifest>;
    if (parsed.version !== STORE_VERSION
        || parsed.convId !== id
        || typeof parsed.buildId !== "string"
        || !/^\d+-[0-9a-f-]{36}$/.test(parsed.buildId)
        || !parsed.source
        || (parsed.provider !== "openai" && parsed.provider !== "deepseek")
        || typeof parsed.model !== "string"
        || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(parsed.effort))
        || typeof parsed.fastMode !== "boolean"
        || (parsed.contextTokens !== null && !Number.isFinite(parsed.contextTokens))
        || !Array.isArray(parsed.pinnedEntries)
        || !Array.isArray(parsed.userEntryIndices)
        || !Array.isArray(parsed.chunks)
        || !Number.isSafeInteger(parsed.historyTotalEntries)
        || parsed.historyTotalEntries! < 0
        || !Number.isSafeInteger(parsed.storedMessageCount)
        || parsed.storedMessageCount! < 0) return null;
    const manifest = parsed as DisplayPageManifest;
    if (!Number.isFinite(manifest.source.baseMtimeMs)
        || !Number.isFinite(manifest.source.baseCtimeMs)
        || !Number.isSafeInteger(manifest.source.baseSize)
        || (manifest.source.unwindSize !== null && !Number.isSafeInteger(manifest.source.unwindSize))
        || (manifest.source.unwindMtimeMs !== null && !Number.isFinite(manifest.source.unwindMtimeMs))
        || (manifest.source.unwindHash !== null && !/^[0-9a-f]{24}$/.test(manifest.source.unwindHash))) return null;
    let expectedStart = 0;
    for (const chunk of manifest.chunks) {
      if (!/^chunk-\d{6}\.json$/.test(chunk.file)
          || chunk.startIndex !== expectedStart
          || !Number.isSafeInteger(chunk.endIndex)
          || chunk.endIndex <= chunk.startIndex
          || chunk.endIndex > manifest.historyTotalEntries) return null;
      expectedStart = chunk.endIndex;
    }
    if (expectedStart !== manifest.historyTotalEntries) return null;
    let previousUserIndex = -1;
    for (const userIndex of manifest.userEntryIndices) {
      if (!Number.isSafeInteger(userIndex)
          || userIndex <= previousUserIndex
          || userIndex >= manifest.historyTotalEntries) return null;
      previousUserIndex = userIndex;
    }
    return manifest;
  } catch {
    return null;
  }
}

export function hasFreshDisplayProjection(id: string): boolean {
  const source = getConversationSourceSignature(id);
  const manifest = readManifest(id);
  if (!source || !manifest || !signaturesEqual(source, manifest.source)) return false;
  const buildDir = join(conversationStoreDir(id), manifest.buildId);
  return existsSync(buildDir) && manifest.chunks.every((chunk) => existsSync(join(buildDir, chunk.file)));
}

function projectedEditableHistoryStart(conv: Conversation): number | null | undefined {
  const active = conv.activeContext;
  if (active) {
    if (Number.isSafeInteger(active.compactionHistoryCount)
        && active.compactionHistoryCount! >= 0
        && active.compactionHistoryCount! <= active.transcriptHistoryCount) {
      return active.compactionHistoryCount!;
    }
    let historyCount = 0;
    for (const message of conv.messages) {
      if (message.role === "system"
          && message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND
          && message.metadata.startedAt === active.compactedAt) return historyCount;
      if (isReplayHistoryMessage(message)) historyCount += 1;
    }
    return null;
  }
  return conv.messages.some((message) => message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND)
    ? null
    : undefined;
}

/** Opaque user identity used only to reject stale history-edit requests. */
export function pagedUserFingerprint(
  convId: string,
  userIndex: number,
  message: Pick<StoredMessage, "role" | "content" | "providerData">,
): string {
  const hash = createHash("sha256");
  hash.update(convId);
  hash.update("\n");
  hash.update(String(userIndex));
  hash.update("\n");
  hash.update(JSON.stringify({
    role: message.role,
    content: message.content,
    providerData: message.providerData ?? null,
  }));
  return `page-v1:${hash.digest("hex").slice(0, 24)}`;
}

export function isPagedUserFingerprint(value: string): boolean {
  return /^page-v1:[0-9a-f]{24}$/.test(value);
}

function compactProjectionImages(entry: DisplayEntry, index: number, totalEntries: number): DisplayEntry {
  if (entry.type !== "user"
      || !entry.images?.length
      || index >= totalEntries - RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES) return entry;
  return {
    ...entry,
    images: entry.images.map((image) => ({
      mediaType: image.mediaType,
      base64: "",
      sizeBytes: image.sizeBytes,
    })),
  };
}

function buildProjectionEntries(conv: Conversation): {
  pinnedEntries: DisplayEntry[];
  historyEntries: DisplayEntry[];
  userEntryIndices: number[];
} {
  const data = buildDisplayData(
    conv.id,
    conv.provider,
    conv.model,
    conv.effort,
    conv.fastMode ?? false,
    conv.messages,
    conv.lastContextTokens,
    summarizeTool,
    {
      includeToolOutputs: false,
      includeUnwindFingerprints: false,
      editableUserHistoryStart: projectedEditableHistoryStart(conv),
    },
  );
  const realUsers = conv.messages.filter(isRealUserMessage);
  let userIndex = 0;
  const entries = data.entries.map((entry) => {
    if (entry.type !== "user") return entry;
    const message = realUsers[userIndex];
    if (!message) throw new Error(`Display/user history mismatch while indexing ${conv.id}`);
    return {
      ...entry,
      unwindFingerprint: pagedUserFingerprint(conv.id, userIndex++, message),
    };
  });
  if (userIndex !== realUsers.length) {
    throw new Error(`Display/user history mismatch while indexing ${conv.id}: ${userIndex}/${realUsers.length}`);
  }
  const pinnedEntries = entries.filter((entry) => entry.type === "system_instructions");
  const rawHistoryEntries = entries.filter((entry) => entry.type !== "system_instructions");
  const historyEntries = rawHistoryEntries.map((entry, index) => (
    compactProjectionImages(entry, index, rawHistoryEntries.length)
  ));
  const userEntryIndices: number[] = [];
  for (let index = 0; index < historyEntries.length; index++) {
    if (historyEntries[index].type === "user") userEntryIndices.push(index);
  }
  return { pinnedEntries, historyEntries, userEntryIndices };
}

function writeJson(path: string, value: unknown): number {
  const json = JSON.stringify(value);
  writeFileSync(path, json, { mode: 0o600 });
  return Buffer.byteLength(json);
}

function cleanupOldBuilds(id: string): void {
  const manifest = readManifest(id);
  if (!manifest) return;
  const dir = conversationStoreDir(id);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.includes(".tmp")) {
      try {
        if (Date.now() - statSync(path).mtimeMs >= 60_000) rmSync(path, { force: true });
      } catch { /* best effort */ }
      continue;
    }
    if (!entry.isDirectory() || entry.name === manifest.buildId) continue;
    try {
      // Another worker/main writer may still be filling a non-current build.
      // Only published or abandoned old builds are safe to remove.
      const removable = existsSync(join(path, "published")) || Date.now() - statSync(path).mtimeMs >= 60_000;
      if (removable && readManifest(id)?.buildId !== entry.name) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}

/**
 * Atomically publish a complete compact projection for the current canonical
 * source signature. A concurrent canonical write makes this build self-discard.
 */
export function writeDisplayProjection(
  conv: Conversation,
  expectedSource: ConversationSourceSignature | null = getConversationSourceSignature(conv.id),
  diagnostics?: Partial<DisplayProjectionWriteDiagnostics>,
): boolean {
  if (!expectedSource) return false;
  const buildStartedAt = performance.now();
  const projection = buildProjectionEntries(conv);
  const buildMs = performance.now() - buildStartedAt;

  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const dir = conversationStoreDir(conv.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const buildId = `${Date.now()}-${randomUUID()}`;
  const buildDir = join(dir, buildId);
  mkdirSync(buildDir, { recursive: true, mode: 0o700 });
  const manifestTmp = `${manifestPath(conv.id)}.${buildId}.tmp`;
  let published = false;
  try {
    const chunks: DisplayPageChunkDescriptor[] = [];
    let bytes = 0;
    const writeStartedAt = performance.now();
    for (let startIndex = 0; startIndex < projection.historyEntries.length; startIndex += CHUNK_ENTRY_COUNT) {
      const entries = projection.historyEntries.slice(startIndex, startIndex + CHUNK_ENTRY_COUNT);
      const file = `chunk-${String(chunks.length).padStart(6, "0")}.json`;
      bytes += writeJson(join(buildDir, file), {
        version: STORE_VERSION,
        startIndex,
        entries,
      } satisfies DisplayPageChunkFile);
      chunks.push({ file, startIndex, endIndex: startIndex + entries.length });
    }

    const currentSource = getConversationSourceSignature(conv.id);
    if (!currentSource || !signaturesEqual(currentSource, expectedSource)) return false;
    const manifest: DisplayPageManifest = {
      version: STORE_VERSION,
      convId: conv.id,
      buildId,
      source: expectedSource,
      provider: conv.provider,
      model: conv.model,
      effort: conv.effort,
      fastMode: conv.fastMode ?? false,
      contextTokens: conv.lastContextTokens,
      storedMessageCount: conv.messages.length,
      pinnedEntries: projection.pinnedEntries,
      historyTotalEntries: projection.historyEntries.length,
      userEntryIndices: projection.userEntryIndices,
      chunks,
    };
    bytes += writeJson(manifestTmp, manifest);
    renameSync(manifestTmp, manifestPath(conv.id));
    published = true;
    // The marker is cleanup coordination only; the atomic manifest is already
    // valid. In particular, do not retry a full build solely because ENOSPC
    // prevented creation of this zero-byte best-effort marker.
    try { writeFileSync(join(buildDir, "published"), "", { mode: 0o600 }); } catch { /* best effort */ }
    const writeMs = performance.now() - writeStartedAt;
    try { cleanupOldBuilds(conv.id); } catch { /* best effort */ }
    if (diagnostics) {
      diagnostics.buildMs = buildMs;
      diagnostics.writeMs = writeMs;
      diagnostics.entries = projection.historyEntries.length;
      diagnostics.chunks = chunks.length;
      diagnostics.bytes = bytes;
    }
    return true;
  } finally {
    try { rmSync(manifestTmp, { force: true }); } catch { /* best effort */ }
    if (!published) {
      try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function pageBounds(manifest: DisplayPageManifest, turns: number, beforeEntryIndex?: number): {
  startIndex: number;
  startUserIndex: number;
  endIndex: number;
} {
  const endIndex = Math.max(0, Math.min(
    beforeEntryIndex === undefined ? manifest.historyTotalEntries : Math.floor(beforeEntryIndex),
    manifest.historyTotalEntries,
  ));
  const usersBeforeEnd = lowerBound(manifest.userEntryIndices, endIndex);
  const safeTurns = Math.max(1, Math.floor(Number.isFinite(turns) ? turns : 1));
  const startUserIndex = Math.max(0, usersBeforeEnd - safeTurns);
  const startIndex = usersBeforeEnd > 0
    ? manifest.userEntryIndices[startUserIndex]
    : 0;
  return { startIndex, startUserIndex, endIndex };
}

function readHistoryRange(
  id: string,
  manifest: DisplayPageManifest,
  startIndex: number,
  endIndex: number,
): DisplayEntry[] {
  if (startIndex >= endIndex) return [];
  const entries: DisplayEntry[] = [];
  const buildDir = join(conversationStoreDir(id), manifest.buildId);
  for (const descriptor of manifest.chunks) {
    if (descriptor.endIndex <= startIndex || descriptor.startIndex >= endIndex) continue;
    const chunk = JSON.parse(readFileSync(join(buildDir, descriptor.file), "utf8")) as DisplayPageChunkFile;
    if (chunk.version !== STORE_VERSION || chunk.startIndex !== descriptor.startIndex || !Array.isArray(chunk.entries)) {
      throw new Error(`Invalid display page chunk for ${id}: ${descriptor.file}`);
    }
    const from = Math.max(startIndex, descriptor.startIndex) - descriptor.startIndex;
    const to = Math.min(endIndex, descriptor.endIndex) - descriptor.startIndex;
    entries.push(...chunk.entries.slice(from, to));
  }
  if (entries.length !== endIndex - startIndex) {
    throw new Error(`Incomplete display page range for ${id}: ${entries.length}/${endIndex - startIndex}`);
  }
  return entries;
}

/** Read only the compact page files overlapping the requested user-turn range. */
export function loadDisplayPage(
  id: string,
  turns: number,
  beforeEntryIndex?: number,
): StoredDisplayHistoryPage | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const source = getConversationSourceSignature(id);
    const manifest = readManifest(id);
    if (!source || !manifest || !signaturesEqual(source, manifest.source)) return null;
    const { startIndex, startUserIndex, endIndex } = pageBounds(manifest, turns, beforeEntryIndex);
    try {
      const entries = readHistoryRange(id, manifest, startIndex, endIndex);
      return {
        convId: id,
        provider: manifest.provider,
        model: manifest.model,
        effort: manifest.effort,
        fastMode: manifest.fastMode,
        contextTokens: manifest.contextTokens,
        toolOutputsIncluded: false,
        pinnedEntries: manifest.pinnedEntries,
        entries,
        startIndex,
        startUserIndex,
        endIndex,
        totalEntries: manifest.historyTotalEntries,
        hasOlder: startIndex > 0,
        source,
        storedMessageCount: manifest.storedMessageCount,
      };
    } catch {
      // A concurrent publisher can remove the generation named by the manifest
      // we just read. Reload the atomic manifest once before treating it stale.
    }
  }
  return null;
}

export function removeDisplayProjection(id: string): void {
  try { rmSync(conversationStoreDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
}
