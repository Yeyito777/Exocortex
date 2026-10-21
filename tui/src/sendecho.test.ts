import { describe, expect, test } from "bun:test";
import { handleEvent, type DaemonActions } from "./events";
import { createMessageMetadata, createPendingAI, type ImageAttachment, type UserMessage } from "./messages";
import type { DisplayEntry, Event } from "./protocol";
import { turnRequestId } from "./request-ids";
import { UNCONFIRMED_SEND_TTL_MS, restoreUnconfirmedSends, trackDirectSend } from "./sendecho";
import { createInitialState, isStreaming, type RenderState } from "./state";

const CONV = "conv-send";
const MODEL = "gpt-5.6-sol";

interface QueuedCall { convId: string; text: string; timing: string; images?: ImageAttachment[]; queueId: string }

function fakeDaemon(): DaemonActions & { queued: QueuedCall[] } {
  const queued: QueuedCall[] = [];
  return {
    queued,
    subscribe() {},
    unsubscribe() {},
    sendMessage() {},
    setSystemInstructions() {},
    loadToolOutputs() {},
    queueMessage(convId, text, timing, images, options) { queued.push({ convId, text, timing, images, queueId: options.queueId }); },
  };
}

function openState(): RenderState {
  const state = createInitialState();
  state.convId = CONV;
  state.model = MODEL;
  state.messages = [{ role: "assistant", blocks: [{ type: "text", text: "earlier answer" }], metadata: createMessageMetadata(500, MODEL, { endedAt: 600 }) }];
  return state;
}

/** What sendDirectly does for an open conversation. */
function send(state: RenderState, text: string, startedAt: number, images?: ImageAttachment[]): UserMessage {
  const echo: UserMessage = { role: "user", text, images, metadata: createMessageMetadata(startedAt, MODEL, { endedAt: startedAt }) };
  state.messages.push(echo);
  state.pendingAI = createPendingAI(startedAt, MODEL);
  trackDirectSend(state, CONV, echo, Date.now());
  return echo;
}

const earlierAnswer: DisplayEntry = { type: "ai", blocks: [{ type: "text", text: "earlier answer" }], metadata: createMessageMetadata(500, MODEL, { endedAt: 600 }) };
const userEntry = (text: string, startedAt: number): DisplayEntry => ({ type: "user", text, metadata: createMessageMetadata(startedAt, MODEL, { endedAt: startedAt }) });

function historyUpdated(entries: DisplayEntry[], pendingAI: Extract<Event, { type: "history_updated" }>["pendingAI"] = null): Event {
  return { type: "history_updated", convId: CONV, entries, contextTokens: null, toolOutputsIncluded: false, pendingAI };
}

function conversationLoaded(entries: DisplayEntry[]): Event {
  return {
    type: "conversation_loaded", convId: CONV, provider: "openai", model: MODEL, effort: "high", fastMode: false,
    entries, contextTokens: 0, toolOutputsIncluded: false,
  } as Event;
}

const userTexts = (state: RenderState) => state.messages.filter(message => message.role === "user").map(message => (message as UserMessage).text);

describe("optimistic direct sends", () => {
  test("a history refresh that predates the send keeps its bubble and spinner", () => {
    const state = openState();
    const daemon = fakeDaemon();
    const echo = send(state, "hello", 1_000);

    handleEvent(historyUpdated([earlierAnswer]), state, daemon);

    expect(userTexts(state)).toEqual(["hello"]);
    expect(state.messages.at(-1)).toBe(echo);
    expect(state.pendingAI?.metadata?.startedAt).toBe(1_000);
    expect(isStreaming(state)).toBe(true);
  });

  test("the daemon's echo confirms the send without a duplicate", () => {
    const state = openState();
    const daemon = fakeDaemon();
    send(state, "hello", 1_000);

    handleEvent({ type: "user_message", convId: CONV, text: "hello", startedAt: 1_000 }, state, daemon);
    expect(userTexts(state)).toEqual(["hello"]);
    expect(state.unconfirmedSends).toEqual([]);

    // Once confirmed, a later snapshot is authoritative (here: the turn was unwound).
    handleEvent(historyUpdated([earlierAnswer]), state, daemon);
    expect(userTexts(state)).toEqual([]);
  });

  test("a snapshot that already holds the send confirms it in place", () => {
    const state = openState();
    const daemon = fakeDaemon();
    send(state, "hello", 1_000);

    // A woken Chrono sleep confirms by snapshot rather than user_message.
    handleEvent(historyUpdated([earlierAnswer, userEntry("hello", 1_000)]), state, daemon);
    expect(userTexts(state)).toEqual(["hello"]);
    expect(state.unconfirmedSends).toEqual([]);
    // The late echo of the same send does not add a second bubble.
    handleEvent({ type: "user_message", convId: CONV, text: "hello", startedAt: 1_000 }, state, daemon);
    expect(userTexts(state)).toEqual(["hello"]);
  });

  test("an identical earlier message is not mistaken for the confirmation", () => {
    const state = openState();
    const daemon = fakeDaemon();
    state.messages.push({ role: "user", text: "again", metadata: createMessageMetadata(800, MODEL, { endedAt: 800 }) });
    send(state, "again", 1_000);

    handleEvent(historyUpdated([earlierAnswer, userEntry("again", 800)]), state, daemon);
    expect(userTexts(state)).toEqual(["again", "again"]);
    expect(state.unconfirmedSends).toHaveLength(1);
  });

  test("an open/reconnect load in flight during the send keeps it", () => {
    const state = openState();
    const daemon = fakeDaemon();
    const echo = send(state, "typed fast", 1_000);

    handleEvent(conversationLoaded([earlierAnswer]), state, daemon);
    expect(state.messages.at(-1)).toBe(echo);
    expect(state.pendingAI?.metadata?.startedAt).toBe(1_000);
  });

  test("a send that lost the race to a daemon-started turn is queued behind it", () => {
    const state = openState();
    const daemon = fakeDaemon();
    const images: ImageAttachment[] = [{ mediaType: "image/png", base64: "AAAA", sizeBytes: 3 }];
    send(state, "are you there?", 1_000, images);
    // The notification turn's start reached this client first.
    handleEvent({ type: "streaming_started", convId: CONV, provider: "openai", model: MODEL, startedAt: 990, snapshotKind: "start" } as Event, state, daemon);

    handleEvent({ type: "error", reqId: turnRequestId(1_000, 7), convId: CONV, message: "Already streaming" }, state, daemon);

    expect(userTexts(state)).toEqual([]);
    expect(daemon.queued).toEqual([{ convId: CONV, text: "are you there?", timing: "message-end", images, queueId: daemon.queued[0]!.queueId }]);
    expect(state.queuedMessages).toEqual([expect.objectContaining({ id: daemon.queued[0]!.queueId, optimistic: true, convId: CONV, text: "are you there?", timing: "message-end", images })]);
    // The other turn's live response stays; no error is shown for a queued message.
    expect(state.pendingAI?.metadata?.startedAt).toBe(990);
    expect(state.messages.some(message => message.role === "system")).toBe(false);
    expect(state.unconfirmedSends).toEqual([]);
  });

  test("a daemon-started user turn arriving first goes above the pending send", () => {
    const state = openState();
    const daemon = fakeDaemon();
    const echo = send(state, "mine", 1_000);

    handleEvent({ type: "user_message", convId: CONV, text: "[notification] build done", startedAt: 990, automation: { kind: "external_notification" } }, state, daemon);
    expect(userTexts(state)).toEqual(["[notification] build done", "mine"]);
    expect(state.messages.at(-1)).toBe(echo);
  });

  test("a send rejected for the conversation the user left is still queued", () => {
    const state = openState();
    const daemon = fakeDaemon();
    send(state, "for the other one", 1_000);
    state.convId = "elsewhere";

    handleEvent({ type: "error", reqId: turnRequestId(1_000, 1), convId: CONV, message: "Already streaming" }, state, daemon);
    expect(daemon.queued.map(call => call.convId)).toEqual([CONV]);
  });

  test("any other rejection returns the message to the prompt with a clear error", () => {
    const state = openState();
    const daemon = fakeDaemon();
    send(state, "first line", 1_000);
    state.inputBuffer = "draft";

    handleEvent({ type: "error", reqId: turnRequestId(1_000, 2), convId: CONV, message: "Conversation unwind in progress" }, state, daemon);

    expect(userTexts(state)).toEqual([]);
    expect(state.pendingAI).toBeNull();
    expect(state.inputBuffer).toBe("draft\nfirst line");
    expect(state.cursorPos).toBe(state.inputBuffer.length);
    expect(daemon.queued).toEqual([]);
    const notice = state.messages.at(-1);
    expect(notice?.role).toBe("system");
    expect(notice?.role === "system" && notice.text).toContain("Message not sent: Conversation unwind in progress");
  });

  test("an unrelated error leaves the pending send alone", () => {
    const state = openState();
    const daemon = fakeDaemon();
    const echo = send(state, "hello", 1_000);

    handleEvent({ type: "error", reqId: "load_tool_outputs:9", convId: CONV, message: "Tool output unavailable" }, state, daemon);
    expect(state.messages).toContain(echo);
    expect(state.pendingAI?.metadata?.startedAt).toBe(1_000);
    expect(state.unconfirmedSends).toHaveLength(1);
  });

  test("a send with no verdict for a minute yields to the snapshot", () => {
    const state = openState();
    send(state, "lost", 1_000);
    state.messages = state.messages.filter(message => message.role !== "user");
    state.pendingAI = null;

    expect(restoreUnconfirmedSends(state, CONV, Date.now() + UNCONFIRMED_SEND_TTL_MS)).toBe(false);
    expect(userTexts(state)).toEqual([]);
    expect(state.unconfirmedSends).toEqual([]);
  });
});
