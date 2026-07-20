/** Background migration of legacy monolithic conversations into display pages. */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { conversationsDir } from "@exocortex/shared/paths";
import { loadForDisplayProjection } from "./persistence";
import {
  getConversationSourceSignature,
  hasFreshDisplayProjection,
  writeDisplayProjection,
} from "./display-page-store";

interface WorkerProgress {
  type: "progress" | "complete" | "indexed";
  indexed: number;
  skipped: number;
  failed: number;
  total: number;
  durationMs: number;
  convId?: string;
  error?: string;
  requestVersion?: number;
}

function post(progress: WorkerProgress): void {
  globalThis.postMessage(progress);
}

function indexConversation(id: string): { indexed: boolean; skipped: boolean; error?: string } {
  try {
    if (hasFreshDisplayProjection(id)) return { indexed: false, skipped: true };
    // A foreground canonical save can race one build. Retry from the new source
    // once; same-daemon saves are also revision-queued by the manager.
    for (let attempt = 0; attempt < 2; attempt++) {
      const sourceSignature = getConversationSourceSignature(id);
      const conversation = sourceSignature ? loadForDisplayProjection(id) : null;
      if (conversation && writeDisplayProjection(conversation, sourceSignature) && hasFreshDisplayProjection(id)) {
        return { indexed: true, skipped: false };
      }
    }
    return { indexed: false, skipped: false, error: "canonical source changed or could not be loaded" };
  } catch (err) {
    return { indexed: false, skipped: false, error: err instanceof Error ? err.message : String(err) };
  }
}

globalThis.onmessage = (event: MessageEvent<{ type: "index"; convId: string; requestVersion: number }>) => {
  if (event.data?.type !== "index" || typeof event.data.convId !== "string") return;
  const result = indexConversation(event.data.convId);
  post({
    type: "indexed",
    indexed: result.indexed ? 1 : 0,
    skipped: result.skipped ? 1 : 0,
    failed: result.error ? 1 : 0,
    total: 1,
    durationMs: performance.now() - startedAt,
    convId: event.data.convId,
    requestVersion: event.data.requestVersion,
    ...(result.error ? { error: result.error } : {}),
  });
};

const startedAt = performance.now();
const dir = conversationsDir();
let files: Array<{ id: string; mtimeMs: number }> = [];
try {
  files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const id = name.slice(0, -".json".length);
      return { id, mtimeMs: statSync(join(dir, name)).mtimeMs };
    })
    // Recent/sidebar-relevant conversations become fast first.
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
} catch {
  files = [];
}

let indexed = 0;
let skipped = 0;
let failed = 0;
for (const [index, { id }] of files.entries()) {
  const result = indexConversation(id);
  if (result.skipped) {
    skipped += 1;
  } else if (result.error) {
    failed += 1;
    post({
      type: "progress",
      indexed,
      skipped,
      failed,
      total: files.length,
      durationMs: performance.now() - startedAt,
      convId: id,
      error: result.error,
    });
  } else {
    indexed += 1;
  }
  if ((index + 1) % 100 === 0) {
    post({
      type: "progress",
      indexed,
      skipped,
      failed,
      total: files.length,
      durationMs: performance.now() - startedAt,
    });
  }
}

post({
  type: "complete",
  indexed,
  skipped,
  failed,
  total: files.length,
  durationMs: performance.now() - startedAt,
});
