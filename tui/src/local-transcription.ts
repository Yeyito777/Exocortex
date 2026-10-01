import { connect } from "node:net";
import type { Event, TranscribeAudioCommand } from "./protocol";

export interface LocalTranscriptionOptions {
  signal: AbortSignal;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
}

/**
 * One request-scoped LOCAL socket, independent of the conversation's SSH route.
 * Never request bootstrap, subscribe, or forward local daemon events to the UI.
 */
export function transcribeLocally(
  socketPath: string,
  command: TranscribeAudioCommand & { reqId: string },
  options: LocalTranscriptionOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error("Local transcription cancelled"));
      return;
    }

    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let timer = setTimeout(() => fail("Local transcription connection timed out"), options.connectTimeoutMs ?? 1_000);
    timer.unref();

    const finish = (error: Error | null, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(text);
    };
    const fail = (message: string) => finish(new Error(message));
    const abort = () => fail("Local transcription cancelled");
    options.signal.addEventListener("abort", abort, { once: true });

    socket.on("connect", () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => fail("Local transcription response timed out"), options.responseTimeoutMs ?? 120_000);
      timer.unref();
      try {
        socket.write(JSON.stringify(command) + "\n");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while (!settled && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event: Event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== "object" || !("reqId" in event) || event.reqId !== command.reqId) continue;
        if (event.type === "transcription_result") {
          if (typeof event.text === "string") finish(null, event.text);
          else fail("Invalid local transcription result");
        } else if (event.type === "error") {
          fail(event.message);
        }
      }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => fail("Local transcription connection closed"));
  });
}
