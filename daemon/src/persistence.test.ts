/**
 * Unit tests for persistence.ts — migration chain and public API.
 *
 * Migration functions are not exported, so all tests go through the public
 * save / load / loadAll interface. Fixture files are written directly to an
 * isolated temporary conversations directory so tests never touch live chats.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { conversationsDir } from "@exocortex/shared/paths";
import { save, load, loadAll } from "./persistence";
import type { Conversation } from "./messages";
import { DEFAULT_EFFORT, historyPrefixHash } from "./messages";

// ── Helpers ───────────────────────────────────────────────────────────

const CONV_DIR = conversationsDir();

/** IDs of every fixture file created during tests — cleaned up in afterAll. */
const createdIds: string[] = [];

/** Make a unique test ID and register it for cleanup. */
function mkId(suffix: string): string {
  const id = `test-persist-${suffix}`;
  createdIds.push(id);
  return id;
}

/** Write a raw JSON object as a fixture file at the given conversation ID. */
function writeFixture(id: string, data: Record<string, unknown>): void {
  writeFileSync(join(CONV_DIR, `${id}.json`), JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(CONV_DIR, { recursive: true });
});

afterAll(() => {
  for (const id of createdIds) {
    try {
      rmSync(join(CONV_DIR, `${id}.json`));
    } catch {
      // file may have already been removed or never written
    }
  }
});

// ── V1 → V11 ─────────────────────────────────────────────────────────
//
// V1 format: ApiMessage[] (role + content only, no metadata field).
// Expectations after full migration chain:
//   V1→V2   messages gain metadata: null
//   V2→V3   lastContextTokens: null
//   V3→V4   marked: false
//   V4→V5   pinned: false
//   V5→V6   sortOrder: -updatedAt
//   V6→V7   title: null
//   V7→V8   title: legacyPreview(messages)
//   V8→V9   effort: DEFAULT_EFFORT
//   V9→V10  provider: "openai"
//   V10→V11 fastMode: false

describe("V1 migration", () => {
  test("messages get metadata: null", () => {
    const id = mkId("v1-metadata");
    writeFixture(id, {
      version: 1,
      id,
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "Hello from v1" },
        { role: "assistant", content: "Hi there" },
      ],
      createdAt: 1_000_000,
      updatedAt: 1_000_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.messages).toHaveLength(2);
    for (const msg of conv!.messages) {
      expect(msg.metadata).toBeNull();
    }
  });

  test("all fields from later migrations are correctly defaulted", () => {
    const id = mkId("v1-defaults");
    writeFixture(id, {
      version: 1,
      id,
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Testing defaults" }],
      createdAt: 1_200_000,
      updatedAt: 1_200_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.lastContextTokens).toBeNull();     // V2→V3
    expect(conv!.marked).toBe(false);               // V3→V4
    expect(conv!.pinned).toBe(false);               // V4→V5
    expect(conv!.sortOrder).toBe(-1_200_001);       // V5→V6
    expect(conv!.title).toBe("Testing defaults");   // V7→V8 via legacyPreview
    expect(conv!.effort).toBe(DEFAULT_EFFORT);      // V8→V9
  });

  test("file with no version field treated as V1", () => {
    // The migrate() function defaults: (data.version ?? 1) < 2
    const id = mkId("v1-no-version-field");
    writeFixture(id, {
      // no version key
      id,
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "No version present" }],
      createdAt: 2_000_000,
      updatedAt: 2_000_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.messages[0].metadata).toBeNull();
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });

  test("legacyPreview truncates long string content at 80 chars", () => {
    const id = mkId("v1-preview-truncation");
    const long = "x".repeat(100);
    writeFixture(id, {
      version: 1,
      id,
      model: "gpt-5.5",
      messages: [{ role: "user", content: long }],
      createdAt: 3_000_000,
      updatedAt: 3_000_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("x".repeat(80));
  });
});

describe("V2 migration", () => {
  test("loads with lastContextTokens: null and all later defaults", () => {
    const id = mkId("v2-defaults");
    writeFixture(id, {
      version: 2,
      id,
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "Hello", metadata: null },
        { role: "assistant", content: "World", metadata: null },
      ],
      createdAt: 4_000_000,
      updatedAt: 4_000_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.lastContextTokens).toBeNull();
    expect(conv!.marked).toBe(false);
    expect(conv!.pinned).toBe(false);
    expect(conv!.sortOrder).toBe(-4_000_001);
    expect(conv!.title).toBe("Hello");
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });

  test("message metadata (non-null) is preserved through migration", () => {
    const id = mkId("v2-preserve-metadata");
    writeFixture(id, {
      version: 2,
      id,
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: "Preserve me",
          metadata: { startedAt: 111, endedAt: 222, model: "gpt-5.5", tokens: 33 },
        },
      ],
      createdAt: 5_000_000,
      updatedAt: 5_000_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.messages[0].metadata).toEqual({ startedAt: 111, endedAt: 222, model: "gpt-5.5", tokens: 33 });
  });
});

describe("V5 migration", () => {
  test("sortOrder derived from -updatedAt", () => {
    const id = mkId("v5-sortorder");
    writeFixture(id, {
      version: 5,
      id,
      model: "gpt-5.5",
      messages: [],
      createdAt: 6_000_000,
      updatedAt: 6_123_456,
      lastContextTokens: 99_999,
      marked: false,
      pinned: false,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.sortOrder).toBe(-6_123_456);
  });

  test("existing marked/pinned flags are preserved", () => {
    const id = mkId("v5-flags");
    writeFixture(id, {
      version: 5,
      id,
      model: "gpt-5.5",
      messages: [],
      createdAt: 6_500_000,
      updatedAt: 6_500_001,
      lastContextTokens: null,
      marked: true,
      pinned: true,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.marked).toBe(true);
    expect(conv!.pinned).toBe(true);
  });
});

describe("V7 migration", () => {
  test("null title: preview from first user string message", () => {
    const id = mkId("v7-title-from-string");
    writeFixture(id, {
      version: 7,
      id,
      model: "gpt-5.5",
      messages: [
        { role: "assistant", content: "ignore", metadata: null },
        { role: "user", content: "First user text", metadata: null },
      ],
      createdAt: 7_000_000,
      updatedAt: 7_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_000_001,
      title: null,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("First user text");
  });

  test("null title: preview from first user text block in array content", () => {
    const id = mkId("v7-title-from-block");
    writeFixture(id, {
      version: 7,
      id,
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
            { type: "text", text: "Caption here" },
          ],
          metadata: null,
        },
      ],
      createdAt: 7_100_000,
      updatedAt: 7_100_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_100_001,
      title: null,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("Caption here");
  });

  test("null title: image-only first user message yields '📎 Image'", () => {
    const id = mkId("v7-title-image-only");
    writeFixture(id, {
      version: 7,
      id,
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
          metadata: null,
        },
      ],
      createdAt: 7_200_000,
      updatedAt: 7_200_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_200_001,
      title: null,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("📎 Image");
  });

  test("null title with no user messages yields empty string", () => {
    const id = mkId("v7-title-no-user");
    writeFixture(id, {
      version: 7,
      id,
      model: "gpt-5.5",
      messages: [{ role: "assistant", content: "Only assistant", metadata: null }],
      createdAt: 7_300_000,
      updatedAt: 7_300_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_300_001,
      title: null,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("");
  });

  test("non-null title is kept unchanged", () => {
    const id = mkId("v7-title-preserved");
    writeFixture(id, {
      version: 7,
      id,
      model: "gpt-5.5",
      messages: [{ role: "user", content: "ignored", metadata: null }],
      createdAt: 7_400_000,
      updatedAt: 7_400_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_400_001,
      title: "Keep this title",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("Keep this title");
  });

  test("legacyPreview skips assistant messages and uses first user message", () => {
    const id = mkId("v7-legacy-preview-skip-assistant");
    writeFixture(id, {
      version: 7,
      id,
      model: "gpt-5.5",
      messages: [
        { role: "assistant", content: "Assistant text", metadata: null },
        { role: "user", content: "User text wins", metadata: null },
      ],
      createdAt: 7_500_000,
      updatedAt: 7_500_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_500_001,
      title: null,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("User text wins");
  });

  test("legacyPreview truncates text block content at 80 chars", () => {
    const id = mkId("v7-legacy-preview-truncate-block");
    const long = "y".repeat(100);
    writeFixture(id, {
      version: 7,
      id,
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: long }],
          metadata: null,
        },
      ],
      createdAt: 7_600_000,
      updatedAt: 7_600_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_600_001,
      title: null,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("y".repeat(80));
  });
});

describe("V8 migration", () => {
  test("effort defaults to DEFAULT_EFFORT", () => {
    const id = mkId("v8-effort-default");
    writeFixture(id, {
      version: 8,
      id,
      model: "gpt-5.5",
      messages: [],
      createdAt: 8_000_000,
      updatedAt: 8_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -8_000_001,
      title: "V8 chat",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });

  test("all existing V8 fields are preserved unchanged", () => {
    const id = mkId("v8-preserve");
    writeFixture(id, {
      version: 8,
      id,
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hello", metadata: null }],
      createdAt: 8_100_000,
      updatedAt: 8_100_123,
      lastContextTokens: 321,
      marked: true,
      pinned: false,
      sortOrder: -8_100_123,
      title: "already titled",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("already titled");
    expect(conv!.marked).toBe(true);
    expect(conv!.lastContextTokens).toBe(321);
  });
});

describe("V9 migration", () => {
  test("adds openai as the default provider while preserving existing fields", () => {
    const id = mkId("v9-provider-default");
    writeFixture(id, {
      version: 9,
      id,
      model: "gpt-5.4-mini",
      effort: "low",
      messages: [{ role: "user", content: "hello", metadata: null }],
      createdAt: 9_000_000,
      updatedAt: 9_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -9_000_001,
      title: "V9",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.provider).toBe("openai");
    expect(conv!.effort).toBe("low");
  });
});

describe("V10 migration", () => {
  test("fastMode defaults to false while preserving existing fields", () => {
    const id = mkId("v10-fastmode-default");
    writeFixture(id, {
      version: 10,
      id,
      provider: "openai",
      model: "gpt-5.4",
      effort: "medium",
      messages: [{ role: "user", content: "hello", metadata: null }],
      createdAt: 10_000_000,
      updatedAt: 10_000_001,
      lastContextTokens: 42,
      marked: true,
      pinned: true,
      sortOrder: -10_000_001,
      title: "V10",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.fastMode).toBe(false);
    expect(conv!.provider).toBe("openai");
    expect(conv!.pinned).toBe(true);
  });
});

describe("error handling", () => {
  test("corrupt JSON file returns null", () => {
    const id = mkId("corrupt-json");
    writeFileSync(join(CONV_DIR, `${id}.json`), "{ not valid json !!! ", {
      mode: 0o600,
    });

    const conv = load(id);
    expect(conv).toBeNull();
  });

  test("missing file returns null", () => {
    const conv = load("this-id-does-not-exist");
    expect(conv).toBeNull();
  });
});

describe("save / load round-trip", () => {
  test("persists a valid compact replay separately from the visible transcript", () => {
    const id = mkId("active-context-roundtrip");
    const conv: Conversation = {
      id,
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "medium",
      fastMode: false,
      messages: [
        { role: "user", content: "full old prompt", metadata: null },
        { role: "assistant", content: "full old answer", metadata: null },
      ],
      createdAt: 13_500_000,
      updatedAt: 13_500_001,
      lastContextTokens: 123,
      marked: false,
      pinned: false,
      sortOrder: -13_500_001,
      title: "Active context",
    };
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      accountScope: "acct",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 2,
      transcriptPrefixHash: historyPrefixHash(conv.messages, 2),
      windowId: `${id}:1`,
      windowNumber: 1,
      compactedAt: 13_500_001,
      compactionCount: 1,
    };

    save(conv);
    expect(load(id)).toEqual(conv);
  });

  test("discards a stale compact replay but keeps the full transcript loadable", () => {
    const id = mkId("stale-active-context");
    writeFixture(id, {
      version: 14,
      id,
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "medium",
      fastMode: false,
      messages: [{ role: "user", content: "edited transcript", metadata: null }],
      activeContext: {
        version: 1,
        kind: "openai_native",
        provider: "openai",
        model: "gpt-5.6-sol",
        messages: [{ role: "assistant", content: [] }],
        transcriptHistoryCount: 1,
        transcriptPrefixHash: "not-the-real-hash",
        windowId: `${id}:1`,
        windowNumber: 1,
        compactedAt: 1,
        compactionCount: 1,
      },
      createdAt: 1,
      updatedAt: 2,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -2,
      folderId: null,
      title: "Stale context",
      goal: null,
    });

    const loaded = load(id);
    expect(loaded?.messages[0].content).toBe("edited transcript");
    expect(loaded?.activeContext).toBeUndefined();
    expect(loaded?.lastContextTokens).toBeNull();
  });

  test("save then load returns a deeply equal conversation", () => {
    const id = mkId("roundtrip-basic");
    const original: Conversation = {
      id,
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: true,
      messages: [
        { role: "user", content: "Hello", metadata: null },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking...", signature: "sig" },
            { type: "text", text: "Hi there" },
          ],
          metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.4", tokens: 123 },
        },
      ],
      createdAt: 11_000_000,
      updatedAt: 11_000_001,
      lastContextTokens: 2048,
      marked: true,
      pinned: false,
      sortOrder: -11_000_001,
      title: "Roundtrip Chat",
    };

    save(original);
    const loaded = load(id);
    expect(loaded).toEqual(original);
  });

  test("saving again overwrites the file with the new data", () => {
    const id = mkId("roundtrip-overwrite");
    const a: Conversation = {
      id,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      messages: [{ role: "user", content: "First", metadata: null }],
      createdAt: 12_000_000,
      updatedAt: 12_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -12_000_001,
      title: "A",
    };
    const b: Conversation = {
      ...a,
      provider: "openai",
      model: "gpt-5.4",
      fastMode: true,
      messages: [{ role: "user", content: "Second", metadata: null }],
      updatedAt: 12_000_999,
      sortOrder: -12_000_999,
      title: "B",
    };

    save(a);
    save(b);
    const loaded = load(id);
    expect(loaded).toEqual(b);
  });

  test("all EffortLevel values survive round-trip", () => {
    const efforts: Conversation["effort"][] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

    for (const effort of efforts) {
      const id = mkId(`roundtrip-effort-${effort}`);
      const conv: Conversation = {
        id,
        provider: "openai",
        model: "gpt-5.4",
        effort,
        fastMode: false,
        messages: [{ role: "user", content: `effort=${effort}`, metadata: null }],
        createdAt: 13_000_000,
        updatedAt: 13_000_001,
        lastContextTokens: null,
        marked: false,
        pinned: false,
        sortOrder: -13_000_001,
        title: `Effort ${effort}`,
      };
      save(conv);
      expect(load(id)).toEqual(conv);
    }
  });

  test("legacy completed goals are treated as cleared on load", () => {
    const id = mkId("completed-goal-load");
    writeFixture(id, {
      version: 13,
      id,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      messages: [{ role: "user", content: "Done", metadata: null }],
      createdAt: 14_000_000,
      updatedAt: 14_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -14_000_001,
      folderId: null,
      title: "Completed goal",
      goal: {
        objective: "already finished",
        status: "complete",
        createdAt: 14_000_000,
        updatedAt: 14_000_001,
        turns: 1,
      },
    });

    expect(load(id)?.goal).toBeUndefined();
  });
});

describe("loadAll()", () => {
  test("returns summaries for all valid conversation files in the directory", () => {
    const idOld = mkId("loadall-old");
    const idMid = mkId("loadall-mid");
    const idNew = mkId("loadall-new");

    writeFixture(idOld, {
      version: 10,
      id: idOld,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      messages: [{ role: "user", content: "old", metadata: null }],
      createdAt: 0,
      updatedAt: 100,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 100,
      title: "Old",
    });
    writeFixture(idMid, {
      version: 10,
      id: idMid,
      provider: "openai",
      model: "gpt-5.4",
      effort: "medium",
      messages: [{ role: "user", content: "mid", metadata: null }],
      createdAt: 0,
      updatedAt: 200,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 50,
      title: "Mid",
    });
    writeFixture(idNew, {
      version: 10,
      id: idNew,
      provider: "openai",
      model: "gpt-5.5",
      effort: "low",
      messages: [
        { role: "user", content: "new", metadata: null },
        { role: "assistant", content: "reply", metadata: null },
      ],
      createdAt: 0,
      updatedAt: 300,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -10,
      title: "New",
    });

    const all = loadAll();
    const ours = all.filter((c) => [idOld, idMid, idNew].includes(c.id));

    expect(ours).toHaveLength(3);
    expect(ours.map((c) => c.id)).toEqual([idNew, idMid, idOld]);
    expect(ours.find((c) => c.id === idNew)?.messageCount).toBe(2);
  });

  test("messageCount excludes system_instructions entries", () => {
    const id = mkId("loadall-system-instructions");
    writeFixture(id, {
      version: 10,
      id,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      messages: [
        { role: "system_instructions", content: "be terse", metadata: null },
        { role: "user", content: "hello", metadata: null },
        { role: "assistant", content: "hi", metadata: null },
      ],
      createdAt: 0,
      updatedAt: 0,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 0,
      title: "With system instructions",
    });

    const all = loadAll();
    const summary = all.find((c) => c.id === id);
    expect(summary).toBeDefined();
    expect(summary!.messageCount).toBe(2);
  });

  test("summaries are sorted by sortOrder ascending (lower = first)", () => {
    const ids = [mkId("sort-a"), mkId("sort-b"), mkId("sort-c")];
    const sortOrders = [20, -5, 7];

    for (let i = 0; i < ids.length; i++) {
      writeFixture(ids[i], {
        version: 10,
        id: ids[i],
        provider: "openai",
        model: "gpt-5.5",
        effort: "high",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
        lastContextTokens: null,
        marked: false,
        pinned: false,
        sortOrder: sortOrders[i],
        title: ids[i],
      });
    }

    const all = loadAll();
    const ours = all.filter((c) => ids.includes(c.id));
    expect(ours).toHaveLength(3);
    expect(ours.map((c) => c.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  test("pinned conversations appear before unpinned regardless of sortOrder", () => {
    const idPinned = mkId("pinned");
    const idUnpinned = mkId("unpinned");

    writeFixture(idPinned, {
      version: 10,
      id: idPinned,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      lastContextTokens: null,
      marked: false,
      pinned: true,
      sortOrder: 999,
      title: "Pinned",
    });
    writeFixture(idUnpinned, {
      version: 10,
      id: idUnpinned,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 1,
      title: "Unpinned",
    });

    const all = loadAll();
    const ours = all.filter((c) => [idPinned, idUnpinned].includes(c.id));
    expect(ours).toHaveLength(2);
    expect(ours[0].id).toBe(idPinned);
    expect(ours[1].id).toBe(idUnpinned);
  });

  test("corrupt files are silently skipped, valid files are still returned", () => {
    const idGood = mkId("loadall-good");
    const idBad = mkId("loadall-bad");

    writeFixture(idGood, {
      version: 10,
      id: idGood,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 0,
      title: "Good",
    });
    writeFileSync(join(CONV_DIR, `${idBad}.json`), "{ bad json", {
      mode: 0o600,
    });

    const all = loadAll();
    expect(all.find((c) => c.id === idGood)).toBeDefined();
    expect(all.find((c) => c.id === idBad)).toBeUndefined();
  });

  test("V8 files loaded via loadAll() have effort: DEFAULT_EFFORT", () => {
    const id = mkId("loadall-v8");
    writeFixture(id, {
      version: 8,
      id,
      model: "gpt-5.5",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 0,
      title: "V8 summary",
    });

    const all = loadAll();
    const summary = all.find((c) => c.id === id);
    expect(summary).toBeDefined();
    expect(summary!.effort).toBe(DEFAULT_EFFORT);
  });

  test("files not ending in .json are ignored", () => {
    const fakePath = join(CONV_DIR, "test-persist-not-json.txt");
    writeFileSync(fakePath, "not json at all", { mode: 0o600 });

    expect(() => loadAll()).not.toThrow();

    try {
      rmSync(fakePath);
    } catch {
      /* ignore */
    }
  });

  test("legacy completed goals are omitted from summaries", () => {
    const id = mkId("loadall-completed-goal");
    writeFixture(id, {
      version: 13,
      id,
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      messages: [{ role: "user", content: "Done", metadata: null }],
      createdAt: 17_000_000,
      updatedAt: 17_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -17_000_001,
      folderId: null,
      title: "Completed goal summary",
      goal: {
        objective: "already finished",
        status: "complete",
        createdAt: 17_000_000,
        updatedAt: 17_000_001,
        turns: 1,
      },
    });

    const summary = loadAll().find((c) => c.id === id);

    expect(summary).toBeDefined();
    expect(summary!.goal).toBeNull();
  });
});
