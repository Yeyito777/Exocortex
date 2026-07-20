import { log } from "./log";
import { isWindows } from "@exocortex/shared/paths";

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

let worker: Worker | null = null;
let scheduled = false;
let enabled = false;
const pendingVersions = new Map<string, number>();
const sentVersions = new Map<string, number>();

function sendPendingIds(): void {
  if (!worker) return;
  for (const [convId, requestVersion] of pendingVersions) {
    if (sentVersions.has(convId)) continue;
    worker.postMessage({ type: "index", convId, requestVersion });
    sentVersions.set(convId, requestVersion);
  }
}

function scheduleWorkerStart(delayMs: number): void {
  if (worker || scheduled) return;
  scheduled = true;
  const timer = setTimeout(() => {
    scheduled = false;
    worker = new Worker(new URL("./display-index-worker.ts", import.meta.url).href, { type: "module" });
    (worker as Worker & { unref?: () => void }).unref?.();
    worker.onmessage = (event: MessageEvent<WorkerProgress>) => {
      const progress = event.data;
      if (progress.type === "indexed" && progress.convId) {
        if (sentVersions.get(progress.convId) === progress.requestVersion) {
          sentVersions.delete(progress.convId);
        }
        if (pendingVersions.get(progress.convId) === progress.requestVersion) {
          pendingVersions.delete(progress.convId);
        }
      }
      if (progress.error) {
        log("warn", `display pages: background index failed for ${progress.convId}: ${progress.error}`);
      }
      if (progress.type === "complete") {
        log(
          progress.failed > 0 ? "warn" : "info",
          `display pages: background index complete `
            + `(indexed=${progress.indexed}, reused=${progress.skipped}, failed=${progress.failed}, total=${progress.total}, durationMs=${progress.durationMs.toFixed(1)})`,
        );
      } else if (progress.type === "progress" && !progress.error) {
        log("info", `display pages: background index progress `
          + `(indexed=${progress.indexed}, reused=${progress.skipped}, failed=${progress.failed}, total=${progress.total})`);
      }
      sendPendingIds();
    };
    worker.onerror = (event) => {
      log("warn", `display pages: background index worker failed: ${event.message}`);
      worker = null;
      sentVersions.clear();
      if (pendingVersions.size > 0) scheduleWorkerStart(1_000);
    };
    sendPendingIds();
  }, delayMs);
  timer.unref?.();
}

/** Start one delayed, off-event-loop migration for legacy conversations. */
export function startDisplayIndexBackfill(): void {
  if (isWindows) return;
  enabled = true;
  scheduleWorkerStart(1_000);
}

/** Coalesce projection refreshes and perform them away from the daemon loop. */
export function scheduleDisplayIndex(convId: string): void {
  if (isWindows || !enabled) return;
  pendingVersions.set(convId, (pendingVersions.get(convId) ?? 0) + 1);
  scheduleWorkerStart(0);
  sendPendingIds();
}
