#!/usr/bin/env bun
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../shared/src/paths";
import * as conversations from "../../daemon/src/conversations";
import {
  checkConversationStoreIntegrity,
  closeConversationPersistence,
  conversationPersistenceBackend,
  sqliteConversationStorePath,
  SqliteConversationStore,
} from "../../daemon/src/persistence";
import { cancelChronoSchedule, createChronoSchedule, stopChronoService } from "../../daemon/src/chrono-service";

interface StepResult { step: string; ok: boolean; durationMs: number; detail?: string }
const results: StepResult[] = [];

async function step(name: string, operation: () => unknown | Promise<unknown>): Promise<void> {
  const started = performance.now();
  try {
    const value = await operation();
    if (value === false || value === null) throw new Error(`operation returned ${String(value)}`);
    results.push({ step: name, ok: true, durationMs: performance.now() - started });
  } catch (error) {
    results.push({ step: name, ok: false, durationMs: performance.now() - started, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

if (conversationPersistenceBackend() !== "sqlite") throw new Error("Run without EXOCORTEX_CONVERSATION_STORE=json; this scenario requires canonical SQLite");
const prefix = `sqlite-smoke-${Date.now()}`;
const primary = `${prefix}-primary`;
const sibling = `${prefix}-sibling`;
const queueA = `${prefix}-queue-a`;
const queueB = `${prefix}-queue-b`;
let cloneId = "";
let folderId = "";
let recursiveFolderId = "";
let recursiveChildId = "";
let unwrapFolderId = "";
let unwrapChildId = "";
let chronoId = "";

await step("startup indexed summaries", () => {
  const stats = conversations.loadFromDisk();
  if (stats.total < 20) throw new Error(`expected copied fixture plus synthetic data, got ${stats.total}`);
});
await step("create empty conversation", () => conversations.create(sibling, "openai", "gpt-5.6-sol", "Sibling"));
await step("create with initial user message atomically", () => conversations.createWithInitialUserMessage(
  primary, "openai", "gpt-5.6-sol", "Pending", "medium", false,
  { text: "initial", startedAt: Date.now() },
));
await step("append user assistant and tool round", () => {
  const conv = requireValue(conversations.get(primary), "primary missing");
  conv.messages.push(
    { role: "assistant", content: "answer one", metadata: null },
    { role: "user", content: "use a tool", metadata: null },
    { role: "assistant", content: [{ type: "tool_use", id: `${prefix}-tool`, name: "bash", input: { command: "printf smoke" } }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `${prefix}-tool`, content: "smoke output", is_error: false }], metadata: null },
    { role: "assistant", content: "tool complete", metadata: null },
    { role: "user", content: "third turn", metadata: null },
    { role: "assistant", content: "third answer", metadata: null },
  );
  conv.updatedAt = Date.now();
  conversations.markDirty(primary);
  conversations.flush(primary);
  if (conversations.getToolOutputs(primary)?.[0]?.output !== "smoke output") throw new Error("deferred tool output mismatch");
});
await step("recent and older history pages", () => {
  const newest = requireValue(conversations.getStoredDisplayPage(primary, 1), "newest page missing");
  if (!newest.hasOlder) throw new Error("newest page should have older history");
  const older = requireValue(conversations.getStoredDisplayPage(primary, 2, newest.startIndex), "older page missing");
  if (older.entries.length === 0) throw new Error("older page empty");
});
await step("rename mark pin and sidebar move", () => {
  if (!conversations.rename(primary, "SQLite smoke renamed")) throw new Error("rename failed");
  if (!conversations.mark(primary, true) || !conversations.mark(primary, false)) throw new Error("mark failed");
  if (!conversations.pin(primary, true) || !conversations.pin(primary, false)) throw new Error("pin failed");
  if (!conversations.move(primary, "down") && !conversations.move(primary, "up")) throw new Error("move failed");
});
await step("model effort and fast mode", () => {
  if (!conversations.setModel(primary, "deepseek", "deepseek-v4-pro", "high", false)) throw new Error("model failed");
  if (!conversations.setEffort(primary, "medium")) throw new Error("effort failed");
  if (!conversations.setFastMode(primary, true)) throw new Error("fast mode failed");
  if (!conversations.setModel(primary, "openai", "gpt-5.6-sol", "high", false)) throw new Error("model restore failed");
});
await step("conversation system instructions", () => {
  if (!conversations.setSystemInstructions(primary, "Synthetic instructions")) throw new Error("set failed");
  if (conversations.getSystemInstructions(primary) !== "Synthetic instructions") throw new Error("instruction mismatch");
  if (!conversations.setSystemInstructions(primary, "")) throw new Error("clear failed");
});
await step("create rename pin folder and inherited instructions", () => {
  const folder = requireValue(conversations.createFolder("SQLite Smoke Folder"), "folder create failed");
  folderId = folder.id;
  if (!conversations.renameFolder(folderId, "SQLite Smoke Renamed Folder")) throw new Error("folder rename failed");
  if (!conversations.pinFolder(folderId, true) || !conversations.pinFolder(folderId, false)) throw new Error("folder pin failed");
  if (!conversations.setFolderInstructions(folderId, "Inherited synthetic instructions")) throw new Error("folder instructions failed");
  if (!conversations.moveConversationToFolder(primary, folderId)) throw new Error("move into folder failed");
  if (!conversations.getEffectiveSystemInstructions(primary)?.includes("Inherited synthetic instructions")) throw new Error("inheritance missing");
  if (!conversations.moveConversationToFolder(primary, null)) throw new Error("move out failed");
});
await step("goal lifecycle", () => {
  if (!conversations.setGoal(primary, "Synthetic goal", { pausable: true, completable: true })) throw new Error("set goal failed");
  if (conversations.updateGoalStatus(primary, "paused")?.status !== "paused") throw new Error("pause failed");
  if (conversations.updateGoalStatus(primary, "active")?.status !== "active") throw new Error("resume failed");
  if (!conversations.incrementGoalTurns(primary)) throw new Error("turn increment failed");
  if (conversations.updateGoalStatus(primary, "complete")?.status !== "complete") throw new Error("complete failed");
  if (!conversations.clearGoal(primary)) throw new Error("clear failed");
});
await step("durable queue CRUD and ordering", () => {
  conversations.clearAllQueuedMessages();
  conversations.pushQueuedMessage(primary, "one", "next-turn", undefined, undefined, undefined, queueA);
  conversations.pushQueuedMessage(primary, "two", "message-end", undefined, undefined, undefined, queueB);
  if (!conversations.updateQueuedMessage(queueA, "one edited", "message-end")) throw new Error("queue update failed");
  if (!conversations.moveQueuedMessage(queueB, "up")) throw new Error("queue move failed");
  conversations.persistQueuedMessagesSnapshot();
  if (conversations.listQueuedMessages()[0]?.id !== queueB) throw new Error("queue order mismatch");
  if (!conversations.removeQueuedMessageById(queueA) || !conversations.removeQueuedMessageById(queueB)) throw new Error("queue removal failed");
});
await step("clone independent history", () => {
  const cloned = requireValue(conversations.clone(primary), "clone failed");
  cloneId = cloned.id;
  cloned.messages.push({ role: "user", content: "clone only", metadata: null });
  conversations.markDirty(cloneId);
  conversations.flush(cloneId);
  if (conversations.get(primary)?.messages.some((message) => message.content === "clone only")) throw new Error("clone aliased source");
});
await step("trim tool/thinking/history", () => {
  const result = requireValue(conversations.trimConversation(cloneId, "messages", 1), "trim failed");
  if (!result.changed) throw new Error("trim made no change");
});
await step("rewind by stable user identity", async () => {
  const before = requireValue(conversations.getSummary(primary), "summary missing").messageCount;
  const result = requireValue(await conversations.unwindTo(primary, 1, `${prefix}-unwind`), "unwind failed");
  if (result.summary.messageCount >= before) throw new Error("unwind did not cut history");
});
await step("unread and external inbox", () => {
  conversations.markUnread(primary);
  if (!conversations.isUnread(primary)) throw new Error("unread mark failed");
  if (!conversations.appendExternalInboxNotification(primary, "Synthetic inbox event")) throw new Error("inbox append failed");
  if (!conversations.clearUnread(primary)) throw new Error("unread clear failed");
});
await step("delete undo redo restore", () => {
  if (!conversations.remove(cloneId)) throw new Error("delete failed");
  if (conversations.undoDelete()?.type !== "conversation") throw new Error("undo delete failed");
  if (conversations.redoDelete()?.type !== "sidebar_state") throw new Error("redo delete failed");
  if (conversations.undoDelete()?.type !== "conversation") throw new Error("second restore failed");
});
await step("recursive folder delete and undo", () => {
  const folder = requireValue(conversations.createFolder("Recursive Smoke"), "recursive folder create failed");
  recursiveFolderId = folder.id;
  recursiveChildId = `${prefix}-recursive-child`;
  conversations.create(recursiveChildId, "openai", "gpt-5.6-sol", "Recursive child", undefined, false, recursiveFolderId);
  if (!conversations.deleteFolder(recursiveFolderId, "recursive")) throw new Error("recursive delete failed");
  if (conversations.undoDelete()?.type !== "sidebar_state") throw new Error("recursive undo failed");
  if (conversations.getSummary(recursiveChildId)?.folderId !== recursiveFolderId) throw new Error("recursive membership not restored");
});
await step("folder unwrap and undo", () => {
  const folder = requireValue(conversations.createFolder("Unwrap Smoke"), "unwrap folder create failed");
  unwrapFolderId = folder.id;
  unwrapChildId = `${prefix}-unwrap-child`;
  conversations.create(unwrapChildId, "openai", "gpt-5.6-sol", "Unwrap child", undefined, false, unwrapFolderId);
  if (!conversations.deleteFolder(unwrapFolderId, "unwrap")) throw new Error("unwrap failed");
  if (conversations.getSummary(unwrapChildId)?.folderId != null) throw new Error("child not unwrapped");
  if (conversations.undoDelete()?.type !== "sidebar_state") throw new Error("unwrap undo failed");
});
await step("synthetic non-executing Chrono integration", () => {
  const created = createChronoSchedule({ ownerConversationId: primary, afterSeconds: 86_400, message: "Synthetic future wake", title: "SQLite smoke wake" });
  chronoId = requireValue(created.schedule?.id, created.error ?? "chrono create failed");
  const cancelled = cancelChronoSchedule(chronoId, primary);
  if (!cancelled.cancelled) throw new Error(cancelled.error ?? "chrono cancel failed");
  stopChronoService();
  rmSync(join(dataDir(), "chrono.json"), { force: true });
});
await step("restart/reopen durable verification", () => {
  conversations.flushAll();
  closeConversationPersistence();
  const reopened = new SqliteConversationStore({ path: sqliteConversationStorePath() });
  if (!reopened.has(primary) || reopened.load(primary)?.messages.length === 0) throw new Error("primary missing after reopen");
  if (!reopened.has(cloneId)) throw new Error("restored clone missing after reopen");
  if (!reopened.integrityCheck().ok) throw new Error("integrity failed after reopen");
  reopened.close();
});
await step("SQLite integrity", () => {
  const report = requireValue(checkConversationStoreIntegrity(), "integrity unavailable");
  if (!report.ok) throw new Error(JSON.stringify(report));
});

const report = {
  version: 1,
  ranAt: Date.now(),
  backend: conversationPersistenceBackend(),
  database: sqliteConversationStorePath(),
  prefix,
  passed: results.filter((result) => result.ok).length,
  failed: results.filter((result) => !result.ok).length,
  results,
};
const reportPath = join(dataDir(), "sqlite-fixture", "feature-smoke-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ reportPath, passed: report.passed, failed: report.failed, steps: results.map(({ step, ok }) => ({ step, ok })) }, null, 2));
if (report.failed > 0) process.exit(1);
