/** Startup-only writes: transactionally migrate/enroll checksums off the IPC thread. */
import { SqliteConversationStore } from "./sqlite-conversation-store";
globalThis.onmessage = (event: MessageEvent<{ path: string; importLegacy: boolean }>) => {
  let store: SqliteConversationStore | undefined;
  try {
    store = new SqliteConversationStore({ path: event.data.path });
    if (event.data.importLegacy) {
      const result = store.importLegacyIfNeeded();
      if (result.status === "incomplete") throw new Error(`Legacy import incomplete (${result.skipped.length} conversations)`);
    }
    store.close(); store = undefined;
    globalThis.postMessage({ ok: true });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally { store?.close(); }
};
