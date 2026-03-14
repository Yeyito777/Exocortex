/**
 * CLI commands — each is a single function that takes a connection
 * and options, does its work, and returns an exit code.
 */

import type { Connection } from "./conn";
import type {
  ModelId,
  ConversationCreatedEvent,
  ConversationsListEvent,
  ConversationLoadedEvent,
  ConversationDeletedEvent,
  ConversationUpdatedEvent,
  AckEvent,
  LlmCompleteResultEvent,
} from "@exocortex/shared/protocol";
import { collectResponse, type StreamCallback } from "./collect";
import { formatBlocksAsText, formatResponseAsJson, formatEntriesAsText, formatEntriesAsJson } from "./format";

export interface OutputOptions {
  json: boolean;
  full: boolean;
  stream: boolean;
  idOnly: boolean;
  timeout: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

let reqCounter = 0;
function nextReqId(): string {
  return `cli_${++reqCounter}_${Date.now()}`;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ── send ────────────────────────────────────────────────────────────

export async function send(
  conn: Connection,
  text: string,
  convId: string | null,
  model: ModelId | null,
  opts: OutputOptions,
): Promise<number> {
  // Create conversation if needed
  if (!convId) {
    const reqId = nextReqId();
    const created = await conn.request<ConversationCreatedEvent>(
      { type: "new_conversation", reqId, model: model ?? undefined },
      (e): e is ConversationCreatedEvent => e.type === "conversation_created" && e.reqId === reqId,
    );
    convId = created.convId;
  } else if (model) {
    // Switch model on existing conversation
    conn.send({ type: "set_model", convId, model });
  }

  // Subscribe to get streaming events
  conn.send({ type: "subscribe", convId });

  // Set up stream callback for --stream mode
  const onStream: StreamCallback | undefined = opts.stream
    ? (event) => {
        if ("convId" in event && event.convId === convId) {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
      }
    : undefined;

  const response = await collectResponse(conn, convId, text, opts.timeout, onStream);

  // Format output
  if (opts.idOnly) {
    process.stdout.write(response.convId + "\n");
  } else if (opts.json) {
    process.stdout.write(formatResponseAsJson(response) + "\n");
  } else if (!opts.stream) {
    const output = formatBlocksAsText(response.blocks, opts.full);
    if (output) process.stdout.write(output + "\n");
    process.stdout.write(`\nexo:${response.convId}\n`);
  } else {
    // In stream mode we already printed events; just print the convId
    process.stdout.write(`\nexo:${response.convId}\n`);
  }

  return 0;
}

// ── ls ──────────────────────────────────────────────────────────────

export async function ls(conn: Connection, opts: OutputOptions): Promise<number> {
  const reqId = nextReqId();
  const event = await conn.request<ConversationsListEvent>(
    { type: "list_conversations", reqId },
    (e): e is ConversationsListEvent => e.type === "conversations_list" && e.reqId === reqId,
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify(event.conversations) + "\n");
  } else {
    if (event.conversations.length === 0) {
      process.stdout.write("No conversations.\n");
    } else {
      // Table format
      const header = padRight("ID", 10) + padRight("MODEL", 8) + padRight("MSGS", 6) + padRight("TITLE", 40) + "UPDATED";
      process.stdout.write(header + "\n");
      process.stdout.write("─".repeat(header.length) + "\n");
      for (const c of event.conversations) {
        const id = c.id.slice(0, 8);
        const prefix = (c.pinned ? "📌" : c.marked ? "★ " : "  ");
        const streaming = c.streaming ? " ⟳" : "";
        const date = new Date(c.updatedAt).toLocaleString();
        const title = c.title || "(untitled)";
        process.stdout.write(
          prefix + padRight(id, 10) + padRight(c.model, 8) + padRight(String(c.messageCount), 6) + padRight(truncate(title, 38), 40) + date + streaming + "\n"
        );
      }
    }
  }

  return 0;
}

// ── info ────────────────────────────────────────────────────────────

export async function info(conn: Connection, convId: string, opts: OutputOptions): Promise<number> {
  const reqId = nextReqId();
  const event = await conn.request<ConversationLoadedEvent>(
    { type: "load_conversation", reqId, convId },
    (e): e is ConversationLoadedEvent => e.type === "conversation_loaded" && e.reqId === reqId,
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      convId: event.convId,
      model: event.model,
      contextTokens: event.contextTokens,
      messageCount: event.entries.length,
      queuedMessages: event.queuedMessages ?? [],
    }) + "\n");
  } else {
    process.stdout.write(`Conversation: ${event.convId}\n`);
    process.stdout.write(`Model:        ${event.model}\n`);
    process.stdout.write(`Messages:     ${event.entries.length}\n`);
    process.stdout.write(`Context:      ${event.contextTokens ?? "unknown"} tokens\n`);
    if (event.queuedMessages?.length) {
      process.stdout.write(`Queued:       ${event.queuedMessages.length} message(s)\n`);
    }
  }

  return 0;
}

// ── history ─────────────────────────────────────────────────────────

export async function history(conn: Connection, convId: string, opts: OutputOptions): Promise<number> {
  const reqId = nextReqId();
  const event = await conn.request<ConversationLoadedEvent>(
    { type: "load_conversation", reqId, convId },
    (e): e is ConversationLoadedEvent => e.type === "conversation_loaded" && e.reqId === reqId,
  );

  if (opts.json) {
    process.stdout.write(formatEntriesAsJson(event.entries) + "\n");
  } else {
    const output = formatEntriesAsText(event.entries, opts.full);
    if (output) process.stdout.write(output + "\n");
  }

  return 0;
}

// ── rm ──────────────────────────────────────────────────────────────

export async function rm(conn: Connection, convId: string): Promise<number> {
  const reqId = nextReqId();
  await conn.request<ConversationDeletedEvent>(
    { type: "delete_conversation", reqId, convId },
    (e): e is ConversationDeletedEvent => e.type === "conversation_deleted" && e.convId === convId,
  );
  return 0;
}

// ── abort ───────────────────────────────────────────────────────────

export async function abort(conn: Connection, convId: string): Promise<number> {
  const reqId = nextReqId();
  await conn.request<AckEvent>(
    { type: "abort", reqId, convId },
    (e): e is AckEvent => e.type === "ack" && e.reqId === reqId,
  );
  process.stdout.write("Aborted.\n");
  return 0;
}

// ── rename ──────────────────────────────────────────────────────────

export async function rename(conn: Connection, convId: string, title: string): Promise<number> {
  const reqId = nextReqId();
  await conn.request<ConversationUpdatedEvent>(
    { type: "rename_conversation", reqId, convId, title },
    (e): e is ConversationUpdatedEvent => e.type === "conversation_updated" && e.summary.id === convId,
  );
  return 0;
}

// ── llm ─────────────────────────────────────────────────────────────

export async function llm(
  conn: Connection,
  userText: string,
  system: string,
  model: ModelId | null,
  opts: OutputOptions,
): Promise<number> {
  const reqId = nextReqId();
  const event = await conn.request<LlmCompleteResultEvent>(
    { type: "llm_complete", reqId, system, userText, model: model ?? undefined },
    (e): e is LlmCompleteResultEvent => e.type === "llm_complete_result" && e.reqId === reqId,
    opts.timeout,
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify({ text: event.text }) + "\n");
  } else {
    process.stdout.write(event.text + "\n");
  }

  return 0;
}
