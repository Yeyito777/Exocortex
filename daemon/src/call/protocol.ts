import { DEFAULT_REALTIME_VOICE, type RealtimeVoice } from "@exocortex/shared/realtime";

export interface RealtimeInitialItem {
  role: "developer" | "user" | "assistant";
  text: string;
}

export type RealtimeSidebandEvent =
  | { type: "started"; sessionId: string }
  | { type: "transcript_delta"; role: "user" | "assistant"; text: string }
  | { type: "transcript_done"; role: "user" | "assistant"; text: string; tokens?: number }
  | { type: "handoff"; handoffId: string; text: string }
  | { type: "error"; message: string }
  | { type: "closed"; reason?: string };

export const REALTIME_MODEL = "gpt-live-1-boulder-alpha";
const CONTEXT_APPEND_MAX_BYTES = 500;

export function buildRealtimeSession(
  prompt: string,
  initialItems: RealtimeInitialItem[],
  voice: RealtimeVoice = DEFAULT_REALTIME_VOICE,
): Record<string, unknown> {
  return {
    model: REALTIME_MODEL,
    instructions: prompt,
    audio: { output: { voice } },
    delegation: { type: "client" },
    ...(initialItems.length > 0 ? {
      initial_items: initialItems.map(item => ({
        type: "message",
        role: item.role,
        content: [{
          type: item.role === "assistant" ? "output_text" : "input_text",
          text: item.text,
        }],
      })),
    } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorMessage(payload: Record<string, unknown>): string | null {
  if (typeof payload.message === "string") return payload.message;
  const error = asRecord(payload.error);
  if (typeof error?.message === "string") return error.message;
  return error ? JSON.stringify(error) : null;
}

/** Parse only the stable Frameless Bidi events Exocortex consumes. */
export function parseRealtimeSidebandEvent(raw: string): RealtimeSidebandEvent | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return null;
    payload = parsed;
  } catch {
    return null;
  }

  switch (payload.type) {
    case "session.started":
    case "session.updated": {
      const session = asRecord(payload.session);
      return typeof session?.id === "string" ? { type: "started", sessionId: session.id } : null;
    }
    case "input_transcript.added":
    case "output_transcript.added": {
      const item = asRecord(payload.item);
      if (typeof item?.text !== "string") return null;
      return {
        type: "transcript_delta",
        role: payload.type === "input_transcript.added" ? "user" : "assistant",
        text: item.text,
      };
    }
    case "turn.done": {
      const turn = asRecord(payload.turn);
      if ((turn?.role !== "user" && turn?.role !== "assistant") || typeof turn.transcript !== "string") return null;
      const turnUsage = asRecord(turn.usage);
      const payloadUsage = asRecord(payload.usage);
      const tokens = [turn.output_tokens, turnUsage?.output_tokens, payloadUsage?.output_tokens]
        .find(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
      return {
        type: "transcript_done",
        role: turn.role,
        text: turn.transcript,
        ...(typeof tokens === "number" ? { tokens } : {}),
      };
    }
    case "delegation.created": {
      const item = asRecord(payload.item);
      if (item?.type !== "delegation" || item.target !== "client" || typeof item.id !== "string") return null;
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry?.type === "input_text" && typeof entry.text === "string")
        .map(entry => entry.text as string)
        .join("");
      return { type: "handoff", handoffId: item.id, text };
    }
    case "error": {
      const message = errorMessage(payload);
      return message ? { type: "error", message } : null;
    }
    default:
      return null;
  }
}

/** Split by UTF-8 byte length without corrupting code points. */
export function chunkRealtimeContext(text: string, maxBytes = CONTEXT_APPEND_MAX_BYTES): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (current && bytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildDelegationAppend(handoffId: string, text: string): Record<string, unknown>[] {
  return chunkRealtimeContext(text).map(chunk => ({
    type: "delegation.context.append",
    delegation_item_id: handoffId,
    channel: "speakable",
    content: [{ type: "input_text", text: chunk }],
  }));
}

/** Add application-attributed live input to Frameless Bidi's speakable stream. */
export function buildSessionInputAppend(text: string): Record<string, unknown>[] {
  const chunks = chunkRealtimeContext(text);
  return chunks.map((chunk, index) => ({
    type: "session.context.append",
    // Long utterances are silent context until the final chunk. This preserves
    // one model response per platform utterance instead of one per 500 bytes.
    channel: index === chunks.length - 1 ? "speakable" : "commentary",
    content: [{ type: "input_text", text: chunk }],
  }));
}
