/**
 * Previews of image bytes the TUI already holds (a pasted image's local echo),
 * rendered on this machine instead of asking the daemon. Over /ssh the daemon
 * can only answer once the whole message has been uploaded, so a just-sent
 * photo would otherwise show "loading image…" for that long.
 *
 * Mirrors the daemon's renderer (daemon/src/attachments.ts) with ImageMagick;
 * on a Mac without it, `sips` renders PNG previews.
 */

import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageMediaType } from "./messages";
import { sniffImage } from "@exocortex/shared/image-sniff";

export interface LocalPreviewRequest {
  format: "png" | "rgba";
  width: number;
  height: number;
  purpose?: "thumbnail";
}

export interface LocalPreview {
  format: "png" | "rgba";
  width: number;
  height: number;
  base64: string;
}

type Run = (command: string, args: string[], input?: Buffer) => Promise<Buffer>;

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const run: Run = (command, args, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    else chunks.push(chunk);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) resolve(Buffer.concat(chunks));
    else reject(new Error(`${command} exited with ${signal ?? code}`));
  });
  child.stdin.on("error", () => { /* the child exited early; close reports it */ });
  child.stdin.end(input);
});

const MAGICK_FORMATS: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Tools found missing; not tried again in this process. */
const missing = new Set<string>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * The daemon quantizes thumbnails to save bytes on the wire; here the PNG
 * only crosses one when the terminal itself is at the far end of SSH, and
 * quantizing costs more time than the transfer it saves.
 */
const QUANTIZE_THUMBNAILS = Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);

async function renderWithMagick(bytes: Buffer, mediaType: ImageMediaType, request: LocalPreviewRequest, exec: Run): Promise<LocalPreview> {
  // libjpeg can decode at 1/2–1/8 scale; ask for no less than twice the box.
  const decodeHint = mediaType === "image/jpeg" ? ["-define", `jpeg:size=${request.width * 2}x${request.height * 2}`] : [];
  const input = [...decodeHint, `${MAGICK_FORMATS[mediaType]}:-[0]`];
  if (request.format === "png") {
    const data = await exec("magick", [
      ...input, "-auto-orient", "-resize", `${request.width}x${request.height}>`,
      ...(request.purpose === "thumbnail" && QUANTIZE_THUMBNAILS ? ["-colors", "256", "-type", "PaletteAlpha"] : []),
      "-strip", "png:-",
    ], bytes);
    const out = sniffImage(data);
    if (!out || out.mediaType !== "image/png") throw new Error("magick produced no PNG");
    return { format: "png", width: out.width, height: out.height, base64: data.toString("base64") };
  }
  const data = await exec("magick", [
    ...input, "-auto-orient", "-resize", `${request.width}x${request.height}!`,
    "-unsharp", "0x1+2+0", "-depth", "8", "rgba:-",
  ], bytes);
  if (data.length !== request.width * request.height * 4) throw new Error("magick produced the wrong pixel count");
  return { format: "rgba", width: request.width, height: request.height, base64: data.toString("base64") };
}

async function renderWithSips(bytes: Buffer, request: LocalPreviewRequest, exec: Run): Promise<LocalPreview> {
  const source = sniffImage(bytes);
  if (request.format !== "png" || !source) throw new Error("sips renders PNG previews only");
  // sips -Z bounds the long side; pick the one that fits the box.
  const scale = Math.min(1, request.width / source.width, request.height / source.height);
  const longSide = Math.max(1, Math.floor(Math.max(source.width, source.height) * scale));
  const base = join(tmpdir(), `exocortex-preview-${process.pid}-${randomUUID()}`);
  const inPath = `${base}.${MAGICK_FORMATS[source.mediaType]}`;
  const outPath = `${base}.png`;
  try {
    await writeFile(inPath, bytes);
    await exec("sips", ["-s", "format", "png", "-Z", String(longSide), inPath, "--out", outPath]);
    const data = await readFile(outPath);
    const out = sniffImage(data);
    if (!out || out.mediaType !== "image/png") throw new Error("sips produced no PNG");
    return { format: "png", width: out.width, height: out.height, base64: data.toString("base64") };
  } finally {
    await Promise.all([rm(inPath, { force: true }), rm(outPath, { force: true })]);
  }
}

export async function renderLocalPreview(
  base64: string,
  mediaType: ImageMediaType,
  request: LocalPreviewRequest,
  options: { exec?: Run; platform?: NodeJS.Platform } = {},
): Promise<LocalPreview> {
  const exec = options.exec ?? run;
  const bytes = Buffer.from(base64, "base64");
  if (!missing.has("magick")) {
    try {
      return await renderWithMagick(bytes, mediaType, request, exec);
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.add("magick");
    }
  }
  if ((options.platform ?? process.platform) === "darwin" && !missing.has("sips")) {
    try {
      return await renderWithSips(bytes, request, exec);
    } catch (error) {
      if (isMissing(error)) missing.add("sips");
      throw error;
    }
  }
  throw new Error("no local image renderer (ImageMagick)");
}

export function resetLocalPreviewToolsForTest(): void {
  missing.clear();
}
