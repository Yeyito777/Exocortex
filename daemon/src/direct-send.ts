/**
 * Exactly-once direct sends (send_message with acceptAck).
 *
 * A prompt the TUI wrote can be lost with its connection: a daemon restart or a
 * dropped /ssh link between the write and the daemon's answer. The TUI keeps
 * such a send until it is answered and sends it again, with the same reqId and
 * startedAt, after reconnecting. Here a repeat is answered, never run twice:
 * - its prompt is in the transcript already: ack;
 * - the first copy is still being admitted: the repeat gets that copy's verdict;
 * - otherwise it is a new send.
 * An admitted send is acked once its user message is committed.
 */

import * as convStore from "./conversations";
import { getDaemonShutdownMode } from "./daemon-lifecycle";
import type { AssistantTurnOutcome } from "./orchestrator";
import type { ConnectedClient, DaemonServer } from "./server";

interface DirectSend {
  reqId?: string;
  convId: string;
  startedAt: number;
}

/** null: admitted; otherwise the refusal. */
type Admission = Promise<string | null>;

/** Sends being admitted or run, by conversation and startedAt. */
const admissions = new Map<string, Admission>();

function admissionKey(send: DirectSend): string {
  return `${send.convId}\n${send.startedAt}`;
}

function alreadySent(send: DirectSend): boolean {
  return convStore.hasMessageMetadata(send.convId, { startedAt: send.startedAt }, "user");
}

function ack(server: DaemonServer, client: ConnectedClient, send: DirectSend): void {
  server.sendTo(client, { type: "ack", reqId: send.reqId, convId: send.convId });
}

/**
 * Run `send` once. `run` starts its turn and must call `onCommitted` once the
 * user message is in the transcript. Returns the turn's outcome, or null for a
 * repeat that was answered here.
 */
export async function runDirectSendOnce(
  server: DaemonServer,
  client: ConnectedClient,
  send: DirectSend,
  run: (onCommitted: () => void) => Promise<AssistantTurnOutcome>,
): Promise<AssistantTurnOutcome | null> {
  const key = admissionKey(send);
  const earlier = admissions.get(key);
  if (earlier) {
    const refusal = await earlier;
    if (refusal === null || alreadySent(send)) ack(server, client, send);
    else {
      server.sendTo(client, {
        type: "error", reqId: send.reqId, convId: send.convId, message: refusal,
        ...(getDaemonShutdownMode() ? { reason: "daemon_shutting_down" as const } : {}),
      });
    }
    return null;
  }
  if (alreadySent(send)) {
    ack(server, client, send);
    return null;
  }
  let settle!: (refusal: string | null) => void;
  admissions.set(key, new Promise<string | null>(resolve => { settle = resolve; }));
  try {
    const outcome = await run(() => {
      settle(null);
      ack(server, client, send);
    });
    settle(outcome.error ?? "The prompt was not sent.");
    return outcome;
  } catch (error) {
    settle(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    admissions.delete(key);
  }
}
