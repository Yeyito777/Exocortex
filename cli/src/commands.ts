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

/** Auto-generate a conversation title from the first message. */
function autoTitle(text: string): string {
  // Take the first line, collapse whitespace, truncate. Prefixed so
  // CLI-originated conversations are easy to distinguish from human ones.
  const firstLine = text.split("\n")[0].trim();
  return "cli: " + truncate(firstLine, 75);
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
    const title = autoTitle(text);
    const created = await conn.request<ConversationCreatedEvent>(
      { type: "new_conversation", reqId, model: model ?? undefined, title },
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
      for (const c of event.conversations) {
        const prefix = c.pinned ? "📌" : c.marked ? "★ " : "  ";
        const streaming = c.streaming ? " ⟳" : "";
        const title = c.title || "(untitled)";
        const date = new Date(c.updatedAt).toLocaleString();
        process.stdout.write(
          `${prefix}${c.id}  ${c.model}  ${c.messageCount} msgs  ${title}  ${date}${streaming}\n`
        );
      }
    }
  }

  return 0;
}

// ── info ────────────────────────────────────────────────────────────

export async function info(conn: Connection, convId: string, opts: OutputOptions): Promise<number> {
  // Fetch both the summary (title, pinned, marked) and the loaded conversation (context tokens)
  const listReqId = nextReqId();
  const loadReqId = nextReqId();

  const [listEvent, loadEvent] = await Promise.all([
    conn.request<ConversationsListEvent>(
      { type: "list_conversations", reqId: listReqId },
      (e): e is ConversationsListEvent => e.type === "conversations_list" && e.reqId === listReqId,
    ),
    conn.request<ConversationLoadedEvent>(
      { type: "load_conversation", reqId: loadReqId, convId },
      (e): e is ConversationLoadedEvent => e.type === "conversation_loaded" && e.reqId === loadReqId,
    ),
  ]);

  const summary = listEvent.conversations.find((c) => c.id === convId);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      convId: loadEvent.convId,
      title: summary?.title ?? "",
      model: loadEvent.model,
      contextTokens: loadEvent.contextTokens,
      messageCount: loadEvent.entries.length,
      pinned: summary?.pinned ?? false,
      marked: summary?.marked ?? false,
      streaming: summary?.streaming ?? false,
      createdAt: summary?.createdAt ?? null,
      updatedAt: summary?.updatedAt ?? null,
      queuedMessages: loadEvent.queuedMessages ?? [],
    }) + "\n");
  } else {
    const title = summary?.title || "(untitled)";
    process.stdout.write(`Conversation: ${loadEvent.convId}\n`);
    process.stdout.write(`Title:        ${title}\n`);
    process.stdout.write(`Model:        ${loadEvent.model}\n`);
    process.stdout.write(`Messages:     ${loadEvent.entries.length}\n`);
    process.stdout.write(`Context:      ${loadEvent.contextTokens ?? "unknown"} tokens\n`);
    if (summary?.pinned) process.stdout.write(`Pinned:       yes\n`);
    if (summary?.marked) process.stdout.write(`Marked:       yes\n`);
    if (summary?.streaming) process.stdout.write(`Streaming:    yes\n`);
    if (loadEvent.queuedMessages?.length) {
      process.stdout.write(`Queued:       ${loadEvent.queuedMessages.length} message(s)\n`);
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
  process.stdout.write(`Deleted ${convId}\n`);
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
  process.stdout.write(`Renamed ${convId}\n`);
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
