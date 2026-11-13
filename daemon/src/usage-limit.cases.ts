import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { create, getActiveJob, getSummary, isStreaming, remove } from "./conversations";
import { load } from "./persistence";
import { orchestrateSendMessage, setUsageLimitRetryFloorForTest, type OrchestrationCallbacks } from "./orchestrator";
import type { streamMessage } from "./api";
import { AuthError, ClaudeAccountFailoverError } from "./providers/errors";
import { beginPendingSubagentNotification, listPendingSubagentNotifications, removePendingSubagentNotificationsForConversation } from "./subagent-notifications";

const ids: string[] = [];
const server = (events: any[]) => ({
  sendTo() {}, broadcast(event: any) { events.push(event); },
  sendToSubscribers(_id: string, event: any) { events.push(event); },
  sendToSubscribersExcept() {}, subscribe() {}, unsubscribe() {},
  hasSubscribers: () => false, hasLegacyHistorySubscribers: () => false,
  sendHistoryUpdatedToSubscribers() {},
});
function conversation() {
  const id = `usage-limit-test-${crypto.randomUUID()}`;
  ids.push(id);
  create(id, "anthropic", "claude-opus-5-5");
  return id;
}
function answer(text: string) {
  return { text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [], inputTokens: 10, outputTokens: 2 };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("waiting state not reached");
}
afterEach(() => { for (const id of ids.splice(0)) { removePendingSubagentNotificationsForConversation(id); remove(id); } });
// The retry floor itself is unit-tested in usage-limit-wait.test.ts.
beforeAll(() => setUsageLimitRetryFloorForTest(20));
afterAll(() => setUsageLimitRetryFloorForTest(null));

test("real turn keeps committed partial output and continues without error or replay", async () => {
  const id = conversation();
  const events: any[] = [];
  let calls = 0;
  let completed = 0;
  const fake = (async (_provider, messages, _model, callbacks) => {
    if (++calls === 1) {
      callbacks.onText("Before the limit.");
      callbacks.onProviderRound?.({
        blocks: [{ type: "text", text: "Before the limit." }],
        messages: [{ role: "assistant", content: [{ type: "text", text: "Before the limit." }] }],
        outputTokens: 4,
      });
      throw new Error("You've hit your session limit");
    }
    expect(JSON.stringify(messages)).toContain("Before the limit.");
    return answer("After the limit.");
  }) as typeof streamMessage;
  const ext: OrchestrationCallbacks = {
    onHeaders() {}, onComplete() { completed++; }, streamMessageFn: fake,
    usageAvailability: () => ({ ready: true, resetAt: null }),
  };
  const result = await orchestrateSendMessage(server(events) as never, null, undefined, id, "continue", Date.now(), ext);
  expect(result.ok).toBe(true);
  expect(completed).toBe(1);
  expect(calls).toBe(2);
  const history = load(id)!.messages;
  expect(history.filter(row => JSON.stringify(row.content).includes("Before the limit."))).toHaveLength(1);
  expect(history.filter(row => JSON.stringify(row.content).includes("After the limit."))).toHaveLength(1);
  expect(events.some(event => event.type === "error")).toBe(false);
});

test("all limited turns stay streaming and yellow until reset, without a completion callback", async () => {
  const id = conversation();
  const events: any[] = [];
  let calls = 0;
  let completed = 0;
  const resetAt = Date.now() + 100;
  const parent = conversation();
  beginPendingSubagentNotification({ convId: parent }, id, "wait for capacity", Date.now(), 0);
  const turn = orchestrateSendMessage(server(events) as never, null, undefined, id, "wait", Date.now(), {
    onHeaders() {}, onComplete() { completed++; },
    streamMessageFn: (async () => { calls++; return answer("resumed"); }) as typeof streamMessage,
    usageAvailability: () => ({ ready: Date.now() >= resetAt, resetAt }),
  });
  await until(() => getSummary(id)?.providerWaiting === true);
  expect(isStreaming(id)).toBe(true);
  expect(calls).toBe(0);
  expect(completed).toBe(0);
  expect(listPendingSubagentNotifications({ childConvId: id })[0].state).toBe("running");
  expect(events.some(event => event.label?.startsWith("Waiting for usage limit"))).toBe(true);
  expect((await turn).ok).toBe(true);
  expect(completed).toBe(1);
  expect(listPendingSubagentNotifications({ childConvId: id })[0].state).toBe("ready");
  expect(listPendingSubagentNotifications({ childConvId: id })[0].text).toContain("resumed");
});

test("normal abort ends an all-limited turn cleanly", async () => {
  const id = conversation();
  const turn = orchestrateSendMessage(server([]) as never, null, undefined, id, "wait", Date.now(), {
    onHeaders() {}, onComplete() {},
    streamMessageFn: (async () => { throw new Error("must not call"); }) as typeof streamMessage,
    usageAvailability: () => ({ ready: false, resetAt: Date.now() + 3_600_000 }),
  });
  await until(() => getSummary(id)?.providerWaiting === true);
  getActiveJob(id)!.abort();
  expect((await turn).aborted).toBe(true);
  expect(isStreaming(id)).toBe(false);
  expect(getSummary(id)?.providerWaiting).toBe(false);
});

test("a turn whose Claude account fails authentication runs again at once when another account can take it", async () => {
  const id = conversation();
  const events: any[] = [];
  let calls = 0;
  let completed = 0;
  const result = await orchestrateSendMessage(server(events) as never, null, undefined, id, "wake", Date.now(), {
    onHeaders() {}, onComplete() { completed++; },
    streamMessageFn: (async () => {
      if (++calls === 1) throw new ClaudeAccountFailoverError("Failed to authenticate: this login reached its time limit and cannot be renewed.");
      return answer("Ran on the other account.");
    }) as typeof streamMessage,
    usageAvailability: () => ({ ready: true, resetAt: null }),
  });
  expect(result.ok).toBe(true);
  expect(calls).toBe(2);
  expect(completed).toBe(1);
  expect(load(id)!.messages.filter(row => JSON.stringify(row.content).includes("Ran on the other account."))).toHaveLength(1);
  expect(events.some(event => event.type === "error")).toBe(false);
  // Not a usage limit: nothing says it waits for one.
  expect(events.some(event => event.label?.startsWith("Waiting for usage limit"))).toBe(false);
});

test("an authentication failure with no other account to run on ends the turn", async () => {
  const id = conversation();
  let calls = 0;
  const result = await orchestrateSendMessage(server([]) as never, null, undefined, id, "wake", Date.now(), {
    onHeaders() {}, onComplete() {},
    streamMessageFn: (async () => { calls++; throw new AuthError("Failed to authenticate: this login reached its time limit and cannot be renewed."); }) as typeof streamMessage,
    usageAvailability: () => ({ ready: true, resetAt: null }),
  });
  expect(result.ok).toBe(false);
  expect(calls).toBe(1);
});
