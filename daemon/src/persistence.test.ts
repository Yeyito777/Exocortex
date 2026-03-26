/**
 * Unit tests for persistence.ts — migration chain and public API.
 *
 * Migration functions are not exported, so all tests go through the public
 * save / load / loadAll interface.  Fixture files at various schema versions
 * are written directly to the worktree-isolated conversations directory and
 * loaded, exercising every migration step in the chain.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { conversationsDir } from "@exocortex/shared/paths";
import { save, load, loadAll } from "./persistence";
import type { Conversation } from "./messages";
import { DEFAULT_EFFORT } from "./messages";

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

// ── V1 → V9 ──────────────────────────────────────────────────────────
//
// V1 format: ApiMessage[] (role + content only, no metadata field).
// Expectations after full migration chain:
//   V1→V2  messages gain  metadata: null
//   V2→V3  lastContextTokens: null
//   V3→V4  marked: false
//   V4→V5  pinned: false
//   V5→V6  sortOrder: -updatedAt
//   V6→V7  title: null
//   V7→V8  title: legacyPreview(messages)
//   V8→V9  effort: DEFAULT_EFFORT

describe("V1 migration", () => {
  test("messages get metadata: null", () => {
    const id = mkId("v1-metadata");
    writeFixture(id, {
      version: 1,
      id,
      model: "sonnet",
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
      model: "sonnet",
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
      model: "haiku",
      messages: [{ role: "user", content: "Versionless" }],
      createdAt: 1_300_000,
      updatedAt: 1_300_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.messages[0].metadata).toBeNull();
    expect(conv!.sortOrder).toBe(-1_300_001);
    expect(conv!.title).toBe("Versionless");
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });

  test("legacyPreview truncates long string content at 80 chars", () => {
    const id = mkId("v1-long-content");
    const longText = "X".repeat(200);
    writeFixture(id, {
      version: 1,
      id,
      model: "sonnet",
      messages: [{ role: "user", content: longText }],
      createdAt: 1_400_000,
      updatedAt: 1_400_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("X".repeat(80));
  });
});

// ── V2 → V9 ──────────────────────────────────────────────────────────
//
// V2: added metadata field on messages (StoredMessage).
// After migration: lastContextTokens: null (V3), plus all later defaults.

describe("V2 migration", () => {
  test("loads with lastContextTokens: null and all later defaults", () => {
    const id = mkId("v2-basic");
    writeFixture(id, {
      version: 2,
      id,
      model: "haiku",
      messages: [{ role: "user", content: "Hello v2", metadata: null }],
      createdAt: 2_000_000,
      updatedAt: 2_000_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.lastContextTokens).toBeNull();
    expect(conv!.marked).toBe(false);
    expect(conv!.pinned).toBe(false);
    expect(conv!.sortOrder).toBe(-2_000_001);
    expect(conv!.title).toBe("Hello v2");
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });

  test("message metadata (non-null) is preserved through migration", () => {
    const id = mkId("v2-metadata-preserved");
    const meta = { startedAt: 2_100_000, endedAt: 2_100_500, model: "haiku" as const, tokens: 77 };
    writeFixture(id, {
      version: 2,
      id,
      model: "haiku",
      messages: [
        { role: "user", content: "Question", metadata: null },
        { role: "assistant", content: "Answer", metadata: meta },
      ],
      createdAt: 2_100_000,
      updatedAt: 2_100_001,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.messages[0].metadata).toBeNull();
    expect(conv!.messages[1].metadata).toEqual(meta);
  });
});

// ── V5 → V9 ──────────────────────────────────────────────────────────
//
// V5: added pinned flag.  V5→V6 adds sortOrder = -updatedAt.

describe("V5 migration", () => {
  test("sortOrder derived from -updatedAt", () => {
    const id = mkId("v5-sort-order");
    writeFixture(id, {
      version: 5,
      id,
      model: "sonnet",
      messages: [{ role: "user", content: "Hello v5", metadata: null }],
      createdAt: 5_000_000,
      updatedAt: 5_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.sortOrder).toBe(-5_000_001);
  });

  test("existing marked/pinned flags are preserved", () => {
    const id = mkId("v5-flags");
    writeFixture(id, {
      version: 5,
      id,
      model: "sonnet",
      messages: [{ role: "user", content: "Flags", metadata: null }],
      createdAt: 5_100_000,
      updatedAt: 5_100_001,
      lastContextTokens: 42,
      marked: true,
      pinned: false,
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.marked).toBe(true);
    expect(conv!.pinned).toBe(false);
    expect(conv!.lastContextTokens).toBe(42);
    expect(conv!.title).toBe("Flags");
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });
});

// ── V7 → V9 ──────────────────────────────────────────────────────────
//
// V7: added nullable title.  V7→V8 makes title non-nullable:
//   null title  →  legacyPreview(messages)
//   non-null title  →  kept as-is

describe("V7 migration", () => {
  test("null title: preview from first user string message", () => {
    const id = mkId("v7-null-string");
    writeFixture(id, {
      version: 7,
      id,
      model: "sonnet",
      messages: [
        { role: "user", content: "Hello from v7", metadata: null },
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
    expect(conv!.title).toBe("Hello from v7");
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });

  test("null title: preview from first user text block in array content", () => {
    const id = mkId("v7-null-text-block");
    writeFixture(id, {
      version: 7,
      id,
      model: "sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Block text in v7" }],
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
    expect(conv!.title).toBe("Block text in v7");
  });

  test("null title: image-only first user message yields '📎 Image'", () => {
    const id = mkId("v7-null-image-only");
    writeFixture(id, {
      version: 7,
      id,
      model: "sonnet",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
          ],
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
    const id = mkId("v7-null-no-user");
    writeFixture(id, {
      version: 7,
      id,
      model: "sonnet",
      messages: [
        { role: "assistant", content: "Assistant only", metadata: null },
      ],
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
    const id = mkId("v7-explicit-title");
    writeFixture(id, {
      version: 7,
      id,
      model: "haiku",
      messages: [{ role: "user", content: "Ignored", metadata: null }],
      createdAt: 7_400_000,
      updatedAt: 7_400_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -7_400_001,
      title: "Preserved Title",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("Preserved Title");
  });

  test("legacyPreview skips assistant messages and uses first user message", () => {
    const id = mkId("v7-skip-assistant");
    writeFixture(id, {
      version: 7,
      id,
      model: "sonnet",
      messages: [
        { role: "assistant", content: "Assistant first", metadata: null },
        { role: "user", content: "User second", metadata: null },
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
    expect(conv!.title).toBe("User second");
  });

  test("legacyPreview truncates text block content at 80 chars", () => {
    const id = mkId("v7-long-block");
    const longText = "B".repeat(150);
    writeFixture(id, {
      version: 7,
      id,
      model: "sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: longText }],
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
    expect(conv!.title).toBe("B".repeat(80));
  });
});

// ── V8 → V9 ──────────────────────────────────────────────────────────
//
// V8: made title non-nullable (string).  V8→V9 adds effort: DEFAULT_EFFORT.

describe("V8 migration", () => {
  test("effort defaults to DEFAULT_EFFORT", () => {
    const id = mkId("v8-effort");
    writeFixture(id, {
      version: 8,
      id,
      model: "sonnet",
      messages: [{ role: "user", content: "Hello v8", metadata: null }],
      createdAt: 8_000_000,
      updatedAt: 8_000_001,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -8_000_001,
      title: "My v8 title",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });

  test("all existing V8 fields are preserved unchanged", () => {
    const id = mkId("v8-fields");
    writeFixture(id, {
      version: 8,
      id,
      model: "opus",
      messages: [{ role: "user", content: "V8 fields", metadata: null }],
      createdAt: 8_100_000,
      updatedAt: 8_100_001,
      lastContextTokens: 128,
      marked: true,
      pinned: true,
      sortOrder: 42,
      title: "Preserved v8 title",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.model).toBe("opus");
    expect(conv!.createdAt).toBe(8_100_000);
    expect(conv!.updatedAt).toBe(8_100_001);
    expect(conv!.lastContextTokens).toBe(128);
    expect(conv!.marked).toBe(true);
    expect(conv!.pinned).toBe(true);
    expect(conv!.sortOrder).toBe(42);
    expect(conv!.title).toBe("Preserved v8 title");
    expect(conv!.effort).toBe(DEFAULT_EFFORT);
  });
});

// ── V9 (current) ─────────────────────────────────────────────────────

describe("V9 — current schema", () => {
  test("loads all fields as-is without modification", () => {
    const id = mkId("v9-current");
    const assistantMeta = {
      startedAt: 9_000_000,
      endedAt: 9_000_100,
      model: "opus" as const,
      tokens: 10,
    };
    writeFixture(id, {
      version: 9,
      id,
      model: "opus",
      effort: "low",
      messages: [
        { role: "user", content: "Hello v9", metadata: null },
        {
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
          metadata: assistantMeta,
        },
      ],
      createdAt: 9_000_000,
      updatedAt: 9_000_001,
      lastContextTokens: 512,
      marked: true,
      pinned: true,
      sortOrder: 7,
      title: "My v9 conversation",
    });

    const conv = load(id);
    expect(conv).not.toBeNull();
    expect(conv!.id).toBe(id);
    expect(conv!.model).toBe("opus");
    expect(conv!.effort).toBe("low");
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.createdAt).toBe(9_000_000);
    expect(conv!.updatedAt).toBe(9_000_001);
    expect(conv!.lastContextTokens).toBe(512);
    expect(conv!.marked).toBe(true);
    expect(conv!.pinned).toBe(true);
    expect(conv!.sortOrder).toBe(7);
    expect(conv!.title).toBe("My v9 conversation");
    expect(conv!.messages[1].metadata).toEqual(assistantMeta);
  });
});

// ── Error handling ────────────────────────────────────────────────────

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
    const conv = load("nonexistent-id-that-definitely-does-not-exist");
    expect(conv).toBeNull();
  });
});

// ── save() / load() round-trip ────────────────────────────────────────

describe("save / load round-trip", () => {
  test("save then load returns a deeply equal conversation", () => {
    const id = mkId("roundtrip-basic");
    const original: Conversation = {
      id,
      model: "sonnet",
      effort: "medium",
      messages: [
        { role: "user", content: "Round-trip test", metadata: null },
        {
          role: "assistant",
          content: [{ type: "text", text: "Acknowledged" }],
          metadata: {
            startedAt: 1_234_567,
            endedAt: 1_234_999,
            model: "sonnet",
            tokens: 42,
          },
        },
      ],
      createdAt: 1_000_000,
      updatedAt: 1_000_002,
      lastContextTokens: 200,
      marked: true,
      pinned: false,
      sortOrder: -999,
      title: "Round-trip conversation",
    };

    save(original);
    const loaded = load(id);

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(original);
  });

  test("saving again overwrites the file with the new data", () => {
    const id = mkId("roundtrip-overwrite");
    const base: Conversation = {
      id,
      model: "sonnet",
      effort: "high",
      messages: [],
      createdAt: 2_000_000,
      updatedAt: 2_000_000,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: -2_000_000,
      title: "First save",
    };

    save(base);
    save({ ...base, title: "Second save", updatedAt: 2_000_001 });

    const loaded = load(id);
    expect(loaded!.title).toBe("Second save");
    expect(loaded!.updatedAt).toBe(2_000_001);
  });

  test("all EffortLevel values survive round-trip", () => {
    const efforts = ["low", "medium", "high", "max"] as const;
    for (const effort of efforts) {
      const id = mkId(`roundtrip-effort-${effort}`);
      const conv: Conversation = {
        id,
        model: "haiku",
        effort,
        messages: [],
        createdAt: 3_000_000,
        updatedAt: 3_000_000,
        lastContextTokens: null,
        marked: false,
        pinned: false,
        sortOrder: -3_000_000,
        title: `Effort ${effort}`,
      };
      save(conv);
      const loaded = load(id);
      expect(loaded!.effort).toBe(effort);
    }
  });
});

// ── loadAll() ─────────────────────────────────────────────────────────

describe("loadAll()", () => {
  test("returns summaries for all valid conversation files in the directory", () => {
    const idA = mkId("loadall-a");
    const idB = mkId("loadall-b");

    writeFixture(idA, {
      version: 9,
      id: idA,
      model: "sonnet",
      effort: "high",
      messages: [{ role: "user", content: "A", metadata: null }],
      createdAt: 100,
      updatedAt: 100,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 10,
      title: "A",
    });
    writeFixture(idB, {
      version: 9,
      id: idB,
      model: "haiku",
      effort: "low",
      messages: [],
      createdAt: 200,
      updatedAt: 200,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 5,
      title: "B",
    });

    const all = loadAll();
    const ids = all.map((c) => c.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);

    // summaries have the right shape (no messages array — that's ConversationSummary)
    const summaryA = all.find((c) => c.id === idA)!;
    expect(summaryA.model).toBe("sonnet");
    expect(summaryA.effort).toBe("high");
    expect(summaryA.title).toBe("A");
    expect(summaryA.messageCount).toBe(1);
    expect(summaryA.streaming).toBe(false);
    expect(summaryA.unread).toBe(false);
  });

  test("summaries are sorted by sortOrder ascending (lower = first)", () => {
    const idLow = mkId("loadall-sort-low");
    const idMid = mkId("loadall-sort-mid");
    const idHigh = mkId("loadall-sort-high");

    for (const [id, sortOrder] of [
      [idLow, 1],
      [idMid, 50],
      [idHigh, 200],
    ] as const) {
      writeFixture(id, {
        version: 9,
        id,
        model: "sonnet",
        effort: "high",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
        lastContextTokens: null,
        marked: false,
        pinned: false,
        sortOrder,
        title: id,
      });
    }

    const all = loadAll();
    const ours = all.filter((c) => [idLow, idMid, idHigh].includes(c.id));
    expect(ours).toHaveLength(3);
    expect(ours.map((c) => c.id)).toEqual([idLow, idMid, idHigh]);
  });

  test("pinned conversations appear before unpinned regardless of sortOrder", () => {
    const idPinned = mkId("loadall-pinned");
    const idUnpinned = mkId("loadall-unpinned");

    writeFixture(idPinned, {
      version: 9,
      id: idPinned,
      model: "sonnet",
      effort: "high",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      lastContextTokens: null,
      marked: false,
      pinned: true,
      sortOrder: 999, // high sortOrder but pinned
      title: "Pinned",
    });
    writeFixture(idUnpinned, {
      version: 9,
      id: idUnpinned,
      model: "sonnet",
      effort: "high",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      lastContextTokens: null,
      marked: false,
      pinned: false,
      sortOrder: 1, // low sortOrder but not pinned
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
      version: 9,
      id: idGood,
      model: "sonnet",
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
      model: "opus",
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
    // Write a non-.json file — loadAll() should not choke on it
    const fakePath = join(CONV_DIR, "test-persist-not-json.txt");
    writeFileSync(fakePath, "not json at all", { mode: 0o600 });

    // The test is that loadAll() doesn't throw
    expect(() => loadAll()).not.toThrow();

    // cleanup the non-standard file manually
    try {
      rmSync(fakePath);
    } catch {
      /* ignore */
    }
  });
});
