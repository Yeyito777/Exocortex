/**
 * Reconstruct native OpenAI checkpoints deleted by the legacy-null
 * providerData validation bug.
 *
 * The script starts from each conversation's last valid legacy-JSON checkpoint,
 * replays the exact canonical suffix to each durable compaction divider, and
 * regenerates the missing native checkpoints in bounded sequential requests.
 * It writes no canonical messages. The final active contexts are installed in
 * one SQLite transaction only after every source generation and prefix has
 * been revalidated.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildConversationApiContext,
  compactContextMessages,
  estimateContextTokens,
} from "../../daemon/src/context-compaction";
import {
  historyPrefixHash,
  isReplayHistoryMessage,
  isValidActiveContext,
  type ActiveContext,
  type Conversation,
} from "../../daemon/src/messages";
import { getCurrentAccountScope as getCurrentOpenAIAccountScope } from "../../daemon/src/providers/openai/auth";
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";

const CONTEXT_LIMIT = 372_000;
interface Boundary {
  sequence: number;
  replayHistoryCount: number;
  compactedAt: number;
}

interface RepairPlan {
  id: string;
  title: string;
  generation: number;
  storedMessageCount: number;
  currentHistoryCount: number;
  currentPrefixHash: string;
  boundaries: Boundary[];
  finalActive: ActiveContext;
  finalEstimatedTokens: number;
}

function usage(): never {
  throw new Error("Usage: bun scripts/dev/reconstruct-compaction-checkpoints.ts <output-dir> <conversation-id ...>");
}

function compactionBoundariesAfter(conv: Conversation, compactedAt: number): Boundary[] {
  const boundaries: Boundary[] = [];
  let replayHistoryCount = 0;
  for (let sequence = 0; sequence < conv.messages.length; sequence++) {
    const message = conv.messages[sequence];
    if (message.role === "system"
        && message.metadata?.kind === "context_compaction_finished"
        && message.metadata.startedAt > compactedAt) {
      boundaries.push({
        sequence,
        replayHistoryCount,
        compactedAt: message.metadata.startedAt,
      });
    }
    if (isReplayHistoryMessage(message)) replayHistoryCount += 1;
  }
  return boundaries;
}

function conversationPrefix(conv: Conversation, endSequence: number, active: ActiveContext): Conversation {
  return {
    ...conv,
    messages: conv.messages.slice(0, endSequence),
    activeContext: active,
  };
}

function assertNoImagesOrNullProviderData(active: ActiveContext): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "image") throw new Error("Repair replay unexpectedly contains an image");
    for (const item of Object.values(record)) visit(item);
  };
  for (const message of active.messages) {
    if (message.providerData === null) throw new Error("Repair retained explicit-null providerData");
    visit(message.content);
  }
}

async function reconstructConversation(
  conv: Conversation,
  legacyActive: ActiveContext,
  generation: number,
  storedMessageCount: number,
  outputDir: string,
  accountScope: string,
): Promise<RepairPlan> {
  if (!isValidActiveContext(legacyActive, conv.messages)) {
    throw new Error(`${conv.id}: legacy checkpoint does not match the SQLite transcript prefix`);
  }
  if (legacyActive.provider !== "openai" || legacyActive.model !== conv.model
      || legacyActive.accountScope !== accountScope) {
    throw new Error(`${conv.id}: legacy checkpoint provider/model/account scope is incompatible`);
  }

  const boundaries = compactionBoundariesAfter(conv, legacyActive.compactedAt);
  if (boundaries.length === 0) throw new Error(`${conv.id}: no missing compaction boundaries found`);

  let active = structuredClone(legacyActive);
  console.log(`${conv.id} (${conv.title}): reconstructing ${boundaries.length} checkpoint(s)`);
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index];
    const prefix = conversationPrefix(conv, boundary.sequence, active);
    if (!isValidActiveContext(active, prefix.messages)) {
      throw new Error(`${conv.id}: checkpoint ${index} is invalid before boundary ${boundary.compactedAt}`);
    }
    const replay = buildConversationApiContext(prefix, accountScope);
    if (!replay.usedActiveContext) throw new Error(`${conv.id}: failed to use checkpoint ${index}`);
    const estimatedTokens = estimateContextTokens(replay.messages, "openai");
    if (estimatedTokens >= CONTEXT_LIMIT) {
      throw new Error(`${conv.id}: boundary ${index + 1} replay is unexpectedly oversized (${estimatedTokens})`);
    }
    console.log(`  ${index + 1}/${boundaries.length}: ${replay.messages.length} messages, ~${estimatedTokens} tokens`);

    const result = await compactContextMessages(replay.messages, {
      provider: "openai",
      model: conv.model,
      effort: conv.effort,
      accountScope,
      contextLimit: CONTEXT_LIMIT,
      reason: "manual",
      system: "Regenerate a faithful native continuation checkpoint from the verified prior checkpoint and exact canonical transcript tail. Do not answer or continue the task.",
      promptCacheKey: `repair-${conv.id}-${index + 1}`,
      codexWindowId: active.windowId,
      onNativeRetry(attempt, maxAttempts, message) {
        console.warn(`  retry ${attempt}/${maxAttempts}: ${message}`);
      },
      onPlaintextFallback(warning) {
        console.warn(`  ${warning}`);
      },
    });
    if (result.kind !== "openai_native") {
      throw new Error(`${conv.id}: boundary ${index + 1} did not produce a native OpenAI checkpoint`);
    }

    const windowNumber = active.windowNumber + 1;
    const prefixHash = historyPrefixHash(conv.messages, boundary.replayHistoryCount);
    const candidate: ActiveContext = {
      version: 1,
      kind: result.kind,
      provider: "openai",
      model: conv.model,
      accountScope: result.accountScope ?? accountScope,
      messages: result.messages,
      transcriptHistoryCount: boundary.replayHistoryCount,
      transcriptPrefixHash: prefixHash,
      compactionHistoryCount: boundary.replayHistoryCount,
      compactionPrefixHash: prefixHash,
      windowId: `${conv.id}:${windowNumber}`,
      windowNumber,
      compactedAt: boundary.compactedAt,
      compactionCount: active.compactionCount + 1,
    };
    assertNoImagesOrNullProviderData(candidate);
    if (!isValidActiveContext(candidate, prefix.messages)) {
      throw new Error(`${conv.id}: regenerated checkpoint ${index + 1} failed integrity validation`);
    }
    active = candidate;
    const stagePath = join(outputDir, `${conv.id}.stage-${index + 1}.json`);
    writeFileSync(stagePath, `${JSON.stringify(active)}\n`, { mode: 0o600 });
  }

  // Preserve the exact post-compaction tail in the active replay. This makes
  // the repaired conversation immediately usable even by the currently running
  // pre-fix daemon, and retains the modern fixed compaction boundary for rewind.
  const fullReplay = buildConversationApiContext({ ...conv, activeContext: active }, accountScope);
  if (!fullReplay.usedActiveContext) throw new Error(`${conv.id}: final checkpoint was not selected`);
  const currentHistoryCount = conv.messages.filter(isReplayHistoryMessage).length;
  const currentPrefixHash = historyPrefixHash(conv.messages, currentHistoryCount);
  const finalActive: ActiveContext = {
    ...active,
    messages: fullReplay.messages,
    transcriptHistoryCount: currentHistoryCount,
    transcriptPrefixHash: currentPrefixHash,
  };
  assertNoImagesOrNullProviderData(finalActive);
  if (!isValidActiveContext(finalActive, conv.messages)) {
    throw new Error(`${conv.id}: final tail-extended checkpoint failed integrity validation`);
  }
  const expectedTail = currentHistoryCount - (finalActive.compactionHistoryCount ?? currentHistoryCount);
  if (expectedTail !== fullReplay.tailMessages.length) {
    throw new Error(`${conv.id}: tail mapping mismatch (${expectedTail} != ${fullReplay.tailMessages.length})`);
  }
  const finalEstimatedTokens = estimateContextTokens(finalActive.messages, "openai");
  if (finalEstimatedTokens >= CONTEXT_LIMIT) {
    throw new Error(`${conv.id}: repaired current replay remains oversized (${finalEstimatedTokens})`);
  }
  writeFileSync(join(outputDir, `${conv.id}.final.json`), `${JSON.stringify(finalActive)}\n`, { mode: 0o600 });
  console.log(`  final: ${finalActive.messages.length} messages, ~${finalEstimatedTokens} tokens`);

  return {
    id: conv.id,
    title: conv.title,
    generation,
    storedMessageCount,
    currentHistoryCount,
    currentPrefixHash,
    boundaries,
    finalActive,
    finalEstimatedTokens,
  };
}

const outputDirArg = process.argv[2];
if (!outputDirArg) usage();
const outputDir = resolve(outputDirArg);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
chmodSync(outputDir, 0o700);
const ids = process.argv.slice(3);
if (ids.length === 0) usage();
const targetIds = ids;
const dataRoot = resolve(import.meta.dir, "../../config/data");
const databasePath = join(dataRoot, "exocortex.sqlite3");
const accountScope = getCurrentOpenAIAccountScope();
if (!accountScope) throw new Error("No current OpenAI account scope is available");

const repository = new SqliteConversationStore({ path: databasePath, readonly: true });
const sourceDb = new Database(databasePath, { readonly: true });
const plans: RepairPlan[] = [];
try {
  for (const id of targetIds) {
    const row = sourceDb.query<{
      storage_generation: number;
      stored_message_count: number;
    }, [string]>("SELECT storage_generation, stored_message_count FROM conversations WHERE id=? AND deleted_at IS NULL").get(id);
    if (!row) throw new Error(`${id}: conversation not found`);
    const existing = sourceDb.query("SELECT 1 FROM active_contexts WHERE conversation_id=?").get(id);
    if (existing) throw new Error(`${id}: active context already exists; refusing to overwrite it`);
    const conv = repository.load(id, true);
    if (!conv) throw new Error(`${id}: failed to load canonical conversation`);
    const legacy = JSON.parse(readFileSync(join(dataRoot, "conversations", `${id}.json`), "utf8")) as Conversation;
    if (!legacy.activeContext) throw new Error(`${id}: legacy snapshot has no active checkpoint`);
    plans.push(await reconstructConversation(
      conv,
      legacy.activeContext,
      row.storage_generation,
      row.stored_message_count,
      outputDir,
      accountScope,
    ));
  }
} finally {
  repository.close();
  sourceDb.close();
}

const writable = new Database(databasePath);
writable.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
try {
  writable.transaction(() => {
    for (const plan of plans) {
      const current = writable.query<{
        storage_generation: number;
        stored_message_count: number;
      }, [string]>("SELECT storage_generation, stored_message_count FROM conversations WHERE id=?").get(plan.id);
      if (!current || current.storage_generation !== plan.generation
          || current.stored_message_count !== plan.storedMessageCount) {
        throw new Error(`${plan.id}: canonical conversation changed during reconstruction`);
      }
      if (writable.query("SELECT 1 FROM active_contexts WHERE conversation_id=?").get(plan.id)) {
        throw new Error(`${plan.id}: an active context appeared during reconstruction`);
      }
      const active = plan.finalActive;
      writable.query(`
        INSERT INTO active_contexts(
          conversation_id, kind, provider, model, transcript_history_count,
          transcript_prefix_hash, compaction_history_count, compaction_prefix_hash,
          window_id, window_number, compacted_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.id,
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
      writable.query("UPDATE conversations SET last_context_tokens=NULL WHERE id=?").run(plan.id);
    }
  })();
} finally {
  writable.close();
}

const manifest = plans.map(({ finalActive: _active, ...plan }) => plan);
writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Installed ${plans.length} repaired active context(s) atomically.`);
