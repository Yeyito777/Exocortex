import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CallMediaController } from "./call-media";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

function daemon() {
  return {
    attachCallMedia: mock((_convId: string, _callId: string, _offer: string, _reqId?: string) => {}),
    stopCall: mock((_convId: string, _callId?: string) => {}),
  };
}

describe("TUI call media controller", () => {
  test("attaches a helper offer and forwards the matching SDP answer", () => {
    const child = new FakeChild();
    const sent: string[] = [];
    child.stdin.on("data", chunk => sent.push(chunk.toString()));
    const api = daemon();
    const controller = new CallMediaController(api, {
      spawnHelper: () => child.asChild(),
      micGainDb: -6,
    });

    controller.handleEvent({
      type: "call_state",
      convId: "conv-1",
      callId: "call-1",
      adapter: { type: "tui", id: "local" },
      state: "waiting_for_media",
    });
    expect(controller.callIdForConversation("conv-1")).toBe("call-1");
    child.stdout.write(`${JSON.stringify({ type: "offer", sdp: "v=0\r\no=offer" })}\n`);

    expect(api.attachCallMedia).toHaveBeenCalledTimes(1);
    expect(api.attachCallMedia.mock.calls[0]?.slice(0, 3)).toEqual([
      "conv-1",
      "call-1",
      "v=0\r\no=offer",
    ]);
    const reqId = api.attachCallMedia.mock.calls[0]?.[3];
    expect(reqId).toStartWith("call-media-");
    expect(sent.map(line => JSON.parse(line))).toContainEqual({ type: "mic_gain", gainDb: -6 });

    controller.setMicGainDb(3.5);
    expect(sent.map(line => JSON.parse(line))).toContainEqual({ type: "mic_gain", gainDb: 3.5 });

    controller.handleEvent({
      type: "call_sdp_answer",
      convId: "conv-1",
      callId: "call-1",
      sdp: "v=0\r\no=answer",
      reqId,
    });
    expect(sent.map(line => JSON.parse(line))).toContainEqual({ type: "answer", sdp: "v=0\r\no=answer" });

    controller.handleEvent({
      type: "call_state",
      convId: "conv-1",
      callId: "call-1",
      adapter: { type: "tui", id: "local" },
      state: "closed",
    });
    expect(sent.map(line => JSON.parse(line))).toContainEqual({ type: "stop" });
    expect(controller.callIdForConversation("conv-1")).toBeUndefined();
  });

  test("stops the daemon call when the helper fails", () => {
    const child = new FakeChild();
    const api = daemon();
    const errors: string[] = [];
    const controller = new CallMediaController(api, {
      spawnHelper: () => child.asChild(),
      onError: message => errors.push(message),
    });

    controller.handleEvent({
      type: "call_state",
      convId: "conv-2",
      callId: "call-2",
      state: "waiting_for_media",
    });
    child.stdout.write(`${JSON.stringify({ type: "error", message: "No microphone" })}\n`);

    expect(errors).toEqual(["No microphone"]);
    expect(api.stopCall).toHaveBeenCalledWith("conv-2", "call-2");
  });

  test("does not spawn twice for repeated waiting state", () => {
    const child = new FakeChild();
    const api = daemon();
    const spawnHelper = mock(() => child.asChild());
    const controller = new CallMediaController(api, { spawnHelper });
    const waiting = {
      type: "call_state" as const,
      convId: "conv-3",
      callId: "call-3",
      state: "waiting_for_media" as const,
    };

    controller.handleEvent(waiting);
    controller.handleEvent(waiting);

    expect(spawnHelper).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  test("ignores Discord adapter lifecycle events", () => {
    const spawnHelper = mock(() => new FakeChild().asChild());
    const controller = new CallMediaController(daemon(), { spawnHelper });
    controller.handleEvent({
      type: "call_state",
      convId: "conv-discord",
      callId: "call-discord",
      adapter: {
        type: "discord",
        id: "paramount:voice",
        accountAlias: "paramount",
        channelId: "voice",
      },
      state: "waiting_for_media",
    });
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(controller.callIdForConversation("conv-discord")).toBeUndefined();
  });
});
