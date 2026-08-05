import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quarantineActiveContext } from "./active-context-quarantine";
import type { ActiveContext } from "./messages";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkpoint(): ActiveContext {
  return {
    version: 1,
    kind: "openai_native",
    provider: "openai",
    model: "gpt-5.6-sol",
    messages: [{
      role: "assistant",
      content: [],
      providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
    }],
    transcriptHistoryCount: 2,
    transcriptPrefixHash: "1".repeat(24),
    compactionHistoryCount: 2,
    compactionPrefixHash: "1".repeat(24),
    windowId: "conv-1:1",
    windowNumber: 1,
    compactedAt: 100,
    compactionCount: 1,
  };
}

describe("active-context quarantine", () => {
  test("atomically preserves the exact rejected checkpoint in a private recovery file", () => {
    const root = mkdtempSync(join(tmpdir(), "active-context-quarantine-"));
    roots.push(root);
    const active = checkpoint();

    const path = quarantineActiveContext("conv-1", active, "integrity validation failed", {
      root,
      now: 123,
      nonce: "test",
    });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      conversationId: "conv-1",
      quarantinedAt: 123,
      reason: "integrity validation failed",
      activeContext: active,
    });
    // Windows exposes inherited ACLs rather than meaningful POSIX mode bits;
    // Node reports 0o666 even after chmodSync. The file remains protected by
    // the user's profile/temp-directory DACL.
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("refuses unsafe IDs before writing anything", () => {
    const root = mkdtempSync(join(tmpdir(), "active-context-quarantine-"));
    roots.push(root);
    expect(() => quarantineActiveContext("../escape", checkpoint(), "bad", { root })).toThrow("Unsafe conversation ID");
  });
});
