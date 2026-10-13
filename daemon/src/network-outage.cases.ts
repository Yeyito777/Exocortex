/**
 * Real-orchestrator cases for turns that wait out a network outage. Run in a
 * child process by network-outage.test.ts (handler.test.ts mocks the
 * orchestrator module process-wide).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { clearHistoryUnwindPending, create, getActiveJob, getQueuedMessages, isStreaming, pushQueuedMessage, remove } from "./conversations";
import { load as loadPersisted } from "./persistence";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import type { streamMessage } from "./api";
import { chronoInternalsForTest } from "./chrono-service";
import { ConnectivityMonitor } from "./connectivity";
import { FakeClock, flush, scriptedProbe } from "./connectivity-test-helpers";
import type { StoredMessage } from "./messages";

const IDS: string[] = [];

function id(suffix: string): string {
  const value = `network-outage-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(value);
  return value;
}

type Event = Record<string, unknown>;

function server(events: Event[] = []) {
  return {
    sendTo: () => {},
    broadcast: (event: Event) => { events.push(event); },
    sendToSubscribers: (_convId: string, event: Event) => { events.push(event); },
    sendToSubscribersExcept: (_convId: string, event: Event) => { events.push(event); },
    subscribe: () => {},
    unsubscribe: () => {},
    hasSubscribers: () => false,
    hasLegacyHistorySubscribers: () => false,
    sendHistoryUpdatedToSubscribers: (_convId: string, _legacy: Event, paginated: Event) => { events.push(paginated); },
  };
}

function answer(text: string) {
  return {
    text,
    thinking: "",
    stopReason: "stop" as const,
    blocks: [{ type: "text" as const, text }],
    toolCalls: [],
    inputTokens: 10,
    outputTokens: 2,
  };
}

/** The Oct 13 failure, verbatim. */
function outageError(): Error {
  return new Error("Claude Code: API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)");
}

function offlineMonitor() {
  const clock = new FakeClock();
  const probe = scriptedProbe(false);
  const monitor = new ConnectivityMonitor({ probe, clock });
  return { clock, probe, monitor };
}

function callbacks(streamMessageFn: typeof streamMessage, connectivity: ConnectivityMonitor): OrchestrationCallbacks {
  return { onHeaders() {}, onComplete() {}, streamMessageFn, connectivity };
}

function text(message: StoredMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(block => block.type === "text" ? block.text : "").join("");
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(() => {
  chronoInternalsForTest.reset();
  for (const convId of IDS.splice(0)) {
    clearHistoryUnwindPending(convId);
    remove(convId);
  }
});

describe("turns wait out network outages", () => {
  test("a turn that loses the network waits, resumes on reconnect, then runs wakes queued meanwhile in order", async () => {
    const convId = id("resume");
    create(convId, "anthropic", "claude-opus-5-5");
    const events: Event[] = [];
    const { clock, probe, monitor } = offlineMonitor();
    const requests: string[][] = [];
    const fakeStream = (async (_provider, messages) => {
      requests.push(messages.map(message => text(message as StoredMessage)));
      if (requests.length === 1) throw outageError();
      return answer(`reply ${requests.length - 1}`);
    }) as typeof streamMessage;

    const turn = orchestrateSendMessage(server(events) as never, null, undefined, convId, "check the monitor", Date.now(), callbacks(fakeStream, monitor));
    await until(() => events.some(event => event.type === "connection_wait_status" && event.active === true), "the waiting state");
    expect(isStreaming(convId)).toBe(true);
    expect(monitor.isOnline()).toBe(false);

    // A chrono wake and an external notification arrive while offline. The
    // wake fires twice (a retried delivery): its id deduplicates it.
    pushQueuedMessage(convId, "[chrono wake: gate]\nreview", "next-turn", undefined, null, undefined, "chrono:gate:1", undefined, { kind: "chrono_wake", sourceId: "gate" });
    pushQueuedMessage(convId, "[chrono wake: gate]\nreview", "next-turn", undefined, null, undefined, "chrono:gate:1", undefined, { kind: "chrono_wake", sourceId: "gate" });
    pushQueuedMessage(convId, "[notification] email", "next-turn", undefined, null, undefined, "notify:email:1", undefined, { kind: "external_notification", sourceId: "gmail" } as never);
    expect(getQueuedMessages(convId).map(message => message.id)).toEqual(["chrono:gate:1", "notify:email:1"]);

    // Probes keep failing: nothing is sent and nothing is dropped.
    await clock.advance(3_000);
    await clock.advance(6_000);
    expect(requests).toHaveLength(1);
    expect(getQueuedMessages(convId)).toHaveLength(2);

    probe.reachable = true;
    await clock.advance(12_000);
    const outcome = await turn;
    await until(() => !isStreaming(convId), "the queued turns");

    expect(outcome.ok).toBe(true);
    expect(requests[1]).toEqual(["check the monitor"]);
    const persisted = loadPersisted(convId)!.messages;
    expect(persisted.map(message => `${message.role}:${text(message).split("\n")[0]}`)).toEqual([
      "user:check the monitor",
      "assistant:reply 1",
      "user:[chrono wake: gate]",
      "assistant:reply 2",
      "user:[notification] email",
      "assistant:reply 3",
    ]);
    expect(persisted.some(message => message.role === "system")).toBe(false);
    expect(getQueuedMessages(convId)).toEqual([]);
    const waits = events.filter(event => event.type === "connection_wait_status");
    expect(waits.map(event => event.active)).toEqual([true, false]);
    expect(typeof waits[0].startedAt).toBe("number");
  });

  test("a provider's committed tool round is not run again after the reconnect", async () => {
    const convId = id("committed-round");
    create(convId, "anthropic", "claude-opus-5-5");
    const { clock, probe, monitor } = offlineMonitor();
    const requests: number[] = [];
    let toolRuns = 0;
    const fakeStream = (async (_provider, messages, _model, streamCallbacks) => {
      requests.push(messages.length);
      if (requests.length === 1) {
        // Claude Code runs and commits one tool round, then loses the network.
        toolRuns += 1;
        streamCallbacks.onToolCall?.({ type: "tool_call", toolCallId: "deploy", toolName: "bash", input: {}, summary: "deploy" });
        streamCallbacks.onToolResult?.({ type: "tool_result", toolCallId: "deploy", toolName: "bash", output: "deployed", isError: false });
        streamCallbacks.onProviderRound?.({
          blocks: [],
          messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "deploy", name: "bash", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "deploy", content: "deployed" }] },
          ],
          outputTokens: 1,
        });
        throw outageError();
      }
      return answer("deployed and verified");
    }) as typeof streamMessage;

    const turn = orchestrateSendMessage(server() as never, null, undefined, convId, "deploy", Date.now(), callbacks(fakeStream, monitor));
    await until(() => !monitor.isOnline(), "the outage");
    probe.reachable = true;
    await clock.advance(3_000);
    const outcome = await turn;

    expect(outcome.ok).toBe(true);
    expect(toolRuns).toBe(1);
    // The retry continues after the committed round instead of re-sending the prompt alone.
    expect(requests).toEqual([1, 3]);
    const persisted = loadPersisted(convId)!.messages;
    expect(persisted.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(persisted.filter(message => JSON.stringify(message.content).includes("\"type\":\"tool_use\""))).toHaveLength(1);
  });

  test("Stop during the wait ends the turn as interrupted and keeps the message for /replay", async () => {
    const convId = id("stop");
    create(convId, "anthropic", "claude-opus-5-5");
    const events: Event[] = [];
    const { monitor } = offlineMonitor();
    let requests = 0;
    const fakeStream = (async () => {
      requests += 1;
      throw outageError();
    }) as typeof streamMessage;

    const turn = orchestrateSendMessage(server(events) as never, null, undefined, convId, "hello?", Date.now(), callbacks(fakeStream, monitor));
    await until(() => events.some(event => event.type === "connection_wait_status" && event.active === true), "the waiting state");
    getActiveJob(convId)!.abort();
    const outcome = await turn;
    await flush();

    expect(outcome.aborted).toBe(true);
    expect(requests).toBe(1);
    const persisted = loadPersisted(convId)!.messages;
    expect(persisted.map(message => `${message.role}:${text(message)}`)).toEqual(["user:hello?", "system:✗ Interrupted"]);
    expect(events.filter(event => event.type === "connection_wait_status").map(event => event.active)).toEqual([true, false]);
    expect(isStreaming(convId)).toBe(false);
  });

  test("API errors still fail the turn at once", async () => {
    const convId = id("api-error");
    create(convId, "anthropic", "claude-opus-5-5");
    const { monitor, probe } = offlineMonitor();
    const fakeStream = (async () => { throw new Error("Claude Code: API Error: 529 Overloaded"); }) as typeof streamMessage;
    const outcome = await orchestrateSendMessage(server() as never, null, undefined, convId, "hi", Date.now(), callbacks(fakeStream, monitor));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("✗ Claude Code: API Error: 529 Overloaded");
    expect(probe.calls).toBe(0);
  });

  test("a provider retrying by itself shows the wait while the network is down", async () => {
    const convId = id("provider-retry");
    create(convId, "anthropic", "claude-opus-5-5");
    const events: Event[] = [];
    const { probe, monitor } = offlineMonitor();
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      // Claude Code's api_retry with no HTTP status, then its retry gets through.
      streamCallbacks.onNetworkTrouble?.();
      await until(() => events.some(event => event.type === "connection_wait_status" && event.active === true), "the waiting state");
      probe.reachable = true;
      streamCallbacks.onBlockStart?.("text");
      streamCallbacks.onText("back");
      return answer("back");
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(server(events) as never, null, undefined, convId, "hi", Date.now(), callbacks(fakeStream, monitor));
    expect(outcome.ok).toBe(true);
    expect(monitor.isOnline()).toBe(true);
    expect(events.filter(event => event.type === "connection_wait_status").map(event => event.active)).toEqual([true, false]);
  });
});
