/**
 * Map Exocortex history onto Antigravity CLI (ACP) sessions.
 *
 * The CLI keeps each conversation as a session it can load again
 * (session/load) but not fork, so it can only continue from its newest
 * point. Each committed tool round and completed turn records the session
 * and a fresh mark on its last message; `heads` remembers each session's
 * newest mark. A turn whose latest recorded mark is still its session's head
 * continues that session and sends only what came after; anything else (an
 * edit or rewind, another provider's turns before any Gemini one, a new
 * workspace) starts a new session with the earlier history as a transcript.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import type { ApiContentBlock, ApiMessage } from "../../messages";
import { renderMessageContent, renderTranscript, trailingUserMessages } from "../anthropic/prompt";
import { handoffTranscript } from "../handoff";
import { log } from "../../log";
import type { GeminiAssistantProviderData } from "./types";

export type GeminiResumePoint = GeminiAssistantProviderData["gemini"];

export interface GeminiPromptPlan {
  resume: GeminiResumePoint | null;
  /** Messages the session has not seen. */
  pending: ApiMessage[];
}

/** ACP prompt content blocks. */
export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

const HEADS_FILE = "gemini-session-heads.json";
const MAX_HEADS = 2000;

let heads: Map<string, string> | null = null;

function headsPath(): string {
  return join(dataDir(), HEADS_FILE);
}

function loadHeads(): Map<string, string> {
  if (heads) return heads;
  heads = new Map();
  try {
    if (existsSync(headsPath())) {
      const parsed = JSON.parse(readFileSync(headsPath(), "utf8")) as Record<string, string>;
      for (const [session, mark] of Object.entries(parsed)) if (typeof mark === "string") heads.set(session, mark);
    }
  } catch (error) {
    log("warn", `gemini: could not read ${headsPath()} (${error instanceof Error ? error.message : error}); sessions start fresh`);
  }
  return heads;
}

/** Record `mark` as the newest point of `sessionId`. */
export function setSessionHead(sessionId: string, mark: string): void {
  const map = loadHeads();
  map.delete(sessionId);
  map.set(sessionId, mark);
  while (map.size > MAX_HEADS) map.delete(map.keys().next().value!);
  try {
    mkdirSync(dirname(headsPath()), { recursive: true });
    const tmp = `${headsPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
    renameSync(tmp, headsPath());
  } catch (error) {
    log("warn", `gemini: could not save session heads: ${error instanceof Error ? error.message : error}`);
  }
}

export function sessionHead(sessionId: string): string | undefined {
  return loadHeads().get(sessionId);
}

/** For tests. */
export function resetSessionHeadsForTest(): void {
  heads = new Map();
}

export function planGeminiPrompt(messages: ApiMessage[], cwd: string): GeminiPromptPlan {
  for (let i = messages.length - 1; i >= 0; i--) {
    const data = messages[i].providerData?.gemini;
    if (!data) continue;
    if (data.cwd !== cwd || sessionHead(data.sessionId) !== data.mark) break;
    return { resume: data, pending: messages.slice(i + 1) };
  }
  return { resume: null, pending: messages };
}

function toAcp(content: ApiMessage["content"]): AcpContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: AcpContentBlock[] = [];
  for (const block of content as ApiContentBlock[]) {
    if (block.type === "text" && block.text) out.push({ type: "text", text: block.text });
    else if (block.type === "image") out.push({ type: "image", mimeType: block.source.media_type, data: block.source.data });
  }
  return out;
}

/** Consecutive text blocks joined by a blank line, as separate messages read. */
function join_(parts: AcpContentBlock[][]): AcpContentBlock[] {
  const out: AcpContentBlock[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last?.type === "text" && part[0]?.type === "text") out[out.length - 1] = { ...last, text: `${last.text}\n\n` };
    out.push(...part);
  }
  return out;
}

const INTERRUPTED_TURN_PROMPT = "Your previous turn was interrupted before it finished, and anything it still had running was stopped. Continue where you left off.";

/**
 * The prompt for the session: trailing plain user messages natively (images
 * included), anything earlier the session has not seen as a transcript with
 * its newest images (../handoff.ts).
 */
export function buildGeminiPromptContent(pending: ApiMessage[]): AcpContentBlock[] {
  const tail = trailingUserMessages(pending);
  const history = pending.slice(0, pending.length - tail.length);
  const parts: AcpContentBlock[][] = [];
  const transcript = handoffTranscript(history);
  if (transcript.length > 0) {
    parts.push(transcript.map((part): AcpContentBlock => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", mimeType: part.mediaType, data: part.data }));
  }
  for (const message of tail) parts.push(toAcp(message.content));
  if (tail.length === 0) parts.push([{ type: "text", text: INTERRUPTED_TURN_PROMPT }]);
  return join_(parts).filter(block => block.type !== "text" || block.text.length > 0);
}

/** A one-shot helper request (title, summary, compaction) as one prompt. */
export function buildGeminiHelperPrompt(messages: ApiMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") return renderMessageContent(messages[0].content) || "Hello.";
  return renderTranscript(messages) || "Hello.";
}
