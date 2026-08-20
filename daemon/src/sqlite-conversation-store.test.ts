import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REALTIME_CALL_STATUS_KIND, REALTIME_TRANSCRIPT_KIND, createConversation, historyPrefixHash, type StoredMessage } from "./messages";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { clonedConversationValue } from "./conversation-clone";

const roots: string[] = [];
afterEach(() => {
  // Bun/SQLite may defer finalizing temporary statement wrappers until the test
  // frame unwinds. Force that finalization before Windows tries to remove WAL.
  if (process.platform === "win32") Bun.gc(true);
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    } catch (err) {
      // One large-result bun:sqlite statement remains locked until the test
      // process exits on Windows even after finalize/close/GC. The assertions
      // have completed; do not turn that runtime teardown quirk into a failure.
      if (process.platform !== "win32" || (err as NodeJS.ErrnoException).code !== "EBUSY") throw err;
    }
  }
});

function pathFor(name: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), `exocortex-sqlite-${name}-`));
  roots.push(root);
  return { root, path: join(root, "store.sqlite3") };
}

function savedFixture(store: SqliteConversationStore, id: string) {
  const conv = createConversation(id, "openai", "gpt-5.6-sol", 0, "before");
  conv.messages.push(
    { role: "user", content: "keep", metadata: null },
    { role: "assistant", content: "answer", metadata: null },
  );
  store.save(conv);
  return conv;
}

function logicalState(store: SqliteConversationStore, id: string) {
  const btw = store.loadConversationBtwState();
  return {
    exported: store.exportConversation(id),
    page: store.loadDisplayPage(id, 20),
    tools: store.loadToolOutputs(id),
    unread: store.loadUnreadConversationIds(),
    queue: store.loadQueuedMessages(),
    btw: {
      sessions: [...btw.btws].sort(([a], [b]) => a.localeCompare(b)),
      receipts: [...btw.seenSessionIds].map(([convId, ids]) => [convId, [...ids].sort()]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    },
    history: store.db.query<Record<string, unknown>, []>("SELECT stack, position, entry_json FROM sidebar_history ORDER BY stack, position").all(),
    conversationRow: store.db.query<Record<string, unknown>, [string]>("SELECT * FROM conversations WHERE id=?").get(id),
    blobRows: store.db.query<Record<string, unknown>, [string]>("SELECT kind, ordinal, payload_bytes, content_hash FROM message_blobs WHERE conversation_id=? ORDER BY message_sequence, kind, ordinal").all(id),
    ftsRows: store.db.query<Record<string, unknown>, [string]>("SELECT conversation_id, title FROM conversation_title_fts WHERE conversation_id=?").all(id),
  };
}

describe("SQLite transaction fault boundaries", () => {
  test("clones normalized rows atomically and rebinds clone-specific state", () => {
    const { path } = pathFor("direct-clone");
    const points: string[] = [];
    let throwAt: string | null = null;
    const store = new SqliteConversationStore({
      path,
      faultInjection(point) {
        points.push(point);
        if (point === throwAt) throw new Error(`injected ${point}`);
      },
    });
    const source = createConversation("direct-clone-source", "openai", "gpt-5.6-sol", 3, "source");
    source.goal = {
      objective: "must not be inherited",
      status: "active",
      pausable: true,
      completable: true,
      createdAt: 1,
      updatedAt: 1,
      turns: 0,
    };
    source.subagentMaxDepth = 2;
    source.subagentPolicy = {
      parentConversationId: "parent",
      allowEdits: false,
      parentSystemInstructions: "parent constraints",
    };
    source.toolPolicy = { internal: ["read"], external: ["google"] };
    source.messages.push(
      { role: "user", content: "first", metadata: null },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "clone-tool", name: "bash", input: { command: "printf ok" } }],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "clone-tool", content: "large deferred result".repeat(10_000) }],
        metadata: null,
      },
      { role: "assistant", content: "first answer", metadata: null },
    );
    const compactedPrefixHash = historyPrefixHash(source.messages, 4);
    const sourceWindowId = `${source.id}:1`;
    source.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: source.model,
      messages: [{
        role: "assistant",
        content: [],
        metadata: null,
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
        contextCheckpoint: {
          version: 1,
          provider: "openai",
          model: source.model,
          windowId: sourceWindowId,
          transcriptHistoryCount: 4,
          transcriptPrefixHash: compactedPrefixHash,
          contextTokens: 100,
        },
      }],
      transcriptHistoryCount: 4,
      transcriptPrefixHash: compactedPrefixHash,
      compactionHistoryCount: 4,
      compactionPrefixHash: compactedPrefixHash,
      windowId: sourceWindowId,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    source.messages.push({
      role: "user",
      content: "tail",
      metadata: null,
      contextCheckpoint: {
        version: 1,
        provider: "openai",
        model: source.model,
        windowId: sourceWindowId,
        transcriptHistoryCount: 4,
        transcriptPrefixHash: compactedPrefixHash,
        contextTokens: 200,
      },
    });
    store.save(source);

    const target = {
      id: "direct-clone-target",
      title: "source 📋",
      sortOrder: 3.5,
      createdAt: 500,
      updatedAt: 500,
    };
    points.length = 0;
    expect(store.cloneConversation(source.id, target)).toMatchObject({
      id: target.id,
      title: target.title,
      sortOrder: target.sortOrder,
      goal: null,
    });
    expect(points).toEqual([
      "clone.after-conversation",
      "clone.after-messages",
      "clone.after-display",
      "clone.before-commit",
    ]);
    expect(store.popUndoEntry()).toEqual({ type: "conversation_removed", id: target.id });

    const expected = clonedConversationValue(source, target);
    const cloned = store.load(target.id)!;
    expect(cloned.messages).toEqual(expected.messages);
    expect(cloned.activeContext).toEqual(expected.activeContext);
    expect(cloned.goal ?? null).toBeNull();
    expect(cloned.subagentMaxDepth ?? null).toBeNull();
    expect(cloned.subagentPolicy ?? null).toBeNull();
    expect(cloned.toolPolicy).toEqual(source.toolPolicy);
    expect(store.loadToolOutputs(target.id)).toEqual(store.loadToolOutputs(source.id));

    const sourceUser = store.loadDisplayPage(source.id, 20)?.entries.find((entry) => entry.type === "user");
    const clonedUser = store.loadDisplayPage(target.id, 20)?.entries.find((entry) => entry.type === "user");
    expect(clonedUser).toMatchObject({ type: "user", text: "first" });
    expect((clonedUser as any)?.unwindFingerprint).not.toBe((sourceUser as any)?.unwindFingerprint);

    // A forced verification save must find every copied/rebound message hash
    // current; otherwise it would rewrite the transcript suffix.
    points.length = 0;
    store.save(cloned, { forceMessages: true });
    expect(points).not.toContain("save.after-messages");

    throwAt = "clone.after-messages";
    expect(() => store.cloneConversation(source.id, {
      ...target,
      id: "direct-clone-rolled-back",
    })).toThrow("injected clone.after-messages");
    expect(store.has("direct-clone-rolled-back")).toBe(false);
    expect(store.popUndoEntry()).toBeNull();
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("appends and pops sidebar history without rewriting older rows", () => {
    const { path } = pathFor("targeted-sidebar-history");
    const store = new SqliteConversationStore({ path });
    store.pushUndoEntry({ type: "conversation_renamed", convId: "one", title: "before one" });
    store.pushUndoEntry({ type: "conversation_renamed", convId: "two", title: "before two" });
    store.pushRedoEntry({ type: "conversation_marked", convId: "redo", marked: false });
    store.db.exec(`
      CREATE TRIGGER reject_old_sidebar_history_delete
      BEFORE DELETE ON sidebar_history
      WHEN old.stack='undo' AND old.position < 2
      BEGIN SELECT RAISE(FAIL, 'rewrote old undo history'); END;
    `);

    expect(() => store.pushTrashEntry({ type: "conversation_marked", convId: "three", marked: false })).not.toThrow();
    expect(store.db.query<{ position: number }, []>("SELECT position FROM sidebar_history WHERE stack='undo' ORDER BY position").all())
      .toEqual([{ position: 0 }, { position: 1 }, { position: 2 }]);
    expect(store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sidebar_history WHERE stack='redo'").get()?.count).toBe(0);
    expect(store.popUndoEntry()).toEqual({ type: "conversation_marked", convId: "three", marked: false });
    store.close();
  });

  test("recovers WAL after an abrupt process exit inside a transaction", () => {
    const { root, path } = pathFor("abrupt-wal");
    let store = new SqliteConversationStore({ path });
    savedFixture(store, "abrupt-wal");
    store.close();

    const modulePath = join(import.meta.dir, "sqlite-conversation-store.ts");
    const child = Bun.spawnSync([
      process.execPath,
      "-e",
      `const { SqliteConversationStore } = await import(${JSON.stringify(modulePath)});\n` +
      `const store = new SqliteConversationStore({ path: ${JSON.stringify(path)}, faultInjection(point) { if (point === "save.after-messages") process.exit(73); } });\n` +
      `const conv = store.load("abrupt-wal");\n` +
      `conv.messages.push({ role: "user", content: "uncommitted", metadata: null });\n` +
      `store.save(conv);`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, EXOCORTEX_CONFIG_DIR: root },
    });
    expect(child.exitCode).toBe(73);

    store = new SqliteConversationStore({ path });
    expect(store.load("abrupt-wal")?.messages).toHaveLength(2);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("metadata saves leave message rows untouched and append changes only the suffix", () => {
    const { path } = pathFor("targeted-save");
    const points: string[] = [];
    const store = new SqliteConversationStore({ path, faultInjection(point) { points.push(point); } });
    const conv = savedFixture(store, "targeted-save");
    const before = store.db.query<Record<string, unknown>, [string]>(`
      SELECT sequence, content_json, metadata_json, provider_data_json,
             context_tokens_json, context_checkpoint_json, content_hash, message_hash
      FROM messages WHERE conversation_id=? ORDER BY sequence
    `).all(conv.id);

    points.length = 0;
    conv.marked = true;
    conv.updatedAt += 1;
    store.save(conv);
    expect(points).not.toContain("save.after-messages");
    expect(store.db.query<Record<string, unknown>, [string]>(`
      SELECT sequence, content_json, metadata_json, provider_data_json,
             context_tokens_json, context_checkpoint_json, content_hash, message_hash
      FROM messages WHERE conversation_id=? ORDER BY sequence
    `).all(conv.id)).toEqual(before);

    points.length = 0;
    conv.messages.push({ role: "user", content: "suffix only", metadata: null });
    conv.updatedAt += 1;
    store.save(conv);
    expect(points).toContain("save.after-messages");
    const after = store.db.query<Record<string, unknown>, [string]>(`
      SELECT sequence, content_json, metadata_json, provider_data_json,
             context_tokens_json, context_checkpoint_json, content_hash, message_hash
      FROM messages WHERE conversation_id=? ORDER BY sequence
    `).all(conv.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    store.close();
  });

  test("unwind preserves prefix rows and deletes only the canonical suffix", () => {
    const { path } = pathFor("targeted-unwind");
    const store = new SqliteConversationStore({ path });
    const conv = createConversation("targeted-unwind", "openai", "gpt-5.6-sol", 0, "targeted");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: [{ type: "tool_use", id: "keep-tool", name: "bash", input: {} }], metadata: null },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "keep-tool", content: "prefix payload".repeat(10_000) }], metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    const compactedPrefixHash = historyPrefixHash(conv.messages, 4);
    conv.activeContext = {
      version: 1,
      kind: "openai_native",
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{
        role: "assistant",
        content: [],
        providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } },
      }],
      transcriptHistoryCount: 4,
      transcriptPrefixHash: compactedPrefixHash,
      compactionHistoryCount: 4,
      compactionPrefixHash: compactedPrefixHash,
      windowId: `${conv.id}:1`,
      windowNumber: 1,
      compactedAt: 123,
      compactionCount: 1,
    };
    store.save(conv);
    const targetEntryIndex = store.displayEntryCountBeforeUser(conv.id, 1);
    expect(targetEntryIndex).not.toBeNull();
    const prefixRows = store.db.query<Record<string, unknown>, [string, number]>(`
      SELECT sequence, content_json, content_hash, message_hash
      FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence
    `).all(conv.id, 4);
    const prefixBlob = store.db.query<Record<string, unknown>, [string, number]>(`
      SELECT message_sequence, kind, ordinal, payload_bytes, content_hash
      FROM message_blobs WHERE conversation_id=? AND message_sequence<?
    `).all(conv.id, 4);
    expect(prefixBlob).toHaveLength(1);

    store.db.exec(`
      CREATE TEMP TABLE message_mutations(kind TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TEMP TABLE active_context_mutations(kind TEXT NOT NULL);
      CREATE TEMP TRIGGER profile_message_delete AFTER DELETE ON main.messages BEGIN
        INSERT INTO message_mutations(kind, sequence) VALUES ('delete', old.sequence);
      END;
      CREATE TEMP TRIGGER profile_message_insert AFTER INSERT ON main.messages BEGIN
        INSERT INTO message_mutations(kind, sequence) VALUES ('insert', new.sequence);
      END;
      CREATE TEMP TRIGGER profile_active_delete AFTER DELETE ON main.active_contexts BEGIN
        INSERT INTO active_context_mutations(kind) VALUES ('delete');
      END;
      CREATE TEMP TRIGGER profile_active_insert AFTER INSERT ON main.active_contexts BEGIN
        INSERT INTO active_context_mutations(kind) VALUES ('insert');
      END;
    `);
    const result = { ...conv, messages: conv.messages.slice(0, 4), updatedAt: conv.updatedAt + 1 };
    store.saveUnwind(conv, result, 4, {
      operationId: "targeted-unwind-operation",
      userMessageIndex: 1,
      historyTotalEntries: targetEntryIndex!,
      messageCount: 4,
      supersededQueueIds: [],
    });

    expect(store.db.query<{ kind: string; sequence: number }, []>(
      "SELECT kind, sequence FROM message_mutations ORDER BY sequence",
    ).all()).toEqual([
      { kind: "delete", sequence: 4 },
      { kind: "delete", sequence: 5 },
    ]);
    expect(store.db.query<{ kind: string }, []>(
      "SELECT kind FROM active_context_mutations",
    ).all()).toEqual([]);
    expect(store.db.query<Record<string, unknown>, [string, number]>(`
      SELECT sequence, content_json, content_hash, message_hash
      FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence
    `).all(conv.id, 4)).toEqual(prefixRows);
    expect(store.db.query<Record<string, unknown>, [string, number]>(`
      SELECT message_sequence, kind, ordinal, payload_bytes, content_hash
      FROM message_blobs WHERE conversation_id=? AND message_sequence<?
    `).all(conv.id, 4)).toEqual(prefixBlob);
    expect(store.load(conv.id)?.messages).toHaveLength(4);
    expect(store.getLastUnwindReceipt(conv)).toMatchObject({
      operationId: "targeted-unwind-operation",
      userMessageIndex: 1,
      historyTotalEntries: targetEntryIndex,
    });
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("unwind folds pending retained context attribution into the same transaction", () => {
    const { path } = pathFor("unwind-context-attribution");
    const store = new SqliteConversationStore({ path });
    const conv = createConversation("unwind-context-attribution", "openai", "gpt-5.6-sol", 0, "attribution");
    conv.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    store.save(conv);
    const before = store.db.query<{ content_json: string; content_hash: string }, [string, number]>(`
      SELECT content_json, content_hash FROM messages WHERE conversation_id=? AND sequence=?
    `).get(conv.id, 0)!;

    // Provider usage can arrive while the edit request is waiting for a stream
    // abort. It is the one permitted retained-prefix mutation during unwind.
    conv.messages[0].contextTokens = null;
    const result = { ...conv, messages: conv.messages.slice(0, 2), updatedAt: conv.updatedAt + 1 };
    store.saveUnwind(conv, result, 2, {
      operationId: "attribution-unwind-operation",
      userMessageIndex: 1,
      historyTotalEntries: 2,
      messageCount: 2,
      supersededQueueIds: [],
    });

    const retained = store.db.query<{
      content_json: string;
      content_hash: string;
      context_tokens_json: string | null;
      has_context_tokens: number;
    }, [string, number]>(`
      SELECT content_json, content_hash, context_tokens_json, has_context_tokens
      FROM messages WHERE conversation_id=? AND sequence=?
    `).get(conv.id, 0)!;
    expect(retained).toEqual({
      ...before,
      context_tokens_json: null,
      has_context_tokens: 1,
    });
    const loaded = store.load(conv.id)!;
    expect(Object.hasOwn(loaded.messages[0], "contextTokens")).toBe(true);
    expect(loaded.messages[0].contextTokens).toBeNull();
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("rolls back every save fault boundary without blob or FTS divergence", () => {
    for (const faultPoint of ["save.after-conversation", "save.after-messages", "save.after-display", "save.before-commit"]) {
      const { path } = pathFor(faultPoint.replaceAll(".", "-"));
      let armed = false;
      let store = new SqliteConversationStore({ path, faultInjection(point) {
        if (armed && point === faultPoint) throw new Error(`injected ${faultPoint}`);
      } });
      const conv = savedFixture(store, `fault-${faultPoint}`);
      const before = logicalState(store, conv.id);
      conv.title = `changed-${faultPoint}`;
      conv.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call-${faultPoint}`, content: "large".repeat(1_000) }], metadata: null });
      armed = true;
      expect(() => store.save(conv)).toThrow(`injected ${faultPoint}`);
      armed = false;
      expect(logicalState(store, conv.id)).toEqual(before);
      expect(store.integrityCheck().ok).toBe(true);
      store.close();

      store = new SqliteConversationStore({ path });
      expect(logicalState(store, conv.id)).toEqual(before);
      expect(store.integrityCheck().ok).toBe(true);
      store.close();
    }
  });

  test("rolls back every unwind fault boundary including queue and receipts", () => {
    for (const faultPoint of ["unwind.after-conversation", "unwind.after-messages", "unwind.before-commit"]) {
      const { path } = pathFor(faultPoint.replaceAll(".", "-"));
      let armed = false;
      let store = new SqliteConversationStore({ path, faultInjection(point) {
        if (armed && point === faultPoint) throw new Error(`injected ${faultPoint}`);
      } });
      const conv = savedFixture(store, `fault-${faultPoint}`);
      conv.messages.push({ role: "user", content: "remove", metadata: null });
      store.save(conv);
      store.saveQueuedMessages([{ id: `queue-${faultPoint}`, convId: conv.id, text: "queued", timing: "message-end", source: "daemon", createdAt: 1 }]);
      const before = logicalState(store, conv.id);
      const result = { ...conv, messages: conv.messages.slice(0, 2), updatedAt: conv.updatedAt + 1 };
      armed = true;
      expect(() => store.saveUnwind(conv, result, 2, {
        operationId: `operation-${faultPoint}`, userMessageIndex: 1,
        historyTotalEntries: 2, messageCount: 2, supersededQueueIds: [`queue-${faultPoint}`],
      })).toThrow(`injected ${faultPoint}`);
      armed = false;
      expect(logicalState(store, conv.id)).toEqual(before);
      expect(store.hasConversationUnwindReceipt(conv.id)).toBe(false);
      store.close();

      store = new SqliteConversationStore({ path });
      expect(logicalState(store, conv.id)).toEqual(before);
      expect(store.integrityCheck().ok).toBe(true);
      store.close();
    }
  });

  test("rolls back every delete fault boundary including unread BTW and history stacks", () => {
    for (const faultPoint of ["delete.after-conversations", "delete.before-commit"]) {
      const { path } = pathFor(faultPoint.replaceAll(".", "-"));
      let armed = false;
      let store = new SqliteConversationStore({ path, faultInjection(point) {
        if (armed && point === faultPoint) throw new Error(`injected ${faultPoint}`);
      } });
      const conv = savedFixture(store, `fault-${faultPoint}`);
      store.saveUnreadConversationIds([conv.id]);
      store.saveConversationBtwState({
        btws: new Map([[conv.id, { sessionId: `btw-${faultPoint}`, query: "q", provider: "openai", model: conv.model, startedAt: 1, endedAt: null, phase: "running", text: "", status: "streaming" }]]),
        seenSessionIds: new Map([[conv.id, new Set([`btw-${faultPoint}`])]]),
      });
      store.pushUndoEntry({ type: "conversation_renamed", convId: conv.id, title: "old" });
      store.pushRedoEntry({ type: "conversation_marked", convId: conv.id, marked: false });
      const before = logicalState(store, conv.id);
      armed = true;
      expect(() => store.trashConversations([conv.id], true)).toThrow(`injected ${faultPoint}`);
      armed = false;
      expect(logicalState(store, conv.id)).toEqual(before);
      expect(store.has(conv.id)).toBe(true);
      store.close();

      store = new SqliteConversationStore({ path });
      expect(logicalState(store, conv.id)).toEqual(before);
      expect(store.integrityCheck().ok).toBe(true);
      store.close();
    }
  });

  test("rolls back conversation, message, and display writes together", () => {
    const { path } = pathFor("save-fault");
    let store = new SqliteConversationStore({ path });
    savedFixture(store, "save-fault");
    store.close();

    store = new SqliteConversationStore({ path, faultInjection(point) {
      if (point === "save.after-messages") throw new Error("injected save crash");
    } });
    const conv = store.load("save-fault")!;
    conv.title = "after";
    conv.messages.push({ role: "user", content: "must roll back", metadata: null });
    expect(() => store.save(conv)).toThrow("injected save crash");
    store.close();

    store = new SqliteConversationStore({ path });
    expect(store.load("save-fault")?.title).toBe("before");
    expect(store.load("save-fault")?.messages).toHaveLength(2);
    expect(store.loadDisplayPage("save-fault", 5)?.totalEntries).toBe(2);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("rolls back delete and undo-stack mutation together", () => {
    const { path } = pathFor("delete-fault");
    let store = new SqliteConversationStore({ path });
    savedFixture(store, "delete-fault");
    store.close();

    store = new SqliteConversationStore({ path, faultInjection(point) {
      if (point === "delete.before-commit") throw new Error("injected delete crash");
    } });
    expect(() => store.trashConversations(["delete-fault"])).toThrow("injected delete crash");
    expect(store.has("delete-fault")).toBe(true);
    expect(store.popUndoEntry()).toBeNull();
    store.close();
  });

  test("rolls back unwind, receipt, and queue tombstone deletion together", () => {
    const { path } = pathFor("unwind-fault");
    let store = new SqliteConversationStore({ path });
    const base = savedFixture(store, "unwind-fault");
    base.messages.push({ role: "user", content: "remove", metadata: null });
    store.save(base);
    store.saveQueuedMessages([{
      id: "unwind-queue", convId: base.id, text: "queued", timing: "message-end", source: "daemon", createdAt: 1,
    }]);
    store.close();

    store = new SqliteConversationStore({ path, faultInjection(point) {
      if (point === "unwind.before-commit") throw new Error("injected unwind crash");
    } });
    const loaded = store.load(base.id)!;
    const result = { ...loaded, messages: loaded.messages.slice(0, 2), updatedAt: loaded.updatedAt + 1 };
    expect(() => store.saveUnwind(loaded, result, 2, {
      operationId: "unwind-op", userMessageIndex: 1, historyTotalEntries: 2,
      messageCount: 2, supersededQueueIds: ["unwind-queue"],
    })).toThrow("injected unwind crash");
    expect(store.load(base.id)?.messages).toHaveLength(3);
    expect(store.loadQueuedMessages().map((entry) => entry.id)).toEqual(["unwind-queue"]);
    expect(store.hasConversationUnwindReceipt(base.id)).toBe(false);
    store.close();
  });
});

describe("SQLite maintenance", () => {
  test("round-trips conversation and folder mute state", () => {
    const { path } = pathFor("muting");
    const store = new SqliteConversationStore({ path });
    const conv = createConversation("muting", "openai", "gpt-5.6-sol");
    conv.muted = true;
    store.save(conv);
    store.saveFolders([
      { id: "muted-folder", name: "Muted", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, muted: true, sortOrder: 0 },
      { id: "child-folder", name: "Child", parentId: "muted-folder", createdAt: 2, updatedAt: 2, pinned: false, muted: false, sortOrder: 1 },
    ]);

    expect(store.getSummary(conv.id)?.muted).toBe(true);
    expect(store.load(conv.id)?.muted).toBe(true);
    expect(store.loadFolders()).toEqual([
      expect.objectContaining({ id: "muted-folder", muted: true }),
      expect.objectContaining({ id: "child-folder", muted: false }),
    ]);
    store.close();
  });

  test("round-trips exact conversation tool policy", () => {
    const { path } = pathFor("tool-policy");
    const store = new SqliteConversationStore({ path });
    const conv = createConversation("tool-policy", "openai", "gpt-5.6-sol");
    conv.toolPolicy = { internal: ["read", "write"], external: ["google"] };
    store.save(conv);
    expect(store.load(conv.id)?.toolPolicy).toEqual(conv.toolPolicy);
    expect(store.loadToolPolicyState(conv.id)).toEqual({
      id: conv.id,
      subagentMaxDepth: null,
      subagentPolicy: null,
      toolPolicy: conv.toolPolicy,
    });
    expect(store.db.query<{ tool_policy_json: string | null }, [string]>("SELECT tool_policy_json FROM conversations WHERE id=?").get(conv.id)?.tool_policy_json).toBe(JSON.stringify(conv.toolPolicy));
    store.close();
  });

  test("backs up, checks, restores to a new file, and exports normalized JSON", () => {
    const { root, path } = pathFor("maintenance");
    const store = new SqliteConversationStore({ path });
    savedFixture(store, "maintenance");
    savedFixture(store, "maintenance-deleted");
    expect(store.trashConversations(["maintenance-deleted"])).toEqual(["maintenance-deleted"]);
    store.pushRedoEntry({ type: "conversation_removed", id: "maintenance" });
    const backup = store.backup(join(root, "backup.sqlite3"));
    const backupDb = new Database(backup, { readonly: true });
    const check = backupDb.query<Record<string, string>, []>("PRAGMA quick_check").get();
    expect(check && Object.values(check)[0]).toBe("ok");
    backupDb.close();

    expect(() => store.backup(backup)).toThrow("already exists");
    const restored = store.restoreToNewFile(backup, join(root, "restored.sqlite3"));
    expect(() => store.restoreToNewFile(backup, restored)).toThrow("already exists");
    const restoredStore = new SqliteConversationStore({ path: restored });
    expect(restoredStore.load("maintenance")?.messages).toHaveLength(2);
    expect(restoredStore.load("maintenance-deleted")).toBeNull();
    expect(restoredStore.load("maintenance-deleted", true)?.messages).toHaveLength(2);
    restoredStore.close();

    const exportRoot = join(root, "export");
    const manifest = store.exportAll(exportRoot);
    expect(manifest.conversations).toHaveLength(2);
    expect(manifest.conversations.find((entry) => entry.id === "maintenance-deleted")?.deleted).toBe(true);
    expect(JSON.parse(readFileSync(join(exportRoot, "conversations", "maintenance.json"), "utf8"))).toMatchObject({ version: 20, id: "maintenance" });
    expect(JSON.parse(readFileSync(join(exportRoot, "trash", "maintenance-deleted.json"), "utf8"))).toMatchObject({ version: 20, id: "maintenance-deleted" });
    expect(JSON.parse(readFileSync(join(exportRoot, "trash", "trash.json"), "utf8"))).toEqual([
      { type: "conversation", id: "maintenance-deleted" },
    ]);
    expect(JSON.parse(readFileSync(join(exportRoot, "trash", "redo.json"), "utf8"))).toEqual([
      { type: "conversation_removed", id: "maintenance" },
    ]);
    expect(store.diagnostics()).toMatchObject({
      schemaVersion: 8,
      liveConversations: 1,
      deletedConversations: 1,
      messages: 4,
      importStatus: "not-run",
    });
    store.close();
  });

  test("separates and reconstructs large tool/image payloads without orphans", () => {
    const { path } = pathFor("blobs");
    const store = new SqliteConversationStore({ path });
    const conv = createConversation("blobs", "openai", "gpt-5.6-sol", 0, "blobs");
    const content: StoredMessage["content"] = [
      { type: "text", text: "payloads" },
      { type: "tool_result", tool_use_id: "tool-1", content: "tool-output".repeat(10_000), is_error: true },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "image-base64".repeat(10_000) } },
    ];
    conv.messages.push({ role: "user", content, metadata: null });
    store.save(conv);

    const storedContentStatement = store.db.query<{ content_json: string }, []>("SELECT content_json FROM messages");
    const storedContent = storedContentStatement.get()!.content_json;
    storedContentStatement.finalize();
    expect(storedContent).not.toContain("tool-output");
    expect(storedContent).not.toContain("image-base64");
    expect(store.load("blobs")?.messages[0]?.content).toEqual(content);
    expect(store.loadToolOutputs("blobs")).toEqual([{
      toolCallId: "tool-1",
      output: "tool-output".repeat(10_000),
    }]);
    expect(store.diagnostics()).toMatchObject({ messageBlobs: 2, toolOutputReferences: 1 });

    const deleteStatement = store.db.query("DELETE FROM conversations WHERE id='blobs'");
    deleteStatement.run();
    deleteStatement.finalize();
    expect(store.diagnostics()).toMatchObject({ messageBlobs: 0, toolOutputReferences: 0, messages: 0 });
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("loads only selected tool-result payloads", () => {
    const { path } = pathFor("selected-tool-outputs");
    const store = new SqliteConversationStore({ path });
    const conv = createConversation("selected-tool-outputs", "openai", "gpt-5.6-sol", 0, "Selected outputs");
    conv.messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "first output", is_error: false },
        { type: "tool_result", tool_use_id: "tool-2", content: "second output", is_error: false },
      ],
      metadata: null,
    });
    store.save(conv);

    expect(store.loadToolOutputs(conv.id, ["tool-2", "missing", "tool-2"])).toEqual([
      { toolCallId: "tool-2", output: "second output" },
    ]);
    expect(store.loadToolOutputs(conv.id, [])).toEqual([]);
    expect(store.loadToolOutputs(conv.id)).toEqual([
      { toolCallId: "tool-1", output: "first output" },
      { toolCallId: "tool-2", output: "second output" },
    ]);
    store.close();
  });

  test("round-trips realtime provenance and rewrites promoted transcript content", () => {
    const { path } = pathFor("realtime-provenance");
    let store = new SqliteConversationStore({ path });
    const conv = createConversation("realtime-provenance", "openai", "gpt-5.6-sol", 0, "Realtime provenance");
    const speaker = {
      kind: "single" as const,
      participants: [{ id: "owner-id", displayName: "Owner", trust: "owner" as const }],
    };
    conv.messages.push(
      {
        role: "user",
        content: "Inspect the repository",
        metadata: {
          startedAt: 1,
          endedAt: 2,
          model: conv.model,
          tokens: 3,
          kind: REALTIME_TRANSCRIPT_KIND,
          realtimeCallId: "call-1",
          realtimeAdapterType: "external",
          realtimeAdapterId: "adapter-1",
          realtimeToolName: "adapter-tool",
          realtimeSourceLabel: "Test call",
          realtimeAccountAlias: "test-account",
          realtimeEndpointId: "endpoint-1",
          realtimeSpeaker: speaker,
        },
      },
      {
        role: "system",
        content: "Realtime call started.",
        metadata: {
          startedAt: 3,
          endedAt: 3,
          model: conv.model,
          tokens: 0,
          kind: REALTIME_CALL_STATUS_KIND,
          realtimeCallId: "call-1",
          realtimeAdapterType: "external",
          realtimeAdapterId: "adapter-1",
        },
      },
      {
        role: "assistant",
        content: "I can help with that.",
        metadata: {
          startedAt: 4,
          endedAt: 5,
          model: "gpt-live-1-boulder-alpha",
          tokens: 6,
          kind: REALTIME_TRANSCRIPT_KIND,
          realtimeCallId: "call-1",
          realtimeAdapterType: "external",
          realtimeAdapterId: "adapter-1",
        },
      },
    );
    store.save(conv);
    expect(store.getSummary(conv.id)?.messageCount).toBe(2);
    expect(store.load(conv.id)?.messages).toEqual(conv.messages);
    store.close();

    store = new SqliteConversationStore({ path });
    const promoted = store.load(conv.id)!;
    promoted.messages[0]!.content = "[realtime delegation]\nTask: Inspect the repository";
    promoted.messages[0]!.contextTokens = null;
    promoted.updatedAt += 1;
    store.save(promoted, { forceMessages: true });
    store.close();

    store = new SqliteConversationStore({ path });
    const reopened = store.load(conv.id)!;
    expect(reopened.messages[0]).toMatchObject({
      content: "[realtime delegation]\nTask: Inspect the repository",
      metadata: {
        kind: REALTIME_TRANSCRIPT_KIND,
        realtimeCallId: "call-1",
        realtimeAdapterType: "external",
        realtimeAdapterId: "adapter-1",
        realtimeToolName: "adapter-tool",
        realtimeSourceLabel: "Test call",
        realtimeAccountAlias: "test-account",
        realtimeEndpointId: "endpoint-1",
        realtimeSpeaker: speaker,
      },
      contextTokens: null,
    });
    expect(reopened.messages[1]?.metadata?.kind).toBe(REALTIME_CALL_STATUS_KIND);
    expect(store.getSummary(conv.id)?.messageCount).toBe(2);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("migrates every schema checkpoint through v8 transactionally", () => {
    for (let version = 1; version <= 7; version++) {
      const { path } = pathFor(`schema-v${version}`);
      let store = new SqliteConversationStore({ path, targetSchemaVersion: version });
      expect(store.db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(version);
      expect(store.integrityCheck().ok).toBe(true);
      store.close();

      store = new SqliteConversationStore({ path });
      expect(store.diagnostics().schemaVersion).toBe(8);
      expect(store.integrityCheck().ok).toBe(true);
      store.close();
    }
  });

  test("keeps title FTS synchronized across rename, soft restore, and hard delete", () => {
    const { path } = pathFor("title-fts");
    const store = new SqliteConversationStore({ path });
    const conv = savedFixture(store, "title-fts");
    conv.title = "AlphaUnique title";
    store.save(conv);
    expect(store.searchTitles("AlphaUni", 10).map((entry) => entry.id)).toEqual([conv.id]);

    conv.title = "BetaUnique title";
    store.save(conv);
    expect(store.searchTitles("AlphaUni", 10)).toEqual([]);
    expect(store.searchTitles("BetaUni", 10).map((entry) => entry.id)).toEqual([conv.id]);

    store.trashConversations([conv.id], false);
    expect(store.searchTitles("BetaUni", 10)).toEqual([]);
    store.restoreConversationsFromTrash([conv.id]);
    expect(store.searchTitles("BetaUni", 10).map((entry) => entry.id)).toEqual([conv.id]);

    store.db.query("DELETE FROM conversations WHERE id=?").run(conv.id);
    expect(store.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM conversation_title_fts WHERE conversation_id=?").get(conv.id)?.count).toBe(0);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("uses indexes for scale-critical summary and page queries", () => {
    const { path } = pathFor("query-plan");
    const store = new SqliteConversationStore({ path });
    savedFixture(store, "query-plan");
    const summaryPlan = store.explain("SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC, id");
    const pagePlan = store.explain("SELECT sequence FROM messages WHERE conversation_id='query-plan' AND is_real_user=1 ORDER BY sequence");
    const details = [...summaryPlan, ...pagePlan].map((row) => String(row.detail ?? "")).join("\n");
    expect(details).toContain("conversations_live_updated_idx");
    expect(details).toContain("messages_page_idx");
    expect(() => store.explain("DELETE FROM conversations")).toThrow("SELECT statements only");
    store.close();
  });

  test("refuses a schema newer than the binary", () => {
    const { path } = pathFor("future");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
    db.query("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(999, "future", Date.now());
    db.close();
    expect(() => new SqliteConversationStore({ path })).toThrow("Unsupported future conversation database schema 999");
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.query<{ version: number }, []>("SELECT version FROM schema_migrations").get()?.version).toBe(999);
    expect(unchanged.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name<>'schema_migrations'").get()?.count).toBe(0);
    unchanged.close();
  });
});
