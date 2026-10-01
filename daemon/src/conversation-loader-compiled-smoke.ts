/**
 * Embedded-worker smoke entry (kept beside the worker, like windows-entry.ts).
 * bun build --compile daemon/src/conversation-loader-compiled-smoke.ts \
 *   daemon/src/conversation-load-worker.ts daemon/src/conversation-schema-worker.ts --outfile /tmp/exo-loader-smoke
 * Run the executable from outside the source checkout: DB_PATH CONVERSATION_ID.
 * Or: --schema NEW_DB_PATH (writes only a previously nonexistent owned fixture).
 */
import { loadConversationOffThread, stopConversationLoader } from "./conversation-loader";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { buildConversationApiContext } from "./context-compaction";
import { currentReplayHistoryPrefix } from "./messages";
import { prepareConversationStoreSchema } from "./persistence";
import { existsSync } from "node:fs";

const [path, id] = process.argv.slice(2);
if (!path || !id) throw new Error("Expected readonly DB_PATH CONVERSATION_ID");
try {
  if (path === "--schema") {
    if (existsSync(id)) throw new Error("Refusing to overwrite an existing schema fixture");
    await prepareConversationStoreSchema(id, false);
    const store = new SqliteConversationStore({ path: id, readonly: true });
    console.log(JSON.stringify({ schemaVersion: store.diagnostics().schemaVersion, conversations: store.listSummaries().length }));
    store.close();
  } else {
  const result = await loadConversationOffThread(id, false, path);
  if (!result) throw new Error("Conversation not found");
  const store = new SqliteConversationStore({ path, readonly: true });
  if (!store.adoptLoadedConversation(result)) throw new Error("Stale generation");
  const replay = buildConversationApiContext(result.conversation, result.conversation.activeContext?.accountScope);
  console.log(JSON.stringify({
    rows: result.conversation.messages.length, archivedHeaders: result.window?.prefixSequence,
    replayMessages: replay.messages.length, hash: currentReplayHistoryPrefix(result.conversation.messages).hash,
    loadDiagnostics: result.loadDiagnostics,
  }));
  store.close();
  }
} finally { stopConversationLoader(); }
