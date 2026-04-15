import { existsSync } from "fs";
import { connect as netConnect } from "net";
import type { Event } from "./protocol";
import { isWindows, socketPath } from "@exocortex/shared/paths";

function makeReqId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function getRunningConversationIds(timeoutMs = 2_000): Promise<string[]> {
  const path = socketPath();
  if (!isWindows && !existsSync(path)) {
    throw new Error("exocortexd socket not found");
  }

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
