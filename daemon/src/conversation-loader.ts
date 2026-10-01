import { sqliteConversationStorePath } from "./sqlite-conversation-store";
import { existsSync } from "node:fs";
import type { StoredMessage } from "./messages";
import type { ConversationLoadRequest, ConversationLoadResponse, ConversationLoadResult } from "./conversation-load-protocol";
import {
  archiveWindow, archiveHashesAreCurrent, archiveProofSnapshot, archiveProofSnapshotMatches, bindArchiveHashProof,
} from "./conversation-window";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, {
  resolve: (response: ConversationLoadResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export function stopConversationLoader(reason = "Conversation loader stopped"): void {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const source = new URL("./conversation-load-worker.ts", import.meta.url);
  // Bun 1.3 embeds explicitly listed worker entrypoints as .js. Source installs
  // use .ts; compiled daemon/worker entries share daemon/src as their root.
  const entry = existsSync(source) ? source : new URL("./conversation-load-worker.js", import.meta.url);
  const current = new Worker(entry.href, { type: "module" });
  (current as Worker & { unref?: () => void }).unref?.();
  current.onmessage = (event: MessageEvent<ConversationLoadResponse>) => {
    const request = pending.get(event.data.requestId);
    if (!request) return;
    pending.delete(event.data.requestId);
    clearTimeout(request.timer);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data);
  };
  current.onerror = (event) => {
    if (worker === current) stopConversationLoader(`Conversation loader failed: ${event.message}`);
  };
  worker = current;
  return current;
}

function rpc(request: Omit<Extract<ConversationLoadRequest, { type: "load" }>, "requestId">
  | Omit<Extract<ConversationLoadRequest, { type: "hash" }>, "requestId">): Promise<ConversationLoadResponse> {
  const current = getWorker();
  if (pending.size >= 128) return Promise.reject(new Error("Conversation loader queue is full"));
  const requestId = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopConversationLoader("Conversation loader timed out"), 120_000);
    pending.set(requestId, { resolve, reject, timer });
    try { current.postMessage({ ...request, requestId }); }
    catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function releaseArchiveWindow(messages: StoredMessage[], handle?: string): void {
  const key = handle ?? archiveWindow(messages)?.handle;
  if (worker && key) worker.postMessage({ type: "release", handle: key } satisfies ConversationLoadRequest);
}

export async function loadConversationOffThread(id: string, full = false, path = sqliteConversationStorePath()): Promise<ConversationLoadResult | null> {
  const response = await rpc({ type: "load", id, full, path });
  if (!("result" in response)) throw new Error("Invalid conversation loader response");
  return response.result ?? null;
}

export async function prepareArchiveHashes(messages: StoredMessage[]): Promise<void> {
  const window = archiveWindow(messages);
  if (!window) return;
  if (archiveHashesAreCurrent(messages)) return;
  const snapshot = archiveProofSnapshot(messages);
  const response = await rpc({
    type: "hash", window: {
      handle: window.handle, conversationId: window.conversationId, prefixHash: window.prefixHash,
      path: window.path,
      archivedBytes: window.archivedBytes,
      prefixSequence: window.prefixSequence, prefixHistoryCount: window.prefixHistoryCount,
    }, path: window.path, tail: messages.slice(window.prefixSequence),
  });
  if (!response.hashes) throw new Error("Invalid conversation hash response");
  if (!archiveProofSnapshotMatches(messages, snapshot)) throw new Error("Transcript changed during off-thread hashing");
  bindArchiveHashProof(messages, window, response.hashes);
}
