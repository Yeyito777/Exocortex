/**
 * MIME-aware clipboard transport over the terminal.
 *
 * Kitty's OSC 5522 protocol lets a terminal application request arbitrary
 * clipboard MIME data. Because the request travels on stdout and the response
 * arrives on stdin, it works unchanged through an SSH PTY.
 */

import type { ImageAttachment, ImageMediaType } from "./messages";
export {
  disable_clipboard_paste_events,
  enable_clipboard_paste_events,
  query_clipboard_paste_events,
} from "./terminal";

const ESC = "\x1b";
const OSC_5522_PREFIX = `${ESC}]5522;`;
const ST = `${ESC}\\`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const MAX_OSC_FRAME_CHARS = 16 * 1024;
const MAX_CLIPBOARD_BYTES = 50 * 1024 * 1024;
const MAX_PROTOCOL_CHUNK_BYTES = 4096;
const MAX_MIME_LIST_BYTES = 64 * 1024;
const TRANSFER_TIMEOUT_MS = 10_000;

const IMAGE_MIME_PRIORITY: readonly ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

interface ClipboardPacket {
  metadata: Record<string, string>;
  payload: string;
}

interface OfferTransfer {
  chunks: Buffer[];
  sizeBytes: number;
  password: string | null;
  location: "clipboard" | "primary";
}

interface DataTransfer {
  requestedMime: string;
  chunks: Buffer[];
  sizeBytes: number;
  opened: boolean;
}

export interface TerminalClipboardClientOptions {
  write: (sequence: string) => void;
  onImage: (image: ImageAttachment) => void;
  onText: (text: string) => void;
  onError?: (message: string) => void;
}

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function decodeBase64(value: string): Buffer | null {
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  return Buffer.from(value, "base64");
}

function parseClipboardPacket(sequence: string): ClipboardPacket | null {
  if (!sequence.startsWith(OSC_5522_PREFIX)) return null;

  let body: string;
  if (sequence.endsWith(ST)) body = sequence.slice(OSC_5522_PREFIX.length, -ST.length);
  else if (sequence.endsWith("\x07")) body = sequence.slice(OSC_5522_PREFIX.length, -1);
  else return null;

  const separator = body.indexOf(";");
  const metadataText = separator === -1 ? body : body.slice(0, separator);
  const payload = separator === -1 ? "" : body.slice(separator + 1);
  const metadata: Record<string, string> = {};

  for (const field of metadataText.split(":")) {
    const equals = field.indexOf("=");
    if (equals <= 0) return null;
    metadata[field.slice(0, equals)] = field.slice(equals + 1);
  }

  return { metadata, payload };
}

function clipboardReadRequest(mime: string, offer: OfferTransfer): string {
  const metadata = ["type=read"];
  if (offer.location === "primary") metadata.push("loc=primary");
  if (offer.password) {
    metadata.push(`pw=${offer.password}`);
    metadata.push(`name=${encodeBase64("Paste event")}`);
  }
  return `${OSC_5522_PREFIX}${metadata.join(":")};${encodeBase64(mime)}${ST}`;
}

function textMimeFromOffer(mimeTypes: readonly string[]): string | null {
  return mimeTypes.find((mime) => mime === "text/plain")
    ?? mimeTypes.find((mime) => mime.toLowerCase().startsWith("text/plain;"))
    ?? null;
}

/**
 * Stateful OSC 5522 client. It accepts complete terminal control sequences;
 * TerminalControlBuffer below is responsible for framing the stdin byte stream.
 */
export class TerminalClipboardClient {
  private offer: OfferTransfer | null = null;
  private transfer: DataTransfer | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private supported: boolean | null = null;

  constructor(private readonly options: TerminalClipboardClientOptions) {}

  isSupported(): boolean | null {
    return this.supported;
  }

  handleControlSequence(sequence: string): boolean {
    const mode = /^\x1b\[\?5522;([0-4])\$y$/.exec(sequence);
    if (mode) {
      const value = Number(mode[1]);
      this.supported = value !== 0 && value !== 4;
      return true;
    }

    const packet = parseClipboardPacket(sequence);
    if (!packet) return false;
    if (packet.metadata.type !== "read") return true;
    this.handleReadPacket(packet);
    return true;
  }

  dispose(): void {
    this.clearTimeout();
    this.offer = null;
    this.transfer = null;
  }

  private handleReadPacket(packet: ClipboardPacket): void {
    const status = packet.metadata.status;
    if (!status) return;

    if (this.transfer) {
      this.handleDataTransferPacket(packet, status);
      return;
    }

    this.handleOfferPacket(packet, status);
  }

  private handleOfferPacket(packet: ClipboardPacket, status: string): void {
    if (status === "OK") {
      this.offer = {
        chunks: [],
        sizeBytes: 0,
        password: packet.metadata.pw ?? null,
        location: packet.metadata.loc === "primary" ? "primary" : "clipboard",
      };
      this.armTimeout();
      return;
    }

    if (!this.offer) return;
    if (status === "DATA") {
      const mime = decodeBase64(packet.metadata.mime ?? "")?.toString("utf8");
      if (mime !== ".") return;
      const chunk = this.decodeChunk(packet.payload);
      if (!chunk || !this.appendOfferChunk(chunk)) return;
      if (!this.offer.password && packet.metadata.pw) this.offer.password = packet.metadata.pw;
      this.armTimeout();
      return;
    }

    if (status === "DONE") {
      const offer = this.offer;
      this.offer = null;
      this.clearTimeout();
      this.finishOffer(offer);
      return;
    }

    this.fail(`Terminal clipboard offer failed: ${status}`);
  }

  private finishOffer(offer: OfferTransfer): void {
    const mimeTypes = Buffer.concat(offer.chunks)
      .toString("utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const requestedMime = IMAGE_MIME_PRIORITY.find((mime) => mimeTypes.includes(mime))
      ?? textMimeFromOffer(mimeTypes);
    if (!requestedMime) return;

    this.transfer = {
      requestedMime,
      chunks: [],
      sizeBytes: 0,
      opened: false,
    };
    this.armTimeout();
    this.options.write(clipboardReadRequest(requestedMime, offer));
  }

  private handleDataTransferPacket(packet: ClipboardPacket, status: string): void {
    const transfer = this.transfer;
    if (!transfer) return;

    if (status === "OK") {
      transfer.opened = true;
      this.armTimeout();
      return;
    }

    if (status === "DATA") {
      if (!transfer.opened) {
        this.fail("Terminal clipboard sent data before OK");
        return;
      }
      const mime = decodeBase64(packet.metadata.mime ?? "")?.toString("utf8");
      if (mime !== transfer.requestedMime) return;
      const chunk = this.decodeChunk(packet.payload);
      if (!chunk || !this.appendTransferChunk(transfer, chunk)) return;
      this.armTimeout();
      return;
    }

    if (status === "DONE") {
      if (!transfer.opened) {
        this.fail("Terminal clipboard transfer ended before OK");
        return;
      }
      this.transfer = null;
      this.clearTimeout();
      const bytes = Buffer.concat(transfer.chunks);
      if (transfer.requestedMime.startsWith("image/")) {
        if (!IMAGE_MIME_PRIORITY.includes(transfer.requestedMime as ImageMediaType) || bytes.length === 0) return;
        this.options.onImage({
          mediaType: transfer.requestedMime as ImageMediaType,
          base64: bytes.toString("base64"),
          sizeBytes: bytes.length,
        });
      } else {
        this.options.onText(bytes.toString("utf8"));
      }
      return;
    }

    this.fail(`Terminal clipboard read failed: ${status}`);
  }

  private decodeChunk(payload: string): Buffer | null {
    const chunk = decodeBase64(payload);
    if (!chunk) {
      this.fail("Terminal clipboard returned malformed base64");
      return null;
    }
    if (chunk.length > MAX_PROTOCOL_CHUNK_BYTES) {
      this.fail("Terminal clipboard returned an oversized protocol chunk");
      return null;
    }
    return chunk;
  }

  private appendOfferChunk(chunk: Buffer): boolean {
    if (!this.offer) return false;
    if (this.offer.sizeBytes + chunk.length > MAX_MIME_LIST_BYTES) {
      this.fail("Terminal clipboard MIME list is too large");
      return false;
    }
    this.offer.chunks.push(chunk);
    this.offer.sizeBytes += chunk.length;
    return true;
  }

  private appendTransferChunk(transfer: DataTransfer, chunk: Buffer): boolean {
    if (transfer.sizeBytes + chunk.length > MAX_CLIPBOARD_BYTES) {
      this.fail("Terminal clipboard image exceeds the 50 MB limit");
      return false;
    }
    transfer.chunks.push(chunk);
    transfer.sizeBytes += chunk.length;
    return true;
  }

  private armTimeout(): void {
    this.clearTimeout();
    this.timeout = setTimeout(() => this.fail("Terminal clipboard transfer timed out"), TRANSFER_TIMEOUT_MS);
    this.timeout.unref?.();
  }

  private clearTimeout(): void {
    if (!this.timeout) return;
    clearTimeout(this.timeout);
    this.timeout = null;
  }

  private fail(message: string): void {
    this.clearTimeout();
    this.offer = null;
    this.transfer = null;
    this.options.onError?.(message);
  }
}

/**
 * Extract terminal replies from the same stdin stream as key presses. OSC and
 * CSI replies can be split at any byte boundary by SSH, so incomplete control
 * sequences are retained until their terminator arrives.
 */
export class TerminalControlBuffer {
  private buffer = "";
  private bracketedPaste = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onInput: (data: string) => void,
    private readonly onControlSequence: (sequence: string) => void,
  ) {}

  feed(data: Buffer | string): void {
    this.clearTimer();
    this.buffer += typeof data === "string" ? data : data.toString("utf8");
    this.drain();
  }

  dispose(): void {
    this.clearTimer();
    if (this.buffer) this.onInput(this.buffer);
    this.buffer = "";
    this.bracketedPaste = false;
  }

  private drain(): void {
    while (this.buffer) {
      if (this.bracketedPaste) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end !== -1) {
          const length = end + PASTE_END.length;
          this.emitInput(this.buffer.slice(0, length));
          this.buffer = this.buffer.slice(length);
          this.bracketedPaste = false;
          continue;
        }
        const safeLength = Math.max(0, this.buffer.length - (PASTE_END.length - 1));
        if (safeLength > 0) {
          this.emitInput(this.buffer.slice(0, safeLength));
          this.buffer = this.buffer.slice(safeLength);
        }
        this.armTimer(2000, false);
        return;
      }

      const escape = this.buffer.indexOf(ESC);
      if (escape === -1) {
        this.emitInput(this.buffer);
        this.buffer = "";
        return;
      }
      if (escape > 0) {
        this.emitInput(this.buffer.slice(0, escape));
        this.buffer = this.buffer.slice(escape);
      }

      if (this.buffer.length === 1) {
        this.armTimer(30, false);
        return;
      }

      if (this.buffer.startsWith(`${ESC}]`)) {
        const stIndex = this.buffer.indexOf(ST, 2);
        const bellIndex = this.buffer.indexOf("\x07", 2);
        let end = -1;
        if (stIndex !== -1 && bellIndex !== -1) end = Math.min(stIndex + ST.length, bellIndex + 1);
        else if (stIndex !== -1) end = stIndex + ST.length;
        else if (bellIndex !== -1) end = bellIndex + 1;

        if (end === -1) {
          if (this.buffer.startsWith(OSC_5522_PREFIX) && this.buffer.length > MAX_OSC_FRAME_CHARS) {
            this.buffer = "";
            return;
          }
          this.armTimer(this.buffer.startsWith(OSC_5522_PREFIX) ? 5000 : 100, this.buffer.startsWith(OSC_5522_PREFIX));
          return;
        }

        const sequence = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        if (sequence.startsWith(OSC_5522_PREFIX)) this.onControlSequence(sequence);
        continue;
      }

      if (this.buffer.startsWith(`${ESC}[`)) {
        let final = 2;
        while (final < this.buffer.length) {
          const code = this.buffer.charCodeAt(final);
          if (code >= 0x40 && code <= 0x7e) break;
          final++;
        }
        if (final >= this.buffer.length) {
          this.armTimer(100, false);
          return;
        }

        const sequence = this.buffer.slice(0, final + 1);
        this.buffer = this.buffer.slice(final + 1);
        if (/^\x1b\[\?5522;[0-4]\$y$/.test(sequence)) {
          this.onControlSequence(sequence);
        } else {
          this.emitInput(sequence);
          if (sequence === PASTE_START) this.bracketedPaste = true;
        }
        continue;
      }

      this.emitInput(ESC);
      this.buffer = this.buffer.slice(1);
    }
  }

  private emitInput(data: string): void {
    if (data) this.onInput(data);
  }

  private armTimer(milliseconds: number, drop: boolean): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      const buffered = this.buffer;
      this.buffer = "";
      this.bracketedPaste = false;
      if (!drop && buffered) this.onInput(buffered);
    }, milliseconds);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
