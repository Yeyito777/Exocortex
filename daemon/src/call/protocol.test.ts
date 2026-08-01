import { describe, expect, test } from "bun:test";
import {
  buildDelegationAppend,
  buildRealtimeSession,
  chunkRealtimeContext,
  parseRealtimeSidebandEvent,
} from "./protocol";

describe("Frameless Bidi protocol", () => {
  test("encodes role-bearing initial context in the native call session", () => {
    expect(buildRealtimeSession("voice prompt", [
      { role: "developer", text: "remember" },
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
    ])).toEqual({
      model: "gpt-live-1-boulder-alpha",
      instructions: "voice prompt",
      audio: { output: { voice: "cove" } },
      delegation: { type: "client" },
      initial_items: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "remember" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
  });

  test("uses an explicitly selected voice", () => {
    expect(buildRealtimeSession("voice prompt", [], "sol")).toMatchObject({
      audio: { output: { voice: "sol" } },
    });
  });

  test("parses transcripts, completion, delegation, and errors", () => {
    expect(parseRealtimeSidebandEvent(JSON.stringify({
      type: "input_transcript.added",
      item: { text: "hello" },
    }))).toEqual({ type: "transcript_delta", role: "user", text: "hello" });
    expect(parseRealtimeSidebandEvent(JSON.stringify({
      type: "turn.done",
      turn: { role: "assistant", transcript: "hi", usage: { output_tokens: 7 } },
    }))).toEqual({ type: "transcript_done", role: "assistant", text: "hi", tokens: 7 });
    expect(parseRealtimeSidebandEvent(JSON.stringify({
      type: "delegation.created",
      item: {
        id: "delegation-1",
        type: "delegation",
        target: "client",
        content: [
          { type: "input_text", text: "inspect " },
          { type: "input_text", text: "this" },
        ],
      },
    }))).toEqual({ type: "handoff", handoffId: "delegation-1", text: "inspect this" });
    expect(parseRealtimeSidebandEvent(JSON.stringify({
      type: "error",
      error: { message: "boom" },
    }))).toEqual({ type: "error", message: "boom" });
    expect(parseRealtimeSidebandEvent("not json")).toBeNull();
  });

  test("chunks UTF-8 context and targets delegation output correctly", () => {
    const text = "🙂".repeat(300);
    const chunks = chunkRealtimeContext(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 500)).toBe(true);
    const messages = buildDelegationAppend("delegation-1", text);
    expect(messages.every(message => (
      message.type === "delegation.context.append"
      && message.delegation_item_id === "delegation-1"
      && message.channel === "speakable"
    ))).toBe(true);
  });
});
