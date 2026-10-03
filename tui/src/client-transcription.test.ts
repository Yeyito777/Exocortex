import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { DaemonClient, type DaemonClientTransportOptions } from "./client";
import type { Command, Event, TranscribeAudioCommand } from "./protocol";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(5);
  }
}

async function localDaemon(onCommand: (command: TranscribeAudioCommand, socket: Socket) => void) {
  const path = process.platform === "win32"
    ? `\\\\.\\pipe\\exo-transcription-${randomUUID()}`
    : `/tmp/exo-transcription-${randomUUID()}.sock`;
  const commands: Command[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const command = JSON.parse(buffer.slice(0, newline)) as Command;
        buffer = buffer.slice(newline + 1);
        commands.push(command);
        if (command.type === "transcribe_audio") onCommand(command, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(path, { force: true });
  });
  return { path, commands, sockets };
}

function remoteClient(
  path: string,
  timeoutMs?: number,
  recoveryOptions: Pick<DaemonClientTransportOptions, "transcriptionTimeoutMs" | "transcriptionMaxAttempts"> = {},
) {
  const events: Event[] = [];
  const writes: Command[] = [];
  const client = new DaemonClient(event => events.push(event), path, false, {
    localTranscriptionTimeoutMs: timeoutMs,
    ...recoveryOptions,
  });
  // The selected SSH transport only needs write/end/destroy for these tests.
  const internal = client as any;
  internal.sshAlias = "remote";
  internal._connected = true;
  const transport = {
    write: (data: string) => writes.push(JSON.parse(data)),
    end() {},
    destroy() {},
  };
  internal.socket = transport;
  cleanups.push(() => client.disconnect());
  return { client, internal, events, writes, transport };
}

function reply(socket: Socket, reqId: string | undefined, text: string): void {
  socket.write(JSON.stringify({ type: "transcription_result", reqId, text }) + "\n");
}

describe("SSH local-first transcription", () => {
  test("uses only the existing connection on the local route", () => {
    const client = new DaemonClient(() => {});
    cleanups.push(() => client.disconnect());
    client.transcribeAudio("clip", "audio/wav", () => {});
    expect((client as any).pendingCommands).toEqual([{
      type: "transcribe_audio", reqId: expect.any(String), audioBase64: "clip", mimeType: "audio/wav",
    }]);
    expect((client as any).localTranscriptions.size).toBe(0);
  });

  test("prefers local ASR without bootstrapping or leaking local events into the remote UI", async () => {
    const local = await localDaemon((command, socket) => {
      socket.write("invalid JSON\nnull\n42\n");
      socket.write(JSON.stringify({ type: "tools_available", providers: [], tools: [], authByProvider: {} }) + "\n");
      socket.write(JSON.stringify({ type: "error", reqId: "unrelated", message: "ignore" }) + "\n");
      socket.write(JSON.stringify({ type: "transcription_result", reqId: "wrong", text: "ignore" }) + "\n");
      socket.write(JSON.stringify({ type: "ack", reqId: command.reqId }) + "\n");
      const result = Buffer.from(JSON.stringify({ type: "transcription_result", reqId: command.reqId, text: "café voice" }) + "\n");
      const split = result.indexOf(Buffer.from("é")) + 1;
      socket.write(result.subarray(0, split));
      setImmediate(() => socket.write(result.subarray(split)));
    });
    const { client, internal, writes, events } = remoteClient(local.path);
    const results: string[] = [];
    client.transcribeAudio("encoded-local-clip", "audio/webm", text => results.push(text));
    await waitFor(() => results.length > 0);
    await waitFor(() => local.sockets.size === 0);

    expect(results).toEqual(["café voice"]);
    expect(local.commands).toEqual([{
      type: "transcribe_audio", reqId: expect.any(String), audioBase64: "encoded-local-clip", mimeType: "audio/webm",
    }]);
    expect(writes).toEqual([]);
    expect(events).toEqual([]);
    expect(client.remoteAlias).toBe("remote");
    expect(client.connected).toBe(true);
    expect(internal.localTranscriptions.size).toBe(0);
    expect(internal.transcriptionCallbacks.size).toBe(0);

    client.sendMessage("remote-conversation", results[0], 123);
    expect(writes).toEqual([expect.objectContaining({
      type: "send_message", convId: "remote-conversation", text: "café voice",
    })]);
  });

  test("falls back to the SSH daemon when the local socket is absent", async () => {
    const { client, internal, writes } = remoteClient(`/tmp/absent-${randomUUID()}.sock`);
    const results: string[] = [];
    client.transcribeAudio("original-audio", "audio/wav", text => results.push(text));
    await waitFor(() => writes.length > 0);
    expect(writes).toEqual([expect.objectContaining({
      type: "transcribe_audio", audioBase64: "original-audio", mimeType: "audio/wav",
    })]);
    internal.onData(Buffer.from(JSON.stringify({
      type: "transcription_result", reqId: (writes[0] as TranscribeAudioCommand).reqId, text: "remote text",
    }) + "\n"));
    expect(results).toEqual(["remote text"]);
    expect(internal.transcriptionCallbacks.size).toBe(0);
  });

  test("local auth errors silently fall back; only the final remote error reaches the voice job", async () => {
    const local = await localDaemon((command, socket) => {
      socket.write(JSON.stringify({ type: "error", reqId: command.reqId, message: "Local OpenAI login required" }) + "\n");
    });
    const { client, internal, writes, events } = remoteClient(local.path);
    const errors: string[] = [];
    client.transcribeAudio("clip", "audio/wav", () => {}, message => errors.push(message));
    await waitFor(() => writes.length > 0);
    await waitFor(() => local.sockets.size === 0);
    expect(errors).toEqual([]);
    internal.onData(Buffer.from(JSON.stringify({
      type: "error", reqId: (writes[0] as TranscribeAudioCommand).reqId, message: "Remote ASR failed",
    }) + "\n"));
    expect(errors).toEqual(["Remote ASR failed"]);
    expect(events).toEqual([]);
    expect(internal.unresolvedTranscriptionCommands.size).toBe(0);
    expect(internal.flushPendingCommands()).toEqual([]);
  });

  test("a local connection lost before the result falls back exactly once", async () => {
    const local = await localDaemon((_command, socket) => socket.destroy());
    const { client, writes } = remoteClient(local.path);
    client.transcribeAudio("clip", "audio/wav", () => {});
    await waitFor(() => writes.length > 0);
    await waitFor(() => local.sockets.size === 0);
    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe("transcribe_audio");
  });

  test("an unresponsive local daemon times out and closes before remote fallback", async () => {
    const local = await localDaemon(() => {});
    const { client, writes } = remoteClient(local.path, 30);
    client.transcribeAudio("clip", "audio/wav", () => {});
    await waitFor(() => writes.length > 0);
    await waitFor(() => local.sockets.size === 0);
    expect(writes).toHaveLength(1);
  });

  test("multiple clips can complete out of order with isolated callbacks", async () => {
    const requests: Array<{ command: TranscribeAudioCommand; socket: Socket }> = [];
    const local = await localDaemon((command, socket) => requests.push({ command, socket }));
    const { client, writes } = remoteClient(local.path);
    const results: string[] = [];
    client.transcribeAudio("one", "audio/wav", text => results.push(`one:${text}`));
    client.transcribeAudio("two", "audio/wav", text => results.push(`two:${text}`));
    await waitFor(() => requests.length === 2);
    const one = requests.find(request => request.command.audioBase64 === "one")!;
    const two = requests.find(request => request.command.audioBase64 === "two")!;
    reply(two.socket, two.command.reqId, "second");
    await waitFor(() => results.length === 1);
    reply(one.socket, one.command.reqId, "first");
    await waitFor(() => results.length === 2);
    expect(results).toEqual(["two:second", "one:first"]);
    expect(writes).toEqual([]);
  });

  test("local ASR survives SSH loss and its final text retains offline queue replay", async () => {
    let request: { command: TranscribeAudioCommand; socket: Socket } | undefined;
    const local = await localDaemon((command, socket) => { request = { command, socket }; });
    const { client, internal, writes, transport } = remoteClient(local.path);
    let completed = false;
    client.transcribeAudio("clip", "audio/wav", text => {
      client.queueMessage("remote-conversation", text, "next-turn", undefined, { queueId: "voice-queue" });
      completed = true;
    });
    await waitFor(() => !!request);
    internal.handleSocketClose(transport, true);
    expect(client.connected).toBe(false);
    reply(request!.socket, request!.command.reqId, "queued voice");
    await waitFor(() => completed);
    expect(writes).toEqual([]);
    expect(internal.pendingCommands).toEqual([expect.objectContaining({
      type: "queue_message", text: "queued voice", queueId: "voice-queue", timing: "next-turn",
    })]);
    internal.socket = transport;
    internal._connected = true;
    expect(internal.flushPendingCommands()).toEqual(writes);
    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe("queue_message");
    expect(internal.flushPendingCommands()).toEqual([writes[0]]); // same stable id until settled
  });

  test("remote ASR fallback stays queued while SSH is disconnected", async () => {
    const { client, internal, writes, transport } = remoteClient(`/tmp/absent-${randomUUID()}.sock`);
    internal.handleSocketClose(transport, true);
    client.transcribeAudio("clip", "audio/wav", () => {});
    await waitFor(() => internal.pendingCommands.length > 0);
    expect(writes).toEqual([]);
    expect(internal.pendingCommands).toEqual([expect.objectContaining({ type: "transcribe_audio", audioBase64: "clip" })]);
    internal.socket = transport;
    internal._connected = true;
    internal.flushPendingCommands();
    expect(writes).toHaveLength(1);
  });

  test("an uploaded transcription is recovered after SSH drops before its result", async () => {
    const { client, internal, writes, events, transport } = remoteClient(`/tmp/absent-${randomUUID()}.sock`);
    const results: string[] = [];
    client.transcribeAudio("original-clip", "audio/wav", text => results.push(text));
    await waitFor(() => writes.length === 1);
    const original = writes[0] as TranscribeAudioCommand;
    internal.onData(Buffer.from(JSON.stringify({ type: "ack", reqId: original.reqId }) + "\n"));
    internal.handleSocketClose(transport, true);
    internal.socket = transport;
    internal._connected = true;
    internal.flushPendingCommands();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(original);
    internal.onData(Buffer.from(JSON.stringify({
      type: "transcription_result", reqId: original.reqId, text: "recovered voice",
    }) + "\n"));
    expect(results).toEqual(["recovered voice"]);
    expect(internal.flushPendingCommands()).toEqual([]);
    events.length = 0;
    internal.onData(Buffer.from(JSON.stringify({
      type: "transcription_result", reqId: original.reqId, text: "duplicate voice",
    }) + "\n" + JSON.stringify({
      type: "error", reqId: original.reqId, message: "late old result",
    }) + "\n"));
    expect(results).toEqual(["recovered voice"]);
    expect(events).toEqual([]);
    // Only this client's requests are suppressed, not unrelated global errors.
    internal.onData(JSON.stringify({ type: "error", reqId: "transcribe_unrelated", message: "unrelated" }) + "\n");
    expect(events).toEqual([{ type: "error", reqId: "transcribe_unrelated", message: "unrelated" }]);
  });

  for (const action of ["disconnect", "route switch"] as const) {
    test(`${action} cancels uploaded/offline remote ASR without carrying audio to another route`, async () => {
      const { client, internal, writes, events, transport } = remoteClient(`/tmp/absent-${randomUUID()}.sock`);
      const callbacks: string[] = [];
      client.transcribeAudio("old-route-audio", "audio/wav",
        text => callbacks.push(text), message => callbacks.push(message));
      await waitFor(() => writes.length === 1);
      const original = writes[0] as TranscribeAudioCommand;
      internal.handleSocketClose(transport, true);
      client.transcribeAudio("offline-audio", "audio/wav",
        text => callbacks.push(text), message => callbacks.push(message));
      await waitFor(() => internal.pendingCommands.length === 1);
      if (action === "disconnect") client.disconnect();
      else client.ssh("cancel");
      internal.socket = transport;
      internal._connected = true;
      expect(internal.flushPendingCommands()).toEqual([]);
      expect(writes).toHaveLength(1);
      expect(internal.transcriptionCallbacks.size).toBe(0);
      expect(internal.unresolvedTranscriptionCommands.size).toBe(0);
      events.length = 0;
      internal.onData(JSON.stringify({
        type: "error", reqId: original.reqId, message: "old endpoint error",
      }) + "\n");
      expect(callbacks).toEqual([]);
      expect(events).toEqual([]);
    });
  }

  test("repeated SSH loss is bounded to three uploads and settles the voice job once", async () => {
    const { client, internal, writes, transport, events } = remoteClient(`/tmp/absent-${randomUUID()}.sock`);
    const callbacks: string[] = [];
    client.transcribeAudio("clip", "audio/wav",
      text => callbacks.push(text), message => callbacks.push(message));
    await waitFor(() => writes.length === 1);
    const original = writes[0] as TranscribeAudioCommand;
    for (let attempt = 0; attempt < 5; attempt++) {
      internal.handleSocketClose(transport, true);
      internal.socket = transport;
      internal._connected = true;
      internal.flushPendingCommands();
    }
    expect(writes).toEqual([original, original, original]);
    expect(callbacks).toEqual([expect.stringContaining("reconnect limit")]);
    expect(internal.transcriptionCallbacks.size).toBe(0);
    expect(internal.unresolvedTranscriptionCommands.size).toBe(0);
    internal.onData(JSON.stringify({
      type: "transcription_result", reqId: original.reqId, text: "too late",
    }) + "\n");
    expect(callbacks).toHaveLength(1);
    expect(events).toEqual([]);
  });

  test("the final allowed upload can still complete successfully", async () => {
    const { client, internal, writes, transport } = remoteClient(`/tmp/absent-${randomUUID()}.sock`, undefined, {
      transcriptionMaxAttempts: 2,
    });
    const callbacks: string[] = [];
    client.transcribeAudio("clip", "audio/wav",
      text => callbacks.push(text), message => callbacks.push(message));
    await waitFor(() => writes.length === 1);
    internal.handleSocketClose(transport, true);
    internal.socket = transport;
    internal._connected = true;
    internal.flushPendingCommands();
    expect(writes).toHaveLength(2);
    expect(callbacks).toEqual([]);
    internal.onData(JSON.stringify({
      type: "transcription_result", reqId: (writes[1] as TranscribeAudioCommand).reqId, text: "last attempt worked",
    }) + "\n");
    expect(callbacks).toEqual(["last attempt worked"]);
    expect(internal.unresolvedTranscriptionCommands.size).toBe(0);
  });

  for (const state of ["offline", "uploaded"] as const) {
    test(`the transcription deadline expires ${state} requests without later replay`, async () => {
      const { client, internal, writes, transport, events } = remoteClient(`/tmp/absent-${randomUUID()}.sock`, undefined, {
        transcriptionTimeoutMs: 40,
      });
      const callbacks: string[] = [];
      if (state === "offline") internal.handleSocketClose(transport, true);
      client.transcribeAudio("clip", "audio/wav",
        text => callbacks.push(text), message => callbacks.push(message));
      await waitFor(() => internal.unresolvedTranscriptionCommands.size === 1);
      const reqId = [...internal.unresolvedTranscriptionCommands.keys()][0];
      await waitFor(() => callbacks.length === 1);
      expect(callbacks).toEqual([expect.stringContaining("timed out")]);
      expect(internal.transcriptionCallbacks.size).toBe(0);
      expect(internal.unresolvedTranscriptionCommands.size).toBe(0);
      expect(internal.pendingCommands).toEqual([]);
      internal.socket = transport;
      internal._connected = true;
      expect(internal.flushPendingCommands()).toEqual([]);
      expect(writes).toHaveLength(state === "offline" ? 0 : 1);
      internal.onData(JSON.stringify({ type: "error", reqId, message: "late timeout reply" }) + "\n");
      expect(callbacks).toHaveLength(1);
      expect(events).toEqual([]);
    });
  }

  test("reconnect checks the deadline even if its timer has not run yet", async () => {
    const { client, internal, writes, transport } = remoteClient(`/tmp/absent-${randomUUID()}.sock`);
    const errors: string[] = [];
    internal.handleSocketClose(transport, true);
    client.transcribeAudio("clip", "audio/wav", () => {}, message => errors.push(message));
    await waitFor(() => internal.pendingCommands.length === 1);
    // Simulate waking after a long suspension before overdue timers dispatch.
    [...internal.unresolvedTranscriptionCommands.values()][0].expiresAt = Date.now() - 1;
    internal.socket = transport;
    internal._connected = true;
    expect(internal.flushPendingCommands()).toEqual([]);
    expect(writes).toEqual([]);
    expect(errors).toEqual([expect.stringContaining("timed out")]);
    expect(internal.pendingCommands).toEqual([]);
  });

  for (const action of ["disconnect", "route switch"] as const) {
    test(`${action} cancels local requests without callbacks or cross-endpoint fallback`, async () => {
      const local = await localDaemon(() => {});
      const { client, internal, writes } = remoteClient(local.path);
      const callbacks: string[] = [];
      client.transcribeAudio("clip", "audio/wav", text => callbacks.push(text), message => callbacks.push(message));
      await waitFor(() => local.commands.length > 0);
      if (action === "disconnect") client.disconnect();
      else client.ssh("cancel");
      await waitFor(() => local.sockets.size === 0);
      expect(writes).toEqual([]);
      expect(callbacks).toEqual([]);
      expect(internal.pendingCommands).toEqual([]);
      expect(internal.localTranscriptions.size).toBe(0);
    });
  }
});
