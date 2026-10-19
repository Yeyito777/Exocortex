import { describe, expect, test } from "bun:test";

import { handleEvent, type DaemonActions } from "./events";
import { createMessageMetadata, type Message } from "./messages";
import { createInitialState, pushSystemMessage } from "./state";

const daemon: DaemonActions = {
  subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {},
};

function label(message: Message): string {
  if (message.role === "user") return `U:${message.text}`;
  if (message.role === "assistant") return `A:${message.blocks.map(block => block.type === "text" ? block.text : block.type).join("|")}`;
  return `${message.role}:${message.text}`;
}

const user = (text: string, startedAt: number) => ({ type: "user", text, metadata: createMessageMetadata(startedAt, "m") });
const ai = (...texts: string[]) => ({ type: "ai", blocks: texts.map(text => ({ type: "text", text })), metadata: null });

function openWithLocalNoticeThenTurn() {
  const state = createInitialState();
  state.convId = "c";
  handleEvent({
    type: "conversation_loaded", convId: "c", reqId: "open",
    entries: [user("u0", 1), ai("a1"), user("u2", 3), ai("a3")],
    historyStartIndex: 0, historyStartUserIndex: 0, historyTotalEntries: 4, hasOlderHistory: false, contextTokens: 0,
  } as never, state, daemon);
  // An idle local notice, e.g. the confirmation after /effort or /model.
  pushSystemMessage(state, "Effort set to high");
  state.messages.push({ role: "user", text: "u4", metadata: createMessageMetadata(5, "m") });
  state.messages.push({ role: "assistant", blocks: [{ type: "text", text: "a5" }, { type: "text", text: "a5b" }], metadata: null });
  return state;
}

describe("history_updated keeps the loaded prefix by daemon entry, not by row", () => {
  test("a local notice does not push a canonical entry out of the kept prefix", () => {
    const state = openWithLocalNoticeThenTurn();
    // A byte-budgeted turn-end refresh that starts at the reply (entry 5),
    // as when the prompt carried a large image.
    handleEvent({
      type: "history_updated", convId: "c", entries: [ai("a5", "a5b")], contextTokens: 0, toolOutputsIncluded: true,
      historyStartIndex: 5, historyStartBlockIndex: 0, historyStartUserIndex: 3, hasOlderHistory: true,
    } as never, state, daemon);
    expect(state.messages.map(label)).toEqual(["U:u0", "A:a1", "U:u2", "A:a3", "system:Effort set to high", "U:u4", "A:a5|a5b"]);
    expect(state.historyStartIndex).toBe(0);
  });

  test("a refresh starting inside an AI entry still joins the right message", () => {
    const state = openWithLocalNoticeThenTurn();
    handleEvent({
      type: "history_updated", convId: "c", entries: [ai("a5b")], contextTokens: 0, toolOutputsIncluded: true,
      historyStartIndex: 5, historyStartBlockIndex: 1, historyStartUserIndex: 3, hasOlderHistory: true,
    } as never, state, daemon);
    expect(state.messages.map(label)).toEqual(["U:u0", "A:a1", "U:u2", "A:a3", "system:Effort set to high", "U:u4", "A:a5|a5b"]);
  });
});
