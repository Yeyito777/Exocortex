import { describe, expect, test } from "bun:test";
import type { ApiMessage, StoredMessage } from "./messages";
import {
  annotateApiMessagesContextTokens,
  contextMessageCharBreakdown,
  contextMessageSignature,
  copyContextTokenAttributionsToStoredHistory,
  validContextTokenAttribution,
} from "./context-token-attribution";

describe("context token attribution", () => {
  test("calibrates provider-reported input tokens onto replay messages and copies to stored history", () => {
    const apiMessages: ApiMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "true" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "large output ".repeat(100) }] },
    ];
    const stored: StoredMessage[] = apiMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      metadata: null,
      providerData: msg.providerData,
    }));

    annotateApiMessagesContextTokens(apiMessages, 2_000, "openai", "gpt-5.5", 123);
    const copied = copyContextTokenAttributionsToStoredHistory(stored, apiMessages);

    expect(copied).toBe(3);
    expect(stored[2].contextTokens?.totalTokens).toBeGreaterThan(stored[0].contextTokens?.totalTokens ?? 0);
    expect(stored[2].contextTokens?.breakdown.toolResultText).toBeGreaterThan(0);
    expect(validContextTokenAttribution(stored[2], "openai", "gpt-5.5")).not.toBeNull();
  });

  test("invalidates attribution when message replay content changes", () => {
    const msg: StoredMessage = { role: "user", content: "hello", metadata: null };
    const before = contextMessageSignature(msg);
    msg.contextTokens = {
      version: 1,
      provider: "openai",
      model: "gpt-5.5",
      signature: before,
      totalTokens: 10,
      breakdown: {
        userText: 10,
        userImage: 0,
        assistantText: 0,
        toolUse: 0,
        toolResultText: 0,
        toolResultImage: 0,
        thinking: 0,
        providerReasoning: 0,
        systemHint: 0,
      },
      source: "provider_calibrated",
      updatedAt: 0,
    };

    expect(validContextTokenAttribution(msg, "openai", "gpt-5.5")).not.toBeNull();
    msg.content = "hello changed";
    expect(validContextTokenAttribution(msg, "openai", "gpt-5.5")).toBeNull();
  });

  test("OpenAI image replay attribution uses image-token scale, not raw base64 size", () => {
    const png = Buffer.alloc(100_000);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.writeUInt32BE(1024, 16);
    png.writeUInt32BE(1024, 20);
    const base64 = png.toString("base64");
    const msg: StoredMessage = {
      role: "user",
      metadata: null,
      content: [{
        type: "tool_result",
        tool_use_id: "call_1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }],
      }],
    };

    const openai = contextMessageCharBreakdown(msg, "openai");
    const deepseek = contextMessageCharBreakdown(msg, "deepseek");

    expect(openai.toolResultImage).toBe((85 + 170 * 4) * 4);
    expect(deepseek.toolResultImage).toBe(base64.length);
    expect(openai.toolResultImage).toBeLessThan(base64.length / 10);
  });
});
