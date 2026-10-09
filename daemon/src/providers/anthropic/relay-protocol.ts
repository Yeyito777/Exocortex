/**
 * Protocol between the daemon and a Claude Code relay (relay.ts).
 *
 * A relay owns one Claude Code process so that it outlives the daemon. Claude
 * Code's stream-json traffic passes through it unchanged in both directions;
 * the relay's own lines (starting with RELAY_LINE_PREFIX) carry what only it
 * knows or does: the hello a connecting daemon gets, stderr and exit, and the
 * daemon's bookkeeping and stop requests.
 *
 * No daemon imports: the relay runs this on its own.
 */

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_LINE_TYPE = "exocortex_relay";
/** Every relay line starts with this, so passthrough traffic is told apart without parsing it. */
export const RELAY_LINE_PREFIX = `{"type":"${RELAY_LINE_TYPE}",`;
/** Set on output a relay replays to a daemon that reconnected. */
export const REPLAYED_FIELD = "exocortex_replayed";

export interface RelayResumePoint {
  sessionId: string;
  resumeAt: string;
}

export interface RelayToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** What a daemon needs to take over the process; the relay hands it back in every hello. */
export interface RelayMeta {
  convId: string;
  /** claudeSessionKey of the settings the process was started with. */
  key: string;
  cwd: string;
  /** Exocortex tools offered over MCP (see host-tools.ts). */
  hostTools: RelayToolDef[];
  /** Exocortex's system prompt addition, re-sent when a daemon reconnects. */
  systemAppend?: string;
  /** Where the process forked its session; history ending there matches it until a commit. */
  resume: RelayResumePoint | null;
  /** For a new session (no resume point): the history it was started with. */
  history?: RelayHistoryMark | null;
}

/** The first `count` messages of a conversation, by their combined key (see historyKey). */
export interface RelayHistoryMark {
  count: number;
  key: string;
}

export interface RelayStart {
  version: typeof RELAY_PROTOCOL_VERSION;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  socketPath: string;
  recordPath: string;
  meta: RelayMeta;
}

/** A running relay, listed in the relays directory while it lives. */
export interface RelayRecord {
  version: typeof RELAY_PROTOCOL_VERSION;
  convId: string;
  socketPath: string;
  pid: number;
  createdAt: number;
}

export interface RelayHello {
  event: "hello";
  version: number;
  pid: number;
  meta: RelayMeta;
  /** Latest commit the daemon reported, or where the process forked. */
  resume: RelayResumePoint | null;
  /** Exocortex messages sent into the process since that commit (see deliveryKey). */
  delivered: string[];
  /** Claude Code is running a turn, or produced output of one no daemon committed. */
  pending: boolean;
  /** When the relay first saw each live background task. */
  taskStarts: Record<string, number>;
}

export type RelayEvent =
  | RelayHello
  | { event: "stderr"; data: string }
  | { event: "exit"; code: number | null; signal: string | null };

export type RelayOp =
  /**
   * The daemon saved everything up to `through` (a main-thread message uuid).
   * `resume` moves the resume point; `interrupted` drops the rest of an
   * interrupted turn, up to the result that ends it.
   */
  | { op: "commit"; through?: string; resume?: RelayResumePoint; interrupted?: { promptUuid: string | null } }
  | { op: "delivered"; keys: string[] }
  | { op: "end_input" }
  | { op: "kill"; signal: string };

export function relayLine(body: RelayEvent | RelayOp): string {
  return `${JSON.stringify({ type: RELAY_LINE_TYPE, ...body })}\n`;
}

type SdkRecord = Record<string, unknown>;

function resultPromptUuids(message: SdkRecord): string[] {
  if (Array.isArray(message.user_message_uuids)) return message.user_message_uuids.filter((id): id is string => typeof id === "string");
  return typeof message.user_message_uuid === "string" ? [message.user_message_uuid] : [];
}

/** A main-thread message of a model turn (not task bookkeeping, not subagent traffic). */
export function startsClaudeTurn(message: SdkRecord): boolean {
  if (message.parent_tool_use_id) return false;
  if (message.type === "system") return message.subtype === "init";
  return message.type === "stream_event" || message.type === "assistant" || (message.type === "user" && !message.isReplay);
}

/** Whether a result ends an interrupted turn: its prompt's own result, or any for a turn Claude Code started itself. */
export function endsInterruptedTurn(promptUuid: string | null, message: SdkRecord): boolean {
  if (message.type !== "result") return false;
  if (!promptUuid) return true;
  const uuids = resultPromptUuids(message);
  if (uuids.length > 0) return uuids.includes(promptUuid);
  const origin = message.origin as SdkRecord | undefined;
  return origin?.kind !== "task-notification";
}
