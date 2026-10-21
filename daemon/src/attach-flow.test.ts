/**
 * Attached images end to end inside the daemon: the agent loop persists them
 * on the tool_result (never as model input), the display projection exposes
 * them, Claude Code host-tool calls carry them across the MCP boundary, and
 * get_image serves previews of stored and pasted images.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDisplayData } from "./display";
import type { ImageRef, StoredMessage } from "./messages";
import { attachmentsInternalsForTest, findStoredImage, putImageBytes, storeImageFile, imageIdForBytes, sniffImage } from "./attachments";
import { createClaudeStreamState, finalizeClaudeStream, pushClaudeMessage } from "./providers/anthropic/stream";
import { rememberHostToolAttachments, takeHostToolAttachments } from "./providers/anthropic/host-tool-attachments";
import { create, get } from "./conversations";
import { createHandler } from "./handler";
import { ECHO_INLINE_IMAGE_CHARS, imagesForEcho } from "./image-requests";

let dir: string;

let ref: ImageRef;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "exo-attach-flow-"));
  const proc = Bun.spawnSync(["magick", "-size", "200x100", "gradient:white-black", join(dir, "chart.png")]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  ref = await storeImageFile(join(dir, "chart.png"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const summarizer = (name: string) => ({ label: name, detail: "" });

describe("display projection", () => {
  const messages = (): StoredMessage[] => [
    { role: "user", content: "plot it", metadata: null },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "attach", input: { paths: ["chart.png"] } }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Attached 1 image", attachments: [ref] }], metadata: null },
    { role: "assistant", content: "Here is the chart.", metadata: null },
  ];

  test("exposes attachments as tool_result images, even without tool outputs", () => {
    for (const includeToolOutputs of [true, false]) {
      const { entries } = buildDisplayData("c", "openai", "gpt-5.5", "high", false, messages(), null, summarizer, { includeToolOutputs });
      const ai = entries.find(entry => entry.type === "ai");
      if (ai?.type !== "ai") throw new Error("missing ai entry");
      const result = ai.blocks.find(block => block.type === "tool_result");
      expect(result).toMatchObject({ type: "tool_result", toolCallId: "c1", images: [ref] });
      expect(ai.blocks.at(-1)).toEqual({ type: "text", text: "Here is the chart." });
    }
  });

  test("gives pasted images a content id and pixel size", () => {
    const bytes = readFileSync(join(dir, "chart.png"));
    const { entries } = buildDisplayData("c", "openai", "gpt-5.5", "high", false, [{
      role: "user",
      content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } }],
      metadata: null,
    }], null, summarizer);
    expect(entries[0]).toMatchObject({ type: "user", images: [{ imageId: imageIdForBytes(bytes), width: 200, height: 100 }] });
  });
});

describe("Claude Code host tool", () => {
  test("a recorded tool_result picks up the attachments its MCP call produced", () => {
    rememberHostToolAttachments("toolu_a", [ref]);
    const results: unknown[] = [];
    const state = createClaudeStreamState({
      onText: () => {}, onThinking: () => {}, onBlockStart: () => {}, onToolCall: () => {},
      onToolResult: block => results.push(block),
      onHeaders: () => {},
    }, "/work");
    const session = "11111111-1111-1111-1111-111111111111";
    pushClaudeMessage(state, { type: "system", subtype: "init", session_id: session });
    pushClaudeMessage(state, { type: "assistant", uuid: "a", session_id: session, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_a", name: "mcp__exocortex__attach", input: { paths: ["chart.png"] } }] } });
    pushClaudeMessage(state, { type: "user", uuid: "u", session_id: session, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "Attached 1 image", is_error: false }] } });
    pushClaudeMessage(state, { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", session_id: session });
    const result = finalizeClaudeStream(state);

    expect(results).toEqual([expect.objectContaining({ toolCallId: "toolu_a", images: [ref] })]);
    expect(result.transcriptMessages?.[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "Attached 1 image", is_error: false, attachments: [ref] }],
    });
    expect(takeHostToolAttachments("toolu_a")).toBeUndefined();
  });
});

describe("user_message echo", () => {
  test("large pasted images are echoed as id and size; small ones keep their bytes", () => {
    const big = Buffer.from(Bun.spawnSync(["magick", "-size", "400x300", "plasma:fractal", "png:-"]).stdout);
    const small = Buffer.from(Bun.spawnSync(["magick", "-size", "8x8", "xc:red", "png:-"]).stdout);
    expect(big.toString("base64").length).toBeGreaterThan(ECHO_INLINE_IMAGE_CHARS);
    const echoed = imagesForEcho([
      { mediaType: "image/png", base64: big.toString("base64"), sizeBytes: big.length },
      { mediaType: "image/png", base64: small.toString("base64"), sizeBytes: small.length },
    ])!;
    expect(echoed[0]).toEqual({ mediaType: "image/png", base64: "", sizeBytes: big.length, imageId: imageIdForBytes(big), width: 400, height: 300 });
    expect(echoed[1].base64).toBe(small.toString("base64"));
    expect(imagesForEcho(undefined)).toBeUndefined();
  });
});

describe("get_image", () => {
  function harness() {
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    return { sent, handle: createHandler(server as never) };
  }

  test("serves a bounded PNG preview of a stored image", async () => {
    const { sent, handle } = harness();
    await handle({} as never, { type: "get_image", reqId: "r1", imageId: ref.id, format: "png", width: 100, height: 100 });
    expect(sent[0]).toMatchObject({ type: "image_data", reqId: "r1", imageId: ref.id, format: "png", width: 100, height: 50 });
    expect(sniffImage(Buffer.from(sent[0].base64 as string, "base64"))).toEqual({ mediaType: "image/png", width: 100, height: 50 });
  });

  test("serves a thumbnail it already rendered without reading the image again", async () => {
    const proc = Bun.spawnSync(["magick", "-size", "300x150", "plasma:fractal", "png:-"]);
    const png = Buffer.from(proc.stdout);
    const imageId = putImageBytes(png, "image/png");
    const { sent, handle } = harness();
    const request = { type: "get_image" as const, imageId, format: "png" as const, width: 120, height: 120, purpose: "thumbnail" as const };
    await handle({} as never, { ...request, reqId: "t1" });
    expect(sent[0]).toMatchObject({ type: "image_data", reqId: "t1", width: 120, height: 60 });
    // Gone from the store (and from memory, as after a restart): the rendered thumbnail still answers.
    rmSync(findStoredImage(imageId)!.path);
    attachmentsInternalsForTest.forgetPreviewMemory();
    await handle({} as never, { ...request, reqId: "t2" });
    expect(sent[1]).toMatchObject({ type: "image_data", reqId: "t2", width: 120, height: 60, base64: sent[0].base64 });
    await handle({} as never, { ...request, reqId: "t3", width: 100 });
    expect(sent[2]).toMatchObject({ type: "error", reqId: "t3", message: "get_image: image not found" });
  });

  test("serves exact-size RGBA for character-cell fallbacks", async () => {
    const { sent, handle } = harness();
    await handle({} as never, { type: "get_image", reqId: "r2", imageId: ref.id, format: "rgba", width: 20, height: 10 });
    expect(sent[0]).toMatchObject({ type: "image_data", format: "rgba", width: 20, height: 10 });
    expect(Buffer.from(sent[0].base64 as string, "base64").length).toBe(20 * 10 * 4);
  });

  test("finds a pasted image in its conversation", async () => {
    const convId = `attach-flow-${Date.now()}`;
    create(convId, "openai", "gpt-5.4");
    const proc = Bun.spawnSync(["magick", "-size", "30x30", "xc:teal", "jpeg:-"]);
    const jpeg = Buffer.from(proc.stdout);
    get(convId)!.messages.push({
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } }],
      metadata: null,
    });
    const { sent, handle } = harness();
    const imageId = imageIdForBytes(jpeg);
    await handle({} as never, { type: "get_image", reqId: "r3", convId, imageId, format: "png", width: 64, height: 64 });
    expect(sent[0]).toMatchObject({ type: "image_data", reqId: "r3", width: 30, height: 30 });

    // Without the conversation the pasted image is unknown... until the first
    // preview copied it into the store.
    const again = harness();
    await again.handle({} as never, { type: "get_image", reqId: "r4", imageId, format: "png", width: 64, height: 64 });
    expect(again.sent[0]).toMatchObject({ type: "image_data", reqId: "r4" });
  });

  test("previews a just-sent image before the turn has stored its message", async () => {
    // A TUI asks for its own paste right after send_message; the turn appends
    // the user message only after loading the conversation.
    const convId = `attach-flow-send-${Date.now()}`;
    create(convId, "openai", "gpt-5.4");
    const proc = Bun.spawnSync(["magick", "-size", "24x12", "xc:orange", "png:-"]);
    const png = Buffer.from(proc.stdout);
    const imageId = imageIdForBytes(png);
    const { sent, handle } = harness();
    const turn = handle({} as never, {
      type: "send_message", reqId: "s1", convId, text: "look", startedAt: Date.now(),
      images: [{ mediaType: "image/png", base64: png.toString("base64"), sizeBytes: png.length }],
    });
    await handle({} as never, { type: "get_image", reqId: "s2", convId, imageId, format: "png", width: 64, height: 64 });
    expect(sent.find(event => event.reqId === "s2")).toMatchObject({ type: "image_data", imageId, width: 24, height: 12 });
    await turn;
  });

  test("rejects bad ids, bad sizes, and unknown images", async () => {
    const { sent, handle } = harness();
    await handle({} as never, { type: "get_image", reqId: "e1", imageId: "../../etc/passwd", format: "png", width: 10, height: 10 });
    await handle({} as never, { type: "get_image", reqId: "e2", imageId: ref.id, format: "rgba", width: 4000, height: 4000 });
    await handle({} as never, { type: "get_image", reqId: "e3", imageId: "f".repeat(64), format: "png", width: 10, height: 10 });
    expect(sent).toEqual([
      { type: "error", reqId: "e1", message: "get_image: Invalid image id" },
      { type: "error", reqId: "e2", message: "get_image: rgba previews are limited to 512×512 pixels" },
      { type: "error", reqId: "e3", message: "get_image: image not found" },
    ]);
  });
});

describe("agent loop", () => {
  test("persists attachments on the tool_result and shows them, without sending pixels to the model", async () => {
    const { runAgentLoop } = await import("./agent");
    let calls = 0;
    const seen: unknown[][] = [];
    const fakeStream = (async (_provider: unknown, messages: unknown[]) => {
      seen.push(structuredClone(messages));
      const first = ++calls === 1;
      return {
        text: first ? "" : "Here it is.", thinking: "", stopReason: first ? "tool_use" : "stop",
        blocks: first ? [] : [{ type: "text", text: "Here it is." }],
        toolCalls: first ? [{ id: "call-a", name: "attach", input: { paths: ["chart.png"] } }] : [],
        outputTokens: 10,
      };
    }) as never;
    const shown: unknown[] = [];
    const result = await runAgentLoop([{ role: "user", content: "plot" }], "openai", "gpt-5.4", {
      onBlockStart: () => {}, onTextChunk: () => {}, onThinkingChunk: () => {}, onSignature: () => {},
      onToolCall: () => {}, onToolResult: block => shown.push(block), onTokensUpdate: () => {},
      onContextUpdate: () => {}, onHeaders: () => {},
    }, {
      streamMessageFn: fakeStream,
      executor: async () => [{ toolCallId: "call-a", toolName: "attach", output: "Attached 1 image", isError: false, attachments: [ref] }],
    });

    expect(shown).toEqual([{ type: "tool_result", toolCallId: "call-a", toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] }]);
    expect(result.newMessages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-a", content: "Attached 1 image", is_error: false, attachments: [ref] }],
    });
    // The follow-up request sees a text-only tool result.
    expect(JSON.stringify(seen[1])).not.toContain("\"type\":\"image\"");
  });
});

describe("provider requests", () => {
  test("never carry the daemon-only attachments field", async () => {
    const { buildOpenAIInput } = await import("./providers/openai/request");
    const { buildOpenAICompatibleMessages } = await import("./providers/openai-compatible/request");
    const { renderMessageContent } = await import("./providers/anthropic/prompt");
    const transcript = [
      { role: "user" as const, content: "plot" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "c1", name: "attach", input: { paths: ["chart.png"] } }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "c1", content: "Attached 1 image", attachments: [ref] }] },
    ];
    expect(JSON.stringify(buildOpenAIInput(transcript))).not.toContain(ref.id);
    expect(JSON.stringify(buildOpenAICompatibleMessages(transcript, undefined, { supportsImages: true } as never))).not.toContain(ref.id);
    expect(renderMessageContent(transcript[2].content)).not.toContain(ref.id);
  });
});

describe("sqlite persistence", () => {
  const RECEIPT = "Attached 1 image; the user sees it after your message:\n- chart.png (200×100 PNG, 1 KB)";
  test("attachments survive save/load and /trim, and export copies their files", async () => {
    const { SqliteConversationStore } = await import("./sqlite-conversation-store");
    const { createConversation } = await import("./messages");
    const { trimConversationInPlace } = await import("./conversation-trim");
    const root = mkdtempSync(join(tmpdir(), "exo-attach-sqlite-"));
    try {
      const store = new SqliteConversationStore({ path: join(root, "store.sqlite3") });
      const conv = createConversation("attach-sqlite", "openai", "gpt-5.5", 0, "chart");
      conv.messages.push(
        { role: "user", content: "plot", metadata: null },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "attach", input: { paths: ["chart.png"] } }], metadata: null },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: RECEIPT, attachments: [ref] }], metadata: null },
        { role: "assistant", content: "Here it is.", metadata: null },
      );
      store.save(conv);
      const loaded = store.load("attach-sqlite")!;
      expect(loaded.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: RECEIPT, attachments: [ref] }]);

      expect(trimConversationInPlace(loaded, "toolresults", 1).changed).toBe(true);
      expect(loaded.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "[Output removed by /trim]", attachments: [ref] }]);

      const manifest = store.exportAll(join(root, "export"));
      const exported = join(root, "export", "attachments", `${ref.id}.png`);
      expect(readFileSync(exported).equals(readFileSync(join(dir, "chart.png")))).toBe(true);
      expect(manifest.files[`attachments/${ref.id}.png`]).toMatch(/^[0-9a-f]{64}$/);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
