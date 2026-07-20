import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, utimesSync } from "fs";
import { join } from "path";
import { conversationsDir, dataDir } from "@exocortex/shared/paths";
import { create, flush, get, markDirty, unwindTo } from "./conversations";
import {
  hasFreshDisplayProjection,
  loadDisplayPage,
  writeDisplayProjection,
} from "./display-page-store";

let sequence = 0;
function id(label: string): string {
  return `display-pages-${label}-${Date.now()}-${++sequence}`;
}

function addTextTurn(convId: string, user: string, assistant: string): void {
  const conv = get(convId)!;
  conv.messages.push(
    { role: "user", content: user, metadata: null },
    { role: "assistant", content: assistant, metadata: null },
  );
}

function projectionText(convId: string): string {
  const root = join(dataDir(), "display-pages", convId);
  const parts: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) parts.push(readFileSync(join(root, entry.name), "utf8"));
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(root, entry.name))) {
      parts.push(readFileSync(join(root, entry.name, file), "utf8"));
    }
  }
  return parts.join("\n");
}

describe("display page store", () => {
  test("reads newest and older user-turn pages with bounded persisted payloads", () => {
    const convId = id("page");
    const conv = create(convId, "openai", "gpt-5.6-sol", "paged");
    conv.messages.push({ role: "system_instructions", content: "Be concise.", metadata: null });
    addTextTurn(convId, "u1", "a1");
    conv.messages.push(
      {
        role: "user",
        content: [
          { type: "text", text: "u2 image" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "SECRET_IMAGE_BASE64" } },
        ],
        metadata: null,
      },
      { role: "assistant", content: "a2", metadata: null },
    );
    addTextTurn(convId, "u3", "a3");
    conv.messages.push(
      { role: "user", content: "u4", metadata: null },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "echo ok" } }],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "SECRET_TOOL_OUTPUT" }],
        metadata: null,
      },
      { role: "assistant", content: "a4", metadata: null },
    );
    addTextTurn(convId, "u5", "a5");
    conv.messages.push(
      {
        role: "user",
        content: [
          { type: "text", text: "u6 recent image" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "RECENT_IMAGE_BASE64" } },
        ],
        metadata: null,
      },
      { role: "assistant", content: "a6", metadata: null },
    );
    markDirty(convId);
    flush(convId);
    expect(writeDisplayProjection(conv)).toBe(true);

    expect(hasFreshDisplayProjection(convId)).toBe(true);
    const newest = loadDisplayPage(convId, 2)!;
    expect(newest).toMatchObject({
      startUserIndex: 4,
      endIndex: 12,
      totalEntries: 12,
      hasOlder: true,
      toolOutputsIncluded: false,
      pinnedEntries: [{ type: "system_instructions", text: "Be concise." }],
    });
    expect(newest.entries.filter((entry) => entry.type === "user").map((entry) => entry.text)).toEqual(["u5", "u6 recent image"]);
    expect(newest.entries.find((entry) => entry.type === "user")?.unwindFingerprint).toMatch(/^page-v1:/);
    expect(JSON.stringify(newest.entries)).not.toContain("SECRET_TOOL_OUTPUT");
    expect(JSON.stringify(newest.entries)).toContain("RECENT_IMAGE_BASE64");

    const older = loadDisplayPage(convId, 4, newest.startIndex)!;
    expect(older).toMatchObject({ startIndex: 0, startUserIndex: 0, endIndex: 8, hasOlder: false });
    expect(older.entries.filter((entry) => entry.type === "user").map((entry) => entry.text)).toEqual(["u1", "u2 image", "u3", "u4"]);
    expect(JSON.stringify(older.entries)).not.toContain("SECRET_IMAGE_BASE64");
    expect(projectionText(convId)).not.toContain("SECRET_IMAGE_BASE64");
    expect(projectionText(convId)).toContain("RECENT_IMAGE_BASE64");
    expect(projectionText(convId)).not.toContain("SECRET_TOOL_OUTPUT");
  });

  test("rejects a projection when the canonical source signature changes", () => {
    const convId = id("stale");
    create(convId, "openai", "gpt-5.6-sol", "stale");
    addTextTurn(convId, "hello", "world");
    markDirty(convId);
    flush(convId);
    expect(writeDisplayProjection(get(convId)!)).toBe(true);
    expect(loadDisplayPage(convId, 5)).not.toBeNull();

    const path = join(conversationsDir(), `${convId}.json`);
    const stat = statSync(path);
    const changed = new Date(stat.mtimeMs + 10_000);
    utimesSync(path, changed, changed);
    expect(hasFreshDisplayProjection(convId)).toBe(false);
    expect(loadDisplayPage(convId, 5)).toBeNull();
  });

  test("accepts page fingerprints for targeted unwind and republishes the cut", async () => {
    const convId = id("unwind");
    create(convId, "openai", "gpt-5.6-sol", "unwind");
    addTextTurn(convId, "keep 1", "answer 1");
    addTextTurn(convId, "keep 2", "answer 2");
    addTextTurn(convId, "remove", "answer 3");
    markDirty(convId);
    flush(convId);
    expect(writeDisplayProjection(get(convId)!)).toBe(true);

    const before = loadDisplayPage(convId, 1)!;
    const target = before.entries.find((entry) => entry.type === "user")!;
    expect(target.unwindFingerprint).toMatch(/^page-v1:/);
    expect(await unwindTo(convId, 2, "page-fingerprint-unwind", undefined, target.unwindFingerprint)).not.toBeNull();
    expect(writeDisplayProjection(get(convId)!)).toBe(true);

    const after = loadDisplayPage(convId, 5)!;
    expect(after.totalEntries).toBe(4);
    expect(after.entries.filter((entry) => entry.type === "user").map((entry) => entry.text)).toEqual(["keep 1", "keep 2"]);
  });
});
