import { randomBytes, createHash } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { createAbortError } from "../../abort";

export interface OpenAIWebSocketConnectResult {
  socket: OpenAIWebSocketConnection;
  headers: Headers;
}

export type OpenAIWebSocketConnector = (
  urlString: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<OpenAIWebSocketConnectResult>;

export class OpenAIWebSocketHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly headers: Headers,
    public readonly body: string,
  ) {
    super(`OpenAI websocket handshake failed with HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "OpenAIWebSocketHttpError";
  }
}

export type OpenAIWebSocketMessage =
  | { type: "text"; text: string }
  | { type: "binary"; data: Buffer }
  | { type: "close"; code?: number; reason?: string };

const CONNECT_TIMEOUT_MS = 30_000;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function abortableError(signal?: AbortSignal): Error {
  return signal?.aborted ? createAbortError() : new Error("OpenAI websocket connection aborted");
}

const EMPTY_CERT_SUBJECT = {};

function safeCheckServerIdentity(hostname: string, cert: Parameters<typeof checkServerIdentity>[1]): Error | undefined {
  // Bun's Node TLS shim can call this hook with `cert` missing, or with
  // `subject: null`, which makes Node's checkServerIdentity throw while
  // destructuring. The TLS layer still performs CA verification; when Bun
  // omits the cert object there is no hostname payload for us to inspect.
  if (cert == null) return undefined;

  // Preserve normal hostname verification when a cert object is available,
  // normalizing the SAN-only shape Node expects.
  const safeCert = cert && typeof cert === "object" && (cert as { subject?: unknown }).subject == null
    ? { ...cert, subject: EMPTY_CERT_SUBJECT }
    : cert;
  return checkServerIdentity(hostname, safeCert);
}

function headerLines(headers: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || value === "") continue;
    // Hop-by-hop websocket handshake headers are owned by this transport.
    if (/^(connection|upgrade|sec-websocket-key|sec-websocket-version|sec-websocket-extensions)$/i.test(name)) continue;
    lines.push(`${name}: ${String(value).replace(/[\r\n]+/g, " ")}`);
  }
  return lines;
}

function expectedAccept(key: string): string {
  return createHash("sha1").update(`${key}${GUID}`).digest("base64");
}

function parseHeaders(raw: string): { status: number; headers: Headers } {
  const lines = raw.split("\r\n");
  const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/i.exec(lines.shift() ?? "");
  if (!statusMatch) throw new Error("invalid websocket handshake response");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { status: Number(statusMatch[1]), headers };
}

async function openTcpSocket(url: URL, signal?: AbortSignal): Promise<Socket> {
  if (signal?.aborted) throw createAbortError();
  const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
  const host = url.hostname;

  return await new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error("OpenAI websocket connect timeout")), CONNECT_TIMEOUT_MS);
    const socket: Socket = url.protocol === "wss:"
      ? tlsConnect({ host, port, servername: host, checkServerIdentity: safeCheckServerIdentity })
      : netConnect({ host, port });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", fail);
      socket.off("connect", onConnect);
      socket.off("secureConnect", onConnect);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onAbort = () => fail(abortableError(signal));
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", fail);
    if (url.protocol === "wss:") socket.once("secureConnect", onConnect);
    else socket.once("connect", onConnect);
  });
}

async function performHandshake(socket: Socket, url: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<{ headers: Headers; leftover: Buffer }> {
  const key = randomBytes(16).toString("base64");
  const path = `${url.pathname || "/"}${url.search}`;
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    ...headerLines(headers),
    "",
    "",
  ].join("\r\n");

  socket.write(request);

  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => fail(new Error("OpenAI websocket handshake timeout")), CONNECT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onAbort = () => fail(abortableError(signal));
    const onClose = () => fail(new Error("OpenAI websocket closed during handshake"));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      try {
        const rawHeaders = buffer.subarray(0, headerEnd).toString("utf8");
        const leftover = buffer.subarray(headerEnd + 4);
        const parsed = parseHeaders(rawHeaders);
        if (parsed.status !== 101) {
          const contentLength = Number(parsed.headers.get("content-length"));
          if (Number.isFinite(contentLength) && contentLength > leftover.length) return;
          const body = Number.isFinite(contentLength)
            ? leftover.subarray(0, contentLength).toString("utf8")
            : leftover.toString("utf8");
          throw new OpenAIWebSocketHttpError(parsed.status, parsed.headers, body);
        }
        const accept = parsed.headers.get("sec-websocket-accept");
        if (accept !== expectedAccept(key)) {
          throw new Error("invalid websocket Sec-WebSocket-Accept response");
        }
        settled = true;
        cleanup();
        resolve({ headers: parsed.headers, leftover });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", onClose);
  });
}

let connectorForTest: OpenAIWebSocketConnector | null = null;

export function setOpenAIWebSocketConnectorForTest(connector: OpenAIWebSocketConnector | null): void {
  connectorForTest = connector;
}

export async function connectOpenAIWebSocket(urlString: string, headers: Record<string, string>, signal?: AbortSignal): Promise<OpenAIWebSocketConnectResult> {
  if (connectorForTest) return connectorForTest(urlString, headers, signal);
  return connectOpenAIWebSocketImpl(urlString, headers, signal);
}

async function connectOpenAIWebSocketImpl(urlString: string, headers: Record<string, string>, signal?: AbortSignal): Promise<OpenAIWebSocketConnectResult> {
  const url = new URL(urlString);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`unsupported OpenAI websocket protocol: ${url.protocol}`);
  }
  const rawSocket = await openTcpSocket(url, signal);
  try {
    const handshake = await performHandshake(rawSocket, url, headers, signal);
    return {
      socket: new OpenAIWebSocketConnection(rawSocket, handshake.leftover),
      headers: handshake.headers,
    };
  } catch (err) {
    rawSocket.destroy();
    throw err;
  }
}

export class OpenAIWebSocketConnection {
  private buffer: Buffer;
  private closed = false;
  private fragmentedOpcode: number | null = null;
  private fragments: Buffer[] = [];

  constructor(private readonly socket: Socket, leftover: Buffer = Buffer.alloc(0)) {
    this.buffer = leftover;
    this.socket.once("close", () => {
      this.closed = true;
    });
  }

  async sendText(text: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw createAbortError();
    if (this.closed) throw new Error("OpenAI websocket is closed");
    const frame = encodeFrame(0x1, Buffer.from(text, "utf8"));
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(createAbortError());
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.socket.write(frame, (err) => {
        cleanup();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async nextMessage(timeoutMs: number, signal?: AbortSignal): Promise<OpenAIWebSocketMessage> {
    if (signal?.aborted) throw createAbortError();
    const existing = this.tryReadMessage();
    if (existing) return existing;
    if (this.closed) return { type: "close" };

    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error(`No websocket data for ${timeoutMs / 1000}s`)), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.socket.off("data", onData);
        this.socket.off("error", fail);
        this.socket.off("close", onClose);
      };
      const finish = (message: OpenAIWebSocketMessage) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(message);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onAbort = () => fail(createAbortError());
      const onClose = () => finish({ type: "close" });
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const message = this.tryReadMessage();
        if (message) finish(message);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.socket.on("data", onData);
      this.socket.once("error", fail);
      this.socket.once("close", onClose);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {}
    this.socket.end();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private tryReadMessage(): OpenAIWebSocketMessage | null {
    while (true) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return null;
      this.buffer = this.buffer.subarray(frame.consumed);

      switch (frame.opcode) {
        case 0x0: {
          if (this.fragmentedOpcode == null) continue;
          this.fragments.push(frame.payload);
          if (!frame.fin) continue;
          const payload = Buffer.concat(this.fragments);
          const opcode = this.fragmentedOpcode;
          this.fragmentedOpcode = null;
          this.fragments = [];
          return opcode === 0x1 ? { type: "text", text: payload.toString("utf8") } : { type: "binary", data: payload };
        }
        case 0x1:
        case 0x2:
          if (!frame.fin) {
            this.fragmentedOpcode = frame.opcode;
            this.fragments = [frame.payload];
            continue;
          }
          return frame.opcode === 0x1
            ? { type: "text", text: frame.payload.toString("utf8") }
            : { type: "binary", data: frame.payload };
        case 0x8: {
          this.closed = true;
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
          const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : undefined;
          return { type: "close", code, reason };
        }
        case 0x9:
          this.socket.write(encodeFrame(0xA, frame.payload));
          continue;
        case 0xA:
          continue;
        default:
          continue;
      }
    }
  }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let headerLength = 2;
  if (payload.length >= 126 && payload.length <= 0xffff) headerLength += 2;
  else if (payload.length > 0xffff) headerLength += 8;

  const frame = Buffer.alloc(headerLength + 4 + payload.length);
  frame[0] = 0x80 | opcode;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 0x80 | 127;
    const high = Math.floor(payload.length / 2 ** 32);
    const low = payload.length >>> 0;
    frame.writeUInt32BE(high, 2);
    frame.writeUInt32BE(low, 6);
  }
  mask.copy(frame, headerLength);
  for (let i = 0; i < payload.length; i++) {
    frame[headerLength + 4 + i] = payload[i] ^ mask[i % 4];
  }
  return frame;
}

function decodeFrame(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    const combined = high * 2 ** 32 + low;
    if (!Number.isSafeInteger(combined)) throw new Error("websocket frame too large");
    length = combined;
    offset += 8;
  }

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { fin, opcode, payload, consumed: offset + length };
}
