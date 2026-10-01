/**
 * Embedded-worker smoke entry (kept beside the worker, like windows-entry.ts).
 * bun build --compile daemon/src/conversation-loader-compiled-smoke.ts \
 *   daemon/src/conversation-load-worker.ts --outfile /tmp/exo-loader-smoke
 * Run the executable from outside the source checkout: DB_PATH CONVERSATION_ID.
 */
import { loadConversationOffThread, stopConversationLoader } from "./conversation-loader";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { buildConversationApiContext } from "./context-compaction";
import { currentReplayHistoryPrefix } from "./messages";

const [path, id] = process.argv.slice(2);
if (!path || !id) throw new Error("Expected readonly DB_PATH CONVERSATION_ID");
try {
  const result = await loadConversationOffThread(id, false, path);
  if (!result) throw new Error("Conversation not found");
  const store = new SqliteConversationStore({ path, readonly: true });
  if (!store.adoptLoadedConversation(result)) throw new Error("Stale generation");
  const replay = buildConversationApiContext(result.conversation, result.conversation.activeContext?.accountScope);
  console.log(JSON.stringify({
    rows: result.conversation.messages.length, archivedHeaders: result.window?.prefixSequence,
    replayMessages: replay.messages.length, hash: currentReplayHistoryPrefix(result.conversation.messages).hash,
  }));
  store.close();
} finally { stopConversationLoader(); }
