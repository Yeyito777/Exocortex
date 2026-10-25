import { existsSync } from "fs";
import { connect as netConnect } from "net";
import type { Event } from "./protocol";
import { isWindows, socketPath } from "@exocortex/shared/paths";
import { PREPARE_RESTART_MAX_SETTLE_MS, readInterruptedStreamIds, writeActiveGoalRestartMarker, writeInterruptedStreamIds, writeStopRequest } from "./restart-markers";

function makeReqId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureSocketExists(): string {
  const path = socketPath();
  if (!isWindows && !existsSync(path)) {
    throw new Error("exocortexd socket not found");
  }
  return path;
}

export async function getRunningConversationIds(timeoutMs = 2_000, restartRecoverableOnly = false): Promise<string[]> {
  const path = ensureSocketExists();

  return new Promise((resolve, reject) => {
    const reqId = makeReqId("running_conversations");
    const socket = netConnect(path);
    let buffer = "";
    let settled = false;

    const finish = (result: { convIds?: string[]; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result.error) reject(result.error);
      else resolve(result.convIds ?? []);
    };

    const timer = setTimeout(() => {
      finish({ error: new Error(`Timed out after ${timeoutMs}ms waiting for exocortexd`) });
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "list_conversations", reqId }) + "\n");
    });

    socket.on("data", (data) => {
      buffer += typeof data === "string" ? data : data.toString("utf-8");

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as Event;
            if (event.type === "conversations_list" && event.reqId === reqId) {
              finish({
                convIds: event.conversations
                  .filter((conversation) => conversation.streaming
                    && (!restartRecoverableOnly || conversation.restartRecoverable !== false))
                  .map((conversation) => conversation.id),
              });
              return;
            }
            if (event.type === "error" && event.reqId === reqId) {
              finish({ error: new Error(event.message) });
              return;
            }
          } catch (error) {
            finish({ error: error instanceof Error ? error : new Error(String(error)) });
            return;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("error", (error) => {
      finish({ error });
    });

    socket.on("close", () => {
      if (!settled) finish({ error: new Error("Connection closed before exocortexd replied") });
    });
  });
}

async function abortConversation(convId: string, timeoutMs = 2_000): Promise<void> {
  const path = ensureSocketExists();

  return new Promise((resolve, reject) => {
    const reqId = makeReqId("abort");
    const socket = netConnect(path);
    let buffer = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for abort acknowledgement from exocortexd`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "abort", reqId, convId, reason: "daemon-restart" }) + "\n");
    });

    socket.on("data", (data) => {
      buffer += typeof data === "string" ? data : data.toString("utf-8");

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as Event;
            if (event.type === "ack" && event.reqId === reqId) {
              finish();
              return;
            }
            if (event.type === "error" && event.reqId === reqId) {
              finish(new Error(event.message));
              return;
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("error", (error) => {
      finish(error);
    });

    socket.on("close", () => {
      if (!settled) finish(new Error("Connection closed before exocortexd acknowledged abort"));
    });
  });
}

/** Send one command and resolve with its matching reply (ack, or `replyTypes`). */
async function sendCommand(
  command: { type: string } & Record<string, unknown>,
  description: string,
  timeoutMs = 2_000,
  replyTypes: readonly Event["type"][] = ["ack"],
): Promise<Event> {
  const path = ensureSocketExists();
  return new Promise((resolve, reject) => {
    const reqId = makeReqId(command.type);
    const socket = netConnect(path);
    let buffer = "";
    let settled = false;
    const finish = (result: { event?: Event; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result.error) reject(result.error);
      else resolve(result.event!);
    };
    const timer = setTimeout(() => {
      finish({ error: new Error(`Timed out after ${timeoutMs}ms waiting for exocortexd to ${description}`) });
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ ...command, reqId }) + "\n");
    });
    socket.on("data", (data) => {
      buffer += typeof data === "string" ? data : data.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as Event;
            if ("reqId" in event && event.reqId === reqId) {
              if (event.type === "error") {
                finish({ error: new Error(event.message) });
                return;
              }
              if (replyTypes.includes(event.type)) {
                finish({ event });
                return;
              }
            }
          } catch (error) {
            finish({ error: error instanceof Error ? error : new Error(String(error)) });
            return;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => finish({ error }));
    socket.on("close", () => {
      if (!settled) finish({ error: new Error(`Connection closed before exocortexd acknowledged: ${description}`) });
    });
  });
}

async function sendAcknowledgedCommand(
  command: { type: string } & Record<string, unknown>,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  await sendCommand(command, description, timeoutMs);
}

function requestDaemonShutdownMode(mode: "stop" | "restart", timeoutMs = 2_000): Promise<void> {
  return sendAcknowledgedCommand({ type: "prepare_shutdown", mode }, `prepare ${mode}`, timeoutMs);
}

/** Ask an instance-local daemon to exit for its supervisor to relaunch (exotest). */
export function requestInstanceRestart(timeoutMs = 2_000): Promise<void> {
  return sendAcknowledgedCommand({ type: "restart_daemon" }, "restart", timeoutMs);
}

export async function prepareStopWithoutReplay(): Promise<void> {
  // First, so the signal that follows still means stop if the socket can't answer.
  writeStopRequest();
  await requestDaemonShutdownMode("stop");
  // Loaded on demand: restart-recovery pulls in the daemon's module graph,
  // which the restart path of this control process must not pay for.
  const { clearRestartRecoveryForStop } = await import("./restart-recovery");
  clearRestartRecoveryForStop();
}

export interface PrepareRestartResult {
  convIds: string[];
  stillStreaming: string[];
}

/**
 * Prepare a daemon restart that should resume active conversations afterwards.
 *
 * The live daemon quiesces, records every restart-recoverable streaming
 * conversation in the restart recovery file, aborts the running ones so they
 * persist any salvageable partial turn, and answers once they have settled or
 * the deadline passed. If a stream refuses to stop in time, the saved recovery
 * file is still enough for the next daemon to replay from persisted history.
 */
export async function prepareRestartForReplay(timeoutMs = PREPARE_RESTART_MAX_SETTLE_MS): Promise<PrepareRestartResult> {
  try {
    const reply = await sendCommand(
      { type: "prepare_shutdown", mode: "restart", interruptForReplay: true, timeoutMs },
      "prepare restart",
      timeoutMs + 5_000,
      ["ack", "shutdown_prepared"],
    );
    if (reply.type === "shutdown_prepared") {
      return { convIds: reply.convIds, stillStreaming: reply.stillStreaming };
    }
    // A daemon predating in-process preparation only quiesced; finish here.
  } catch (err) {
    // One-upgrade compatibility: the currently running daemon may predate the
    // handshake even though this control process is executing newer source.
    console.error(`  ⚠ Live daemon did not accept restart quiescing; using legacy preparation: ${err instanceof Error ? err.message : String(err)}`);
  }
  return prepareRestartOverSocket(timeoutMs);
}

/** Legacy preparation driven from this process: poll, record and abort over the socket. */
async function prepareRestartOverSocket(timeoutMs: number): Promise<PrepareRestartResult> {
  const interrupted = new Set<string>();
  try {
    for (const id of readInterruptedStreamIds()) interrupted.add(id);
  } catch {
    // If the file is corrupt, overwrite it below with the currently observed streams.
  }

  const deadline = Date.now() + timeoutMs;
  let stillStreaming: string[] = [];
  let restartMarkerWritten = false;

  while (Date.now() < deadline) {
    const running = await getRunningConversationIds();
    if (!restartMarkerWritten) {
      writeActiveGoalRestartMarker();
      restartMarkerWritten = true;
    }
    stillStreaming = running;
    if (running.length === 0) break;

    const restartRecoverable = await getRunningConversationIds(2_000, true);
    for (const id of restartRecoverable) interrupted.add(id);
    writeInterruptedStreamIds(interrupted);

    await Promise.allSettled(running.map((id) => abortConversation(id)));
    await sleep(250);
  }

  // One final observation for accurate warning/output.
  try {
    stillStreaming = await getRunningConversationIds();
  } catch {
    // The daemon may already be going away; the interrupted file has been written.
  }

  if (interrupted.size > 0) writeInterruptedStreamIds(interrupted);

  return {
    convIds: [...interrupted],
    stillStreaming,
  };
}
