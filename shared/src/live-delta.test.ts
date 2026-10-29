import { describe, expect, test } from "bun:test";
import type { Block, ConversationLoadedEvent, DisplayEntry } from "./protocol";
import { compactLiveBlock, decodeLiveBlocks, describeLiveBlocks, encodeLiveBlocks, isLiveBlocksBase } from "./live-delta";
import { decodePagePush, encodePagePush, pageBase } from "./history-push";

const text = (t: string): Block => ({ type: "text", text: t });
const thinking = (t: string): Block => ({ type: "thinking", text: t });
const call = (id: string, input = {}): Block => ({ type: "tool_call", toolCallId: id, toolName: "bash", input, summary: id });
const result = (id: string, output = ""): Block => ({ type: "tool_result", toolCallId: id, toolName: "bash", output, isError: false });

function roundTrip(base: Block[], next: Block[]) {
  const encoded = encodeLiveBlocks(next, describeLiveBlocks(base));
  const rebuilt = encoded ? decodeLiveBlocks(base, encoded.delta, encoded.blocks) : next;
  expect(rebuilt).toEqual(next);
  return encoded;
}

describe("live block deltas", () => {
  test("send only what is newer: grown text, new blocks", () => {
    expect(roundTrip([thinking("let me")], [thinking("let me think about it")])).toEqual({ delta: { keep: 0, extend: " think about it" }, blocks: [] });
    expect(roundTrip([thinking("ok"), text("Here")], [thinking("ok"), text("Here it is"), call("a")]))
      .toEqual({ delta: { keep: 1, extend: " it is" }, blocks: [call("a")] });
    expect(roundTrip([call("a")], [call("a"), result("a")])).toEqual({ delta: { keep: 1 }, blocks: [result("a")] });
    expect(roundTrip([text("same")], [text("same")])).toEqual({ delta: { keep: 1 }, blocks: [] });
  });

  test("fall back to the whole list when the base does not hold: replaced, rewritten or a new round", () => {
    expect(roundTrip([text("draft")], [text("final")])).toBeNull();
    expect(roundTrip([text("abc"), call("a")], [text("abX")])).toBeNull();
    // The base's text was rewritten under the same length: no extension of a different prefix.
    expect(roundTrip([thinking("aaaa")], [thinking("bbbbbb")])).toBeNull();
    // A shorter or reordered list keeps what still matches.
    expect(roundTrip([text("a"), call("b"), call("c")], [text("a"), call("c")])).toEqual({ delta: { keep: 1 }, blocks: [call("c")] });
    expect(encodeLiveBlocks([text("x")], undefined)).toBeNull();
    expect(encodeLiveBlocks([text("x")], { hashes: [] })).toBeNull();
  });

  test("leave tool output out of what is kept and sent, and refuse bad bases", () => {
    expect(compactLiveBlock(result("a", "big output"))).toEqual(result("a"));
    const kept = text("t");
    expect(compactLiveBlock(kept)).toBe(kept);
    expect(isLiveBlocksBase(describeLiveBlocks([text("a"), call("b")]))).toBe(true);
    expect(isLiveBlocksBase({ hashes: ["nothex"] })).toBe(false);
    expect(isLiveBlocksBase({ hashes: [], tailChars: -1 })).toBe(false);
    expect(() => decodeLiveBlocks([text("a")], { keep: 2 }, [])).toThrow();
    expect(() => decodeLiveBlocks([call("a")], { keep: 0, extend: "x" }, [])).toThrow();
  });
});

const ai = (blocks: Block[]): DisplayEntry => ({ type: "ai", blocks, metadata: null });
const user = (t: string): DisplayEntry => ({ type: "user", text: t.repeat(40), metadata: null });
const page = (entries: DisplayEntry[]): ConversationLoadedEvent => ({
  type: "conversation_loaded", convId: "c", provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false,
  entries, contextTokens: null, toolOutputsIncluded: false,
});

describe("page pushes", () => {
  test("reuse unchanged entries, and of a changed AI entry the blocks it already had", () => {
    const turn = [text("intro ".repeat(30)), call("a", { command: "ls ".repeat(40) }), result("a")];
    const before = [user("u1"), ai(turn), user("u2"), ai(turn.slice(0, 2))];
    // One round longer, its old last call now shown differently (elided), in the middle.
    const after = [user("u2"), ai([turn[0]!, call("a"), result("x"), call("b")]), user("u3")];
    const pushed = encodePagePush(page(after), pageBase(before));
    expect(pushed.entryOrder).toEqual([-3, 0, 1]);
    expect(pushed.entryBlocks).toEqual([[0, 3, [-1, 0, 1, 2]]]);
    expect(pushed.entries[0]).toEqual(ai([call("a"), result("x"), call("b")]));
    expect(decodePagePush(pushed, before)).toEqual(page(after));
  });

  test("refuse to rebuild from a copy that cannot hold the push", () => {
    const before = [user("u1"), ai([text("x".repeat(100))])];
    const pushed = encodePagePush(page([user("u1"), ai([text("x".repeat(100)), call("b")])]), pageBase(before));
    expect(() => decodePagePush(pushed, [user("u1")])).toThrow();
    expect(() => decodePagePush({ ...pushed, entryOrder: [-9] }, before)).toThrow();
  });
});
