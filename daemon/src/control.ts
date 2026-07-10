import { existsSync } from "fs";
import { connect as netConnect } from "net";
import type { Event } from "./protocol";
import { isWindows, socketPath } from "@exocortex/shared/paths";
import { clearRestartRecoveryForStop, readInterruptedStreamIds, writeActiveGoalRestartMarker, writeInterruptedStreamIds } from "./restart-recovery";

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

export async function getRunningConversationIds(timeoutMs = 2_000): Promise<string[]> {
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
                  .filter((conversation) => conversation.streaming)
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

async function requestDaemonShutdownMode(mode: "stop" | "restart", timeoutMs = 2_000): Promise<void> {
  const path = ensureSocketExists();
  return new Promise((resolve, reject) => {
    const reqId = makeReqId(`prepare_${mode}`);
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
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for exocortexd to prepare ${mode}`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "prepare_shutdown", reqId, mode }) + "\n");
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
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error(`Connection closed before exocortexd prepared ${mode}`));
    });
  });
}

export async function prepareStopWithoutReplay(): Promise<void> {
  await requestDaemonShutdownMode("stop");
  clearRestartRecoveryForStop();
}

export interface PrepareRestartResult {
  convIds: string[];
  stillStreaming: string[];
}

/**
 * Prepare a daemon restart that should resume active conversations afterwards.
 *
 * The control process records every streaming conversation in the restart
 * recovery file, asks the live daemon to abort those streams so it can persist
 * any salvageable partial turn, and waits briefly for streaming to stop. If a
 * stream refuses to stop before the deadline, the saved recovery file is still
 * enough for the next daemon to replay from the persisted history.
 */
export async function prepareRestartForReplay(timeoutMs = 30_000): Promise<PrepareRestartResult> {
  // Quiesce the live daemon before aborting anything. Without this handshake,
  // aborted turns can drain queues or spawn more subagents while preparation is
  // trying to converge on an empty running set.
  try {
    await requestDaemonShutdownMode("restart");
  } catch (err) {
    // One-upgrade compatibility: the currently running daemon may predate the
    // handshake even though this control process is executing newer source.
    console.error(`  ⚠ Live daemon did not accept restart quiescing; using legacy preparation: ${err instanceof Error ? err.message : String(err)}`);
  }
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

    for (const id of running) interrupted.add(id);
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
