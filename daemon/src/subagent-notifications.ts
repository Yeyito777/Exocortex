/**
 * Durable detached-subagent completion notifications.
 *
 * The running child -> parent relationship cannot live only in a Promise
 * callback: that callback disappears when the daemon restarts. This sidecar is
 * written before a detached child starts, transitions to `ready` when the child
 * outcome is known, and is removed only after the notification user message is
 * durably present in the parent's transcript.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { dataDir } from "@exocortex/shared/paths";
import type { ParentNotificationTarget } from "./protocol";
import { MAX_EXO_SUBAGENT_DEPTH, type Block } from "./messages";
import * as convStore from "./conversations";
import { log } from "./log";

const FILE_VERSION = 1;

export interface PendingSubagentNotification {
  id: string;
  childConvId: string;
  parentConvId: string;
  task: string;
  maxChars?: number;
  childStartedAt: number;
  subagentMaxDepth: number | null;
  state: "running" | "ready";
  /** Complete model-visible parent prompt. Present only when state=ready. */
  text?: string;
  createdAt: number;
  updatedAt: number;
}

interface PendingSubagentNotificationsFile {
  version: typeof FILE_VERSION;
  updatedAt: number;
  notifications: PendingSubagentNotification[];
}

export interface SubagentNotificationOutcome {
  ok: boolean;
  blocks: Block[];
  error?: string;
  aborted?: boolean;
  watchdog?: boolean;
  /** True only for the intentional abort used to hand a stream to a new daemon. */
  daemonRestart?: boolean;
}

export interface SubagentNotificationRuntime {
  begin(
    parent: ParentNotificationTarget,
    childConvId: string,
    task: string,
    childStartedAt: number,
    subagentMaxDepth: number | null,
  ): PendingSubagentNotification;
  complete(childConvId: string, outcome: SubagentNotificationOutcome): void;
  deliverReady(childConvId?: string): void;
}

const notifications = new Map<string, PendingSubagentNotification>();
const runtimeByServer = new WeakMap<object, SubagentNotificationRuntime>();
let loaded = false;

export function pendingSubagentNotificationsPath(): string {
  return join(dataDir(), "subagent-notifications.json");
}

function normalizeRecord(raw: unknown): PendingSubagentNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<PendingSubagentNotification>;
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  if (typeof record.childConvId !== "string" || !record.childConvId.trim()) return null;
  if (typeof record.parentConvId !== "string" || !record.parentConvId.trim()) return null;
  if (typeof record.task !== "string") return null;
  if (record.state !== "running" && record.state !== "ready") return null;
  if (!Number.isFinite(record.childStartedAt) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) return null;
  if (record.state === "ready" && typeof record.text !== "string") return null;

  const maxChars = typeof record.maxChars === "number" && Number.isFinite(record.maxChars) && record.maxChars > 0
    ? Math.floor(record.maxChars)
    : undefined;
  const subagentMaxDepth = typeof record.subagentMaxDepth === "number"
    && Number.isInteger(record.subagentMaxDepth)
    && record.subagentMaxDepth >= 0
    && record.subagentMaxDepth <= MAX_EXO_SUBAGENT_DEPTH
      ? record.subagentMaxDepth
      : null;
  return {
    id: record.id,
    childConvId: record.childConvId,
    parentConvId: record.parentConvId,
    task: record.task,
    ...(maxChars ? { maxChars } : {}),
    childStartedAt: Number(record.childStartedAt),
    subagentMaxDepth,
    state: record.state,
    ...(record.state === "ready" ? { text: record.text! } : {}),
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
  };
}

export function reloadPendingSubagentNotifications(): PendingSubagentNotification[] {
  notifications.clear();
  loaded = true;
  const path = pendingSubagentNotificationsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<PendingSubagentNotificationsFile>;
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.notifications)) {
      throw new Error("unsupported version or missing notifications array");
    }
    for (const raw of parsed.notifications) {
      const record = normalizeRecord(raw);
      if (record) notifications.set(record.id, record);
    }
  } catch (err) {
    log("error", `subagent notifications: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return listPendingSubagentNotifications();
}

function ensureLoaded(): void {
  if (!loaded) reloadPendingSubagentNotifications();
}

function save(): void {
  const path = pendingSubagentNotificationsPath();
  if (notifications.size === 0) {
    try { unlinkSync(path); } catch { /* absent */ }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const file: PendingSubagentNotificationsFile = {
    version: FILE_VERSION,
    updatedAt: Date.now(),
    notifications: [...notifications.values()],
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function listPendingSubagentNotifications(
  options: { childConvId?: string; state?: PendingSubagentNotification["state"] } = {},
): PendingSubagentNotification[] {
  ensureLoaded();
  return [...notifications.values()]
    .filter((record) => !options.childConvId || record.childConvId === options.childConvId)
    .filter((record) => !options.state || record.state === options.state)
    .map((record) => ({ ...record }));
}

export function beginPendingSubagentNotification(
  parent: ParentNotificationTarget,
  childConvId: string,
  task: string,
  childStartedAt: number,
  subagentMaxDepth: number | null,
): PendingSubagentNotification {
  ensureLoaded();
  const alreadyRunning = [...notifications.values()].find((record) =>
    record.childConvId === childConvId && record.state === "running"
  );
  if (alreadyRunning) {
    if (alreadyRunning.parentConvId === parent.convId && alreadyRunning.childStartedAt === childStartedAt) {
      return { ...alreadyRunning };
    }
    throw new Error(`Subagent ${childConvId} already has an interrupted parent notification pending; replay or abort it before starting another detached task.`);
  }

  const now = Date.now();
  const record: PendingSubagentNotification = {
    id: `${childConvId}:${childStartedAt}:${Math.random().toString(36).slice(2, 10)}`,
    childConvId,
    parentConvId: parent.convId,
    task,
    ...(typeof parent.maxChars === "number" && parent.maxChars > 0 ? { maxChars: Math.floor(parent.maxChars) } : {}),
    childStartedAt,
    subagentMaxDepth,
    state: "running",
    createdAt: now,
    updatedAt: now,
  };
  notifications.set(record.id, record);
  save();
  return { ...record };
}

function textFromBlocks(blocks: Block[]): string {
  return blocks
    .filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

export function buildSubagentNotificationText(
  record: PendingSubagentNotification,
  outcome: SubagentNotificationOutcome,
): string {
  const title = (convStore.get(record.childConvId)?.title || record.task.split("\n")[0] || "subagent task").trim();
  const body = outcome.ok
    ? (textFromBlocks(outcome.blocks) || "(subagent completed without text output)")
    : (outcome.error || "Subagent did not complete successfully.");
  const status = outcome.ok ? "completed" : "failed";
  const section = outcome.ok ? "Result" : "Error";
  return [
    `[notification] Subagent ${status}: exo:${record.childConvId}`,
    `Task: ${capText(title, 160)}`,
    "",
    `${section}:`,
    capText(body, record.maxChars ?? 6000),
    "",
    "Full details:",
    `Use the native exo tool with action=history, conversation_id=${record.childConvId}, full=true.`,
  ].join("\n");
}

/**
 * Atomically settle every running notification associated with one child.
 * Daemon-restart aborts deliberately remain running for replay by the next
 * process; user aborts cancel the notification; all other outcomes become ready.
 */
export function settlePendingSubagentNotifications(
  childConvId: string,
  outcome: SubagentNotificationOutcome,
): { ready: PendingSubagentNotification[]; removed: PendingSubagentNotification[] } {
  ensureLoaded();
  const running = [...notifications.values()].filter((record) =>
    record.childConvId === childConvId && record.state === "running"
  );
  if (running.length === 0 || (outcome.aborted && outcome.daemonRestart)) {
    return { ready: [], removed: [] };
  }

  if (outcome.aborted && !outcome.watchdog) {
    for (const record of running) notifications.delete(record.id);
    save();
    return { ready: [], removed: running.map((record) => ({ ...record })) };
  }

  const now = Date.now();
  const ready = running.map((record): PendingSubagentNotification => ({
    ...record,
    state: "ready",
    text: buildSubagentNotificationText(record, outcome),
    updatedAt: now,
  }));
  for (const record of ready) notifications.set(record.id, record);
  save();
  return { ready: ready.map((record) => ({ ...record })), removed: [] };
}

export function acknowledgeSubagentNotification(notificationId: string): boolean {
  ensureLoaded();
  if (!notifications.delete(notificationId)) return false;
  save();
  return true;
}

/** Explicit daemon stop cancels all autonomous post-start delivery/recovery. */
export function clearPendingSubagentNotifications(): number {
  ensureLoaded();
  const count = notifications.size;
  if (count === 0) return 0;
  notifications.clear();
  save();
  return count;
}

export function removePendingSubagentNotificationsForConversation(convId: string): number {
  ensureLoaded();
  const ids = [...notifications.values()]
    .filter((record) => record.childConvId === convId || record.parentConvId === convId)
    .map((record) => record.id);
  for (const id of ids) notifications.delete(id);
  if (ids.length > 0) save();
  return ids.length;
}

/** True once the original detached task is durably present in child history. */
export function hasSubagentTaskStarted(record: PendingSubagentNotification): boolean {
  return convStore.get(record.childConvId)?.messages.some((message) => {
    if (message.role !== "user"
        || message.metadata?.system === true
        || message.metadata?.startedAt !== record.childStartedAt) return false;
    if (typeof message.content === "string") return message.content === record.task;
    return message.content.some((block) => block.type === "text" && block.text === record.task);
  }) ?? false;
}

/**
 * Recover the narrow crash window where the child response reached its durable
 * transcript but the Promise callback/sidecar transition did not run. Partial
 * restart-aborted responses have a later ✗ system marker and are not accepted.
 */
export function completedSubagentOutcomeFromHistory(
  record: PendingSubagentNotification,
): SubagentNotificationOutcome | null {
  if (!hasSubagentTaskStarted(record)) return null;
  const messages = convStore.get(record.childConvId)?.messages;
  if (!messages) return null;
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant"
        && message.metadata?.startedAt === record.childStartedAt
        && message.metadata.endedAt != null) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return null;
  const interruptedAfterAssistant = messages.slice(assistantIndex + 1).some((message) =>
    message.role === "system"
    && typeof message.content === "string"
    && message.content.startsWith("✗")
  );
  if (interruptedAfterAssistant) return null;

  const content = messages[assistantIndex].content;
  const blocks: Block[] = typeof content === "string"
    ? (content ? [{ type: "text", text: content }] : [])
    : content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => ({ type: "text" as const, text: block.text }));
  return { ok: true, blocks };
}

/** Crash-window dedupe: notification was accepted even if its sidecar ack was interrupted. */
export function hasSubagentNotificationBeenDelivered(record: PendingSubagentNotification): boolean {
  return convStore.get(record.parentConvId)?.messages.some((message) =>
    message.role === "user" && message.metadata?.subagentNotificationId === record.id
  ) ?? false;
}

export function registerSubagentNotificationRuntime(server: object, runtime: SubagentNotificationRuntime): void {
  runtimeByServer.set(server, runtime);
}

export function getSubagentNotificationRuntime(server: object): SubagentNotificationRuntime | undefined {
  return runtimeByServer.get(server);
}

/** Test-only state reset. */
export function resetPendingSubagentNotificationsForTest(): void {
  notifications.clear();
  loaded = true;
  try { unlinkSync(pendingSubagentNotificationsPath()); } catch { /* absent */ }
}
