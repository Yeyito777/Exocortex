/**
 * A Gemini turn at the plan's limit, through the real orchestrator and the
 * real gemini provider against the fake CLI (test-fixtures/fake-agy.ts),
 * which refuses as `agy acp` does (test-fixtures/quota-refusal.acp.jsonl).
 * Run by quota-wait.test.ts in its own process.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, getActiveJob, getSummary, isStreaming, remove } from "../../conversations";
import { load } from "../../persistence";
import { orchestrateSendMessage, setUsageLimitRetryFloorForTest } from "../../orchestrator";
import { beginPendingSubagentNotification, listPendingSubagentNotifications, removePendingSubagentNotificationsForConversation } from "../../subagent-notifications";
import { closeAllGeminiProcesses } from "./session";
import { clearUsage } from "./usage";

const FAKE_AGY = join(import.meta.dir, "test-fixtures", "fake-agy.ts");
let dir: string;
let quotaFile: string;
let promptLog: string;
const ids: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gemini-quota-wait-"));
  const wrapper = join(dir, "agy");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  quotaFile = join(dir, "quota.json");
  process.env.EXOCORTEX_AGY_BIN = wrapper;
  process.env.EXOCORTEX_AGY_STATE_DIR = join(dir, "agy-state");
  promptLog = join(dir, "prompts.jsonl");
  process.env.FAKE_AGY_QUOTA_FILE = quotaFile;
  process.env.FAKE_AGY_PROMPT_LOG = promptLog;
  setUsageLimitRetryFloorForTest(20);
});
afterAll(() => setUsageLimitRetryFloorForTest(null));
afterEach(() => {
  rmSync(quotaFile, { force: true });
  rmSync(promptLog, { force: true });
  closeAllGeminiProcesses("test over");
  clearUsage();
  for (const id of ids.splice(0)) { removePendingSubagentNotificationsForConversation(id); remove(id); }
});

const server = (events: any[]) => ({
  sendTo() {}, broadcast(event: any) { events.push(event); },
  sendToSubscribers(_id: string, event: any) { events.push(event); },
  sendToSubscribersExcept() {}, subscribe() {}, unsubscribe() {},
  hasSubscribers: () => false, hasLegacyHistorySubscribers: () => false,
  sendHistoryUpdatedToSubscribers() {},
});
function conversation() {
  const id = `gemini-quota-test-${crypto.randomUUID()}`;
  ids.push(id);
  create(id, "gemini", "gemini-4-neon");
  return id;
}
/** The plan refuses every prompt until release(); its message says it resets in `ms`. */
function refuse(ms: number) {
  writeFileSync(quotaFile, JSON.stringify({ resetAt: Date.now() + ms, hold: true }));
}
const release = () => rmSync(quotaFile, { force: true });
const prompts = (): string[] => existsSync(promptLog) ? readFileSync(promptLog, "utf8").trim().split("\n").map(line => JSON.parse(line).text) : [];

async function until(predicate: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("state not reached");
    await Bun.sleep(5);
  }
}

test("a refused turn keeps its partial output, waits yellow until the reset, and continues in the same session", async () => {
  const id = conversation();
  const parent = conversation();
  beginPendingSubagentNotification({ convId: parent }, id, "work until the limit", Date.now(), 0);
  const events: any[] = [];
  let completed = 0;
  refuse(400);
  const turn = orchestrateSendMessage(server(events) as never, null, undefined, id, "quota-work please", Date.now(), {
    onHeaders() {}, onComplete() { completed++; },
  });
  await until(() => getSummary(id)?.providerWaiting === true);
  expect(isStreaming(id)).toBe(true);
  expect(completed).toBe(0);
  expect(listPendingSubagentNotifications({ childConvId: id })[0].state).toBe("running");
  const wait = events.find(event => event.type === "connection_wait_status" && event.active && event.reason === "usage_limit");
  expect(wait?.label).toStartWith("Waiting for usage limit · resets ");
  expect(wait.resetAt).toBeGreaterThan(Date.now());
  // Partial output is already in the store while it waits.
  expect(JSON.stringify(load(id)!.messages)).toContain("Before the limit.");

  release();
  const result = await turn;
  expect(result.ok).toBe(true);
  expect(completed).toBe(1);
  const history = JSON.stringify(load(id)!.messages);
  expect(history.split("Before the limit.").length - 1).toBe(1);
  expect(history).not.toContain("quota reached");
  // The resumed prompt asked the same session to continue (the fake echoes it).
  expect(history).toContain("Continue where you left off.");
  expect(events.some(event => event.type === "error")).toBe(false);
  expect(getSummary(id)?.providerWaiting).toBe(false);
  const notice = listPendingSubagentNotifications({ childConvId: id })[0];
  expect(notice.state).toBe("ready");
  expect(notice.text).toContain("Continue where you left off.");
  expect(notice.text).not.toContain("quota reached");
}, 15_000);

test("Stop ends a turn waiting for the Gemini limit and keeps what it did", async () => {
  const id = conversation();
  refuse(3_600_000);
  const turn = orchestrateSendMessage(server([]) as never, null, undefined, id, "quota-work please", Date.now(), {
    onHeaders() {}, onComplete() {},
  });
  await until(() => getSummary(id)?.providerWaiting === true);
  getActiveJob(id)!.abort();
  expect((await turn).aborted).toBe(true);
  expect(isStreaming(id)).toBe(false);
  expect(getSummary(id)?.providerWaiting).toBe(false);
  expect(JSON.stringify(load(id)!.messages)).toContain("Before the limit.");
}, 15_000);

test("a new turn while the limit holds waits before sending anything", async () => {
  const id = conversation();
  refuse(3_000);
  const first = orchestrateSendMessage(server([]) as never, null, undefined, id, "quota-work please", Date.now(), { onHeaders() {}, onComplete() {} });
  await until(() => getSummary(id)?.providerWaiting === true);
  getActiveJob(id)!.abort();
  await first;
  release();
  // The refusal is remembered: the next turn waits for its reset before it sends anything.
  const second = orchestrateSendMessage(server([]) as never, null, undefined, id, "after the reset", Date.now(), { onHeaders() {}, onComplete() {} });
  await until(() => getSummary(id)?.providerWaiting === true);
  expect(prompts()).toEqual(["quota-work please"]);
  const done = await second;
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(prompts()).toEqual(["quota-work please", "after the reset"]);
  expect(JSON.stringify(load(id)!.messages)).toContain("after the reset");
}, 15_000);
