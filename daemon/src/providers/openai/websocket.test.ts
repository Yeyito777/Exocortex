import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { OpenAIWebSocketConnection } from "./websocket";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: Buffer[] = [];

  write(chunk: Uint8Array | string, cb?: (err?: Error) => void): boolean;
  write(chunk: Uint8Array | string, encoding?: BufferEncoding, cb?: (err?: Error) => void): boolean;
  write(
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    callback?.();
    return true;
  }

  end(): this {
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

class StalledWriteSocket extends FakeSocket {
  override write(chunk: Uint8Array | string, cb?: (err?: Error) => void): boolean;
  override write(chunk: Uint8Array | string, encoding?: BufferEncoding, cb?: (err?: Error) => void): boolean;
  override write(
    chunk: Uint8Array | string,
    _encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    _cb?: (err?: Error) => void,
  ): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }
}

function serverFrame(opcode: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const payloadBuffer = Buffer.from(payload);
  let headerLength = 2;
  if (payloadBuffer.length >= 126 && payloadBuffer.length <= 0xffff) headerLength += 2;
  else if (payloadBuffer.length > 0xffff) headerLength += 8;

  const frame = Buffer.alloc(headerLength + payloadBuffer.length);
  frame[0] = 0x80 | opcode;
  if (payloadBuffer.length < 126) {
    frame[1] = payloadBuffer.length;
  } else if (payloadBuffer.length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(payloadBuffer.length, 2);
  } else {
    frame[1] = 127;
    const high = Math.floor(payloadBuffer.length / 2 ** 32);
    const low = payloadBuffer.length >>> 0;
    frame.writeUInt32BE(high, 2);
    frame.writeUInt32BE(low, 6);
  }
  payloadBuffer.copy(frame, headerLength);
  return frame;
}

function closePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

function decodeClientFrame(frame: Buffer): { opcode: number; payload: Buffer } {
  const opcode = frame[0] & 0x0f;
  const masked = (frame[1] & 0x80) !== 0;
  let length = frame[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    const high = frame.readUInt32BE(offset);
    const low = frame.readUInt32BE(offset + 4);
    length = high * 2 ** 32 + low;
    offset += 8;
  }
  const mask = masked ? frame.subarray(offset, offset + 4) : Buffer.alloc(0);
  if (masked) offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload };
}

describe("OpenAIWebSocketConnection", () => {
  test("buffers server messages that arrive before nextMessage is waiting", async () => {
    const raw = new FakeSocket();
    const socket = new OpenAIWebSocketConnection(raw as unknown as Socket);

    raw.emit("data", serverFrame(0x1, Buffer.from("hello")));

    await expect(socket.nextMessage(100)).resolves.toEqual({ type: "text", text: "hello" });
  });

  test("answers ping frames even while the application is idle", () => {
    const raw = new FakeSocket();
    new OpenAIWebSocketConnection(raw as unknown as Socket);

    raw.emit("data", serverFrame(0x9, Buffer.from("keepalive")));

    expect(raw.writes).toHaveLength(1);
    expect(decodeClientFrame(raw.writes[0])).toEqual({
      opcode: 0xA,
      payload: Buffer.from("keepalive"),
    });
  });

  test("queues close frames that arrive while idle with their reason", async () => {
    const raw = new FakeSocket();
    const socket = new OpenAIWebSocketConnection(raw as unknown as Socket);

    raw.emit("data", serverFrame(0x8, closePayload(1011, "keepalive ping timeout")));

    await expect(socket.nextMessage(100)).resolves.toEqual({
      type: "close",
      code: 1011,
      reason: "keepalive ping timeout",
    });
    expect(decodeClientFrame(raw.writes[0]).opcode).toBe(0x8);
  });

  test("times out when a websocket request write never completes", async () => {
    const raw = new StalledWriteSocket();
    const socket = new OpenAIWebSocketConnection(raw as unknown as Socket);

    await expect(socket.sendText("hello", undefined, 5)).rejects.toThrow("No websocket write completion for 0.005s");
  });
});
