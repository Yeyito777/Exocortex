import { sqliteConversationStorePath } from "./sqlite-conversation-store";
import { existsSync } from "node:fs";
import { performanceProfilingEnabled } from "@exocortex/shared/config";
import { log } from "./log";
import type { StoredMessage } from "./messages";
import type { ConversationLoadRequest, ConversationLoadResponse, ConversationLoadResult } from "./conversation-load-protocol";
import {
  archiveWindow, archiveHashesAreCurrent, archiveProofSnapshot, archiveProofSnapshotMatches, bindArchiveHashProof,
} from "./conversation-window";

// Two bounded lanes prevent one large archive from serializing all admission.
// Background warming uses lane 1; hashes retain their native-state owner.
const workers: Array<Worker | null> = [null, null];
const affinity = new Map<string, number>();
const owners = new Map<string, number>();
const activeLoads = new Map<string, number>();
const PROFILE_RUNTIME_LOADS = performanceProfilingEnabled();
let nextId = 0;
let prewarmTimer: ReturnType<typeof setTimeout> | undefined;
let backgroundKey: string | null = null;
const pending = new Map<number, {
  lane: number; resolve: (response: ConversationLoadResponse) => void;
  reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
}>();

function stopLane(lane: number, reason: string) {
  workers[lane]?.terminate(); workers[lane] = null;
  for (const [id, request] of pending) if (request.lane === lane) {
    clearTimeout(request.timer); request.reject(new Error(reason)); pending.delete(id);
  }
  for (const [handle, owner] of owners) if (owner === lane) owners.delete(handle);
  for (const [key, owner] of affinity) if (owner === lane) affinity.delete(key);
}
export function stopConversationLoader(reason = "Conversation loader stopped"): void {
  clearTimeout(prewarmTimer); prewarmTimer = undefined;
  for (let lane = 0; lane < workers.length; lane++) stopLane(lane, reason);
}
function getWorker(lane: number): Worker {
  if (workers[lane]) return workers[lane]!;
  const source = new URL("./conversation-load-worker.ts", import.meta.url);
  // Bun embeds explicit worker entrypoints as .js; source installs use .ts.
  const entry = existsSync(source) ? source : new URL("./conversation-load-worker.js", import.meta.url);
  const current = new Worker(entry.href, { type: "module" });
  (current as Worker & { unref?: () => void }).unref?.();
  current.onmessage = (event: MessageEvent<ConversationLoadResponse>) => {
    const request = pending.get(event.data.requestId);
    if (!request || request.lane !== lane || workers[lane] !== current) return;
    pending.delete(event.data.requestId); clearTimeout(request.timer);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data);
  };
  current.onerror = event => {
    if (workers[lane] === current) stopLane(lane, `Conversation loader failed: ${event.message}`);
  };
  workers[lane] = current;
  return current;
}
type Rpc = Omit<Extract<ConversationLoadRequest, { type: "load" }>, "requestId">
  | Omit<Extract<ConversationLoadRequest, { type: "hash" }>, "requestId">
  | Omit<Extract<ConversationLoadRequest, { type: "prefetch" }>, "requestId">
  | Omit<Extract<ConversationLoadRequest, { type: "tools" }>, "requestId">;
function rpc(request: Rpc, lane: number): Promise<ConversationLoadResponse> {
  if (pending.size >= 128) return Promise.reject(new Error("Conversation loader queue is full"));
  const current = getWorker(lane), requestId = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopLane(lane, "Conversation loader timed out"), 120_000);
    pending.set(requestId, { lane, resolve, reject, timer });
    try { current.postMessage({ ...request, requestId }); }
    catch (error) {
      pending.delete(requestId); clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
function keyFor(path: string, id: string) { return JSON.stringify([path, id]); }
function rememberLane(key: string, lane: number) {
  affinity.delete(key); affinity.set(key, lane);
  while (affinity.size > 64) affinity.delete(affinity.keys().next().value!);
}
function chooseLane(key: string) {
  const counts = workers.map((_, lane) => [...pending.values()].filter(request => request.lane === lane).length);
  const owner = affinity.get(key);
  if (owner !== undefined && (counts[owner] === 0 || activeLoads.has(key) || backgroundKey === key)) return owner;
  return counts[0] <= counts[1] ? 0 : 1;
}
export function releaseArchiveWindow(messages: StoredMessage[], handle?: string): void {
  const key = handle ?? archiveWindow(messages)?.handle;
  if (!key) return;
  const lane = owners.get(key);
  if (lane !== undefined && workers[lane]) workers[lane]!.postMessage({ type: "release", handle: key } satisfies ConversationLoadRequest);
  owners.delete(key);
}
export async function loadConversationOffThread(id: string, full = false, path = sqliteConversationStorePath()): Promise<ConversationLoadResult | null> {
  const key = keyFor(path, id), lane = chooseLane(key);
  rememberLane(key, lane);
  activeLoads.set(key, (activeLoads.get(key) ?? 0) + 1);
  try {
    const response = await rpc({ type: "load", id, full, path }, lane);
    if (!("result" in response)) throw new Error("Invalid conversation loader response");
    if (response.result?.window) owners.set(response.result.window.handle, lane);
    return response.result ?? null;
  } finally {
    const count = (activeLoads.get(key) ?? 1) - 1;
    if (count) activeLoads.set(key, count); else activeLoads.delete(key);
  }
}
/** Bounded readonly speculation. No foreground state, provider, write or title job. */
export async function prefetchConversation(id: string, path = sqliteConversationStorePath()): Promise<boolean> {
  const key = keyFor(path, id);
  if (backgroundKey || activeLoads.has(key)) return false;
  backgroundKey = key;
  rememberLane(key, 1);
  try {
    const response = await rpc({ type: "prefetch", id, path }, 1);
    return "warmed" in response && response.warmed === true;
  } finally { if (backgroundKey === key) backgroundKey = null; }
}
export async function loadToolOutputsOffThread(id: string, toolCallIds?: readonly string[], path = sqliteConversationStorePath()) {
  const response = await rpc({ type: "tools", id, toolCallIds, path }, chooseLane(keyFor(path, id)));
  if (!("outputs" in response)) throw new Error("Invalid verified archive output response");
  return response.outputs;
}
/** Debounce sidebar hopping; never proactively scan the corpus at startup. */
export function scheduleConversationPrewarm(id: string): void {
  clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(() => {
    prewarmTimer = undefined;
    const started = performance.now();
    void prefetchConversation(id).then(warmed => {
      if (PROFILE_RUNTIME_LOADS) log("info", `perf: conversation_runtime_prefetch ${JSON.stringify({
        convId: id, warmed, durationMs: Math.round((performance.now() - started) * 100) / 100,
      })}`);
    }).catch(() => {}); // speculation must not fail a display open
  }, 120);
  prewarmTimer.unref?.();
}
export async function prepareArchiveHashes(messages: StoredMessage[]): Promise<void> {
  const window = archiveWindow(messages);
  if (!window || archiveHashesAreCurrent(messages)) return;
  const snapshot = archiveProofSnapshot(messages);
  const lane = owners.get(window.handle) ?? 0;
  const response = await rpc({
    type: "hash", window: {
      handle: window.handle, conversationId: window.conversationId, prefixHash: window.prefixHash,
      path: window.path, archivedBytes: window.archivedBytes,
      prefixSequence: window.prefixSequence, prefixHistoryCount: window.prefixHistoryCount,
      hashAnchor: window.hashAnchor,
    }, path: window.path, tail: messages.slice(window.prefixSequence),
  }, lane);
  if (!response.hashes) throw new Error("Invalid conversation hash response");
  if (!archiveProofSnapshotMatches(messages, snapshot)) throw new Error("Transcript changed during off-thread hashing");
  owners.set(window.handle, lane);
  bindArchiveHashProof(messages, window, response.hashes);
}
