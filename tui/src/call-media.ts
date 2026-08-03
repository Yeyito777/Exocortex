import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Event } from "./protocol";
import { log } from "./log";
import { DEFAULT_MIC_GAIN_DB, normalizeMicGainDb } from "./mic-gain";

interface CallMediaDaemon {
  attachCallMedia(convId: string, callId: string, offerSdp: string, reqId?: string): void;
  stopCall(convId: string, callId?: string): void;
}

interface HelperMessage {
  type: "offer" | "state" | "error";
  sdp?: string;
  state?: string;
  message?: string;
}

interface ActiveAdapter {
  convId: string;
  callId: string;
  reqId: string;
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  stderr: string;
  stopping: boolean;
}

export interface CallMediaControllerOptions {
  spawnHelper?: () => ChildProcessWithoutNullStreams;
  onError?: (message: string) => void;
  micGainDb?: number;
}

const HELPER_PATH = fileURLToPath(new URL("./call-media-helper.cjs", import.meta.url));

function defaultSpawnHelper(): ChildProcessWithoutNullStreams {
  return spawn(process.env.EXOCORTEX_NODE_BIN || "node", [HELPER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

/** Owns the TUI's local microphone/speaker WebRTC peer for one daemon call. */
export class CallMediaController {
  private active: ActiveAdapter | null = null;
  private readonly tuiCallByConversation = new Map<string, string>();
  private readonly spawnHelper: () => ChildProcessWithoutNullStreams;
  private readonly onError: (message: string) => void;
  private micGainDb: number;

  constructor(
    private readonly daemon: CallMediaDaemon,
    options: CallMediaControllerOptions = {},
  ) {
    this.spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
    this.onError = options.onError ?? (() => {});
    this.micGainDb = normalizeMicGainDb(options.micGainDb ?? DEFAULT_MIC_GAIN_DB);
  }

  handleEvent(event: Event): void {
    if (event.type === "call_state") {
      if (event.adapter && event.adapter.type !== "tui") return;
      if (event.state === "closed" || event.state === "error") {
        if (this.tuiCallByConversation.get(event.convId) === event.callId) {
          this.tuiCallByConversation.delete(event.convId);
        }
      } else {
        this.tuiCallByConversation.set(event.convId, event.callId);
      }
      if (event.state === "waiting_for_media") this.start(event.convId, event.callId);
      if (event.state === "closed" || event.state === "error") this.stopLocal(event.convId, event.callId);
      return;
    }
    if (event.type === "call_sdp_answer") {
      if (event.adapter && event.adapter.type !== "tui") return;
      const active = this.active;
      if (!active || active.convId !== event.convId || active.callId !== event.callId) return;
      this.send(active, { type: "answer", sdp: event.sdp });
      return;
    }
    if (event.type === "error") {
      const active = this.active;
      if (active && event.reqId === active.reqId) this.stopLocal(active.convId, active.callId);
    }
  }

  stop(): void {
    const active = this.active;
    if (!active) return;
    this.stopAdapter(active);
  }

  callIdForConversation(convId: string): string | undefined {
    return this.tuiCallByConversation.get(convId);
  }

  setMicGainDb(gainDb: number): void {
    this.micGainDb = normalizeMicGainDb(gainDb);
    const active = this.active;
    if (active) this.send(active, { type: "mic_gain", gainDb: this.micGainDb });
  }

  private start(convId: string, callId: string): void {
    const current = this.active;
    if (current?.convId === convId && current.callId === callId) return;
    if (current) this.stopAdapter(current);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnHelper();
    } catch (error) {
      this.failStart(convId, callId, error instanceof Error ? error.message : String(error));
      return;
    }

    const active: ActiveAdapter = {
      convId,
      callId,
      reqId: `call-media-${randomUUID()}`,
      child,
      buffer: "",
      stderr: "",
      stopping: false,
    };
    this.active = active;
    this.send(active, { type: "mic_gain", gainDb: this.micGainDb });

    child.stdout.on("data", chunk => this.handleOutput(active, chunk.toString()));
    child.stderr.on("data", chunk => { active.stderr = `${active.stderr}${chunk}`.slice(-2_000); });
    child.on("error", error => {
      if (!active.stopping) this.fail(active, `Could not start the TUI call audio adapter: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (this.active === active) this.active = null;
      if (active.stopping) return;
      const detail = active.stderr.trim();
      const message = `TUI call audio adapter stopped (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`;
      log("error", `call media: ${message}`);
      this.onError(message);
      this.daemon.stopCall(active.convId, active.callId);
    });
  }

  private handleOutput(active: ActiveAdapter, chunk: string): void {
    if (this.active !== active || active.stopping) return;
    active.buffer += chunk;
    for (;;) {
      const newline = active.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = active.buffer.slice(0, newline);
      active.buffer = active.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: HelperMessage;
      try {
        message = JSON.parse(line) as HelperMessage;
      } catch {
        this.fail(active, "The TUI call audio adapter returned malformed data.");
        return;
      }
      if (message.type === "offer") {
        if (typeof message.sdp !== "string" || !message.sdp.trim()) {
          this.fail(active, "The TUI call audio adapter returned an empty SDP offer.");
          return;
        }
        this.daemon.attachCallMedia(active.convId, active.callId, message.sdp, active.reqId);
      } else if (message.type === "error") {
        this.fail(active, message.message || "The TUI call audio adapter failed.");
        return;
      }
    }
  }

  private send(active: ActiveAdapter, message: Record<string, unknown>): void {
    if (active.stopping || active.child.stdin.destroyed) return;
    active.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(active: ActiveAdapter, message: string): void {
    if (active.stopping) return;
    log("error", `call media: ${message}`);
    this.onError(message);
    this.daemon.stopCall(active.convId, active.callId);
    this.stopAdapter(active);
  }

  private failStart(convId: string, callId: string, message: string): void {
    log("error", `call media: could not start adapter: ${message}`);
    this.onError(`Could not start the TUI call audio adapter: ${message}`);
    this.daemon.stopCall(convId, callId);
  }

  private stopLocal(convId: string, callId: string): void {
    const active = this.active;
    if (!active || active.convId !== convId || active.callId !== callId) return;
    this.stopAdapter(active);
  }

  private stopAdapter(active: ActiveAdapter): void {
    if (active.stopping) return;
    active.stopping = true;
    if (this.active === active) this.active = null;
    try { active.child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`); } catch { /* best effort */ }
    try { active.child.stdin.end(); } catch { /* best effort */ }
    const timer = setTimeout(() => {
      try { active.child.kill("SIGTERM"); } catch { /* best effort */ }
    }, 500);
    timer.unref?.();
  }
}
