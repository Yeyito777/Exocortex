import { describe, expect, test } from "bun:test";

import {
  TerminalClipboardClient,
  TerminalControlBuffer,
  disable_clipboard_paste_events,
  enable_clipboard_paste_events,
  query_clipboard_paste_events,
} from "./terminalclipboard";

const ST = "\x1b\\";

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64");
}

function packet(metadata: string, payload?: string): string {
  return `\x1b]5522;${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

function pasteOffer(mimeTypes: string, password = b64("one-time")): string[] {
  return [
    packet(`type=read:status=OK:pw=${password}`),
    packet(`type=read:status=DATA:mime=${b64(".")}:pw=${password}`, b64(mimeTypes)),
    packet(`type=read:status=DONE:pw=${password}`),
  ];
}

describe("OSC 5522 clipboard client", () => {
  test("exports capability lifecycle sequences", () => {
    expect(query_clipboard_paste_events).toBe("\x1b[?5522$p");
    expect(enable_clipboard_paste_events).toBe("\x1b[?5522h");
    expect(disable_clipboard_paste_events).toBe("\x1b[?5522l");
  });

  test("detects supported and unsupported paste-event mode", () => {
    const client = new TerminalClipboardClient({ write() {}, onImage() {}, onText() {} });
    expect(client.isSupported()).toBeNull();
    expect(client.handleControlSequence("\x1b[?5522;2$y")).toBe(true);
    expect(client.isSupported()).toBe(true);
    client.handleControlSequence("\x1b[?5522;4$y");
    expect(client.isSupported()).toBe(false);
    client.dispose();
  });

  test("selects the preferred image MIME type and reassembles padded chunks", () => {
    const writes: string[] = [];
    const images: Array<{ mediaType: string; base64: string; sizeBytes: number }> = [];
    const errors: string[] = [];
    const client = new TerminalClipboardClient({
      write: (sequence) => writes.push(sequence),
      onImage: (image) => images.push(image),
      onText() {},
      onError: (message) => errors.push(message),
    });

    for (const sequence of pasteOffer("text/plain image/jpeg image/png\n")) {
      expect(client.handleControlSequence(sequence)).toBe(true);
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("type=read:pw=b25lLXRpbWU=:name=UGFzdGUgZXZlbnQ=");
    expect(writes[0]).toContain(`;${b64("image/png")}${ST}`);

    client.handleControlSequence(packet("type=read:status=OK"));
    client.handleControlSequence(packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64(Buffer.from([1]))));
    client.handleControlSequence(packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64(Buffer.from([2, 3]))));
    client.handleControlSequence(packet("type=read:status=DONE"));

    expect(errors).toEqual([]);
    expect(images).toEqual([{
      mediaType: "image/png",
      base64: Buffer.from([1, 2, 3]).toString("base64"),
      sizeBytes: 3,
    }]);
    client.dispose();
  });

  test("requests text when no supported image exists", () => {
    const writes: string[] = [];
    const pasted: string[] = [];
    const client = new TerminalClipboardClient({
      write: (sequence) => writes.push(sequence),
      onImage() {},
      onText: (text) => pasted.push(text),
    });

    for (const sequence of pasteOffer("text/html text/plain;charset=utf-8")) {
      client.handleControlSequence(sequence);
    }
    expect(writes[0]).toContain(`;${b64("text/plain;charset=utf-8")}${ST}`);

    client.handleControlSequence(packet("type=read:status=OK"));
    client.handleControlSequence(packet(`type=read:status=DATA:mime=${b64("text/plain;charset=utf-8")}`, b64("hello\nworld")));
    client.handleControlSequence(packet("type=read:status=DONE"));
    expect(pasted).toEqual(["hello\nworld"]);
    client.dispose();
  });

  test("preserves the primary clipboard location in the read request", () => {
    const writes: string[] = [];
    const password = b64("primary-token");
    const client = new TerminalClipboardClient({ write: (sequence) => writes.push(sequence), onImage() {}, onText() {} });
    client.handleControlSequence(packet(`type=read:status=OK:loc=primary:pw=${password}`));
    client.handleControlSequence(packet(`type=read:status=DATA:mime=${b64(".")}:pw=${password}`, b64("image/webp")));
    client.handleControlSequence(packet(`type=read:status=DONE:loc=primary:pw=${password}`));
    expect(writes[0]).toContain("type=read:loc=primary:");
    client.dispose();
  });

  test("rejects malformed base64 without producing an attachment", () => {
    const errors: string[] = [];
    let imageCount = 0;
    const client = new TerminalClipboardClient({
      write() {},
      onImage: () => imageCount++,
      onText() {},
      onError: (message) => errors.push(message),
    });
    for (const sequence of pasteOffer("image/png")) client.handleControlSequence(sequence);
    client.handleControlSequence(packet("type=read:status=OK"));
    client.handleControlSequence(packet(`type=read:status=DATA:mime=${b64("image/png")}`, "not-base64"));
    client.handleControlSequence(packet("type=read:status=DONE"));
    expect(imageCount).toBe(0);
    expect(errors).toEqual(["Terminal clipboard returned malformed base64"]);
    client.dispose();
  });
});

describe("terminal control stream framing", () => {
  test("extracts an OSC response fragmented at every byte boundary", () => {
    const input: string[] = [];
    const controls: string[] = [];
    const buffer = new TerminalControlBuffer((data) => input.push(data), (sequence) => controls.push(sequence));
    const sequence = packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64("png"));
    for (const byte of Buffer.from(sequence)) buffer.feed(Buffer.from([byte]));
    expect(input).toEqual([]);
    expect(controls).toEqual([sequence]);
    buffer.dispose();
  });

  test("separates adjacent keyboard, CSI capability, and OSC data", () => {
    const input: string[] = [];
    const controls: string[] = [];
    const buffer = new TerminalControlBuffer((data) => input.push(data), (sequence) => controls.push(sequence));
    const osc = packet("type=read:status=OK");
    buffer.feed(`a\x1b[?5522;1$yb${osc}c`);
    expect(input.join("")).toBe("abc");
    expect(controls).toEqual(["\x1b[?5522;1$y", osc]);
    buffer.dispose();
  });

  test("does not interpret control-looking text inside bracketed paste", () => {
    const input: string[] = [];
    const controls: string[] = [];
    const buffer = new TerminalControlBuffer((data) => input.push(data), (sequence) => controls.push(sequence));
    const pasted = `\x1b[200~literal ${packet("type=read:status=OK")} text\x1b[201~`;
    for (let offset = 0; offset < pasted.length; offset += 3) buffer.feed(pasted.slice(offset, offset + 3));
    expect(input.join("")).toBe(pasted);
    expect(controls).toEqual([]);
    buffer.dispose();
  });
});
