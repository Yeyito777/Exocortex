/**
 * Video attachments: the attach tool keeps MP4/MOV/WebM/MKV files and
 * animated GIFs as playable videos (docs/video-attachments.md).
 *
 * The file is copied into the content-addressed store beside images
 * (`<dataDir>/attachments/<sha256>.<ext>`). ffprobe reads its size, length,
 * frame rate and streams; ffmpeg takes a poster frame, which ImageMagick
 * marks with a play badge and which is stored as an ordinary image. The
 * result is that poster's ImageRef with `video` set, so clients that know
 * nothing of video still show a picture of it.
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { ImageRef, VideoMediaType, VideoRef } from "./messages";
import { attachmentsDir, putImageBytes, runMagick, sniffImage, storeImageFile, storedVideoPath } from "./attachments";

/** Largest video the attach tool copies. */
export const MAX_ATTACH_VIDEO_BYTES = 1024 * 1024 * 1024;
/** Posters are kept within this box: the viewer draws them until the video starts. */
const POSTER_MAX_DIMENSION = 1280;
const FFPROBE_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 60_000;

/**
 * The container a file's first bytes announce. Brands and doctypes decide,
 * never the file name. A GIF is a video only when it is animated.
 */
export function sniffVideoContainer(head: Uint8Array): VideoMediaType | null {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.length >= 12) {
    const box = bytes.toString("latin1", 4, 8);
    if (box === "ftyp") return bytes.toString("latin1", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
    // Older QuickTime files start with their movie or data atom.
    if (box === "moov" || box === "mdat" || box === "wide" || box === "free" || box === "skip") return "video/quicktime";
  }
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    return bytes.toString("latin1", 0, Math.min(bytes.length, 64)).includes("webm") ? "video/webm" : "video/x-matroska";
  }
  return null;
}

/** Frames in a GIF, counted up to `limit` by walking its blocks (no decoding). */
export function gifFrameCount(bytes: Uint8Array, limit = 2): number {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 13) return 0;
  let offset = 13;
  const flags = data[10];
  if (flags & 0x80) offset += 3 * (1 << ((flags & 0x07) + 1));
  const skipSubBlocks = () => {
    while (offset < data.length) {
      const size = data[offset++];
      if (size === 0) return true;
      offset += size;
    }
    return false;
  };
  let frames = 0;
  while (offset < data.length && frames < limit) {
    const introducer = data[offset++];
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      offset++;
      if (!skipSubBlocks()) break;
    } else if (introducer === 0x2c) {
      if (offset + 9 > data.length) break;
      const local = data[offset + 8];
      offset += 9;
      if (local & 0x80) offset += 3 * (1 << ((local & 0x07) + 1));
      offset++;
      if (!skipSubBlocks()) break;
      frames++;
    } else {
      break;
    }
  }
  return frames;
}

function readHead(path: string, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

async function run(command: string[], timeoutMs: number, what: string): Promise<Buffer> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(`${what} needs ${command[0]} (ffmpeg): ${error instanceof Error ? error.message : String(error)}`);
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${what} failed: ${stderr.trim().split("\n").at(-1) || `${command[0]} exited with code ${exitCode}`}`);
    return Buffer.from(stdout);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether ffprobe and ffmpeg can be started on this host. */
export function videoToolsAvailable(): boolean {
  return Boolean(Bun.which("ffprobe") && Bun.which("ffmpeg"));
}

export interface ProbedVideo {
  width: number;
  height: number;
  durationMs?: number;
  fps?: number;
  hasAudio: boolean;
  codec?: string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

function frameRate(value: string | undefined): number | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match || Number(match[2]) === 0) return undefined;
  const fps = Number(match[1]) / Number(match[2]);
  return fps > 0 && fps <= 1000 ? fps : undefined;
}

/** ffprobe's JSON for a file, as the fields a VideoRef keeps. */
export function parseProbe(json: string): ProbedVideo {
  const parsed = JSON.parse(json) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = parsed.streams ?? [];
  const video = streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video || !video.width || !video.height) throw new Error("it has no video stream");
  const rotation = Math.abs(Number(video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)) % 180;
  const [width, height] = rotation === 90 ? [video.height, video.width] : [video.width, video.height];
  const seconds = Number(parsed.format?.duration ?? video.duration);
  const fps = frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate);
  return {
    width,
    height,
    ...(Number.isFinite(seconds) && seconds > 0 ? { durationMs: Math.round(seconds * 1000) } : {}),
    ...(fps ? { fps: Math.round(fps * 100) / 100 } : {}),
    hasAudio: streams.some(stream => stream.codec_type === "audio"),
    ...(video.codec_name ? { codec: video.codec_name } : {}),
  };
}

export async function probeVideo(path: string): Promise<ProbedVideo> {
  const json = await run(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", path],
    FFPROBE_TIMEOUT_MS,
    "reading the video",
  );
  return parseProbe(json.toString("utf8"));
}

/** Where the poster comes from: a tenth of the way in, at most 3 s, so it is rarely a black fade-in. */
export function posterTimeSeconds(durationMs: number | undefined): number {
  if (durationMs === undefined) return 0;
  return Math.min(3, durationMs / 10000);
}

/** A play badge (a dark disc with a white triangle) for a poster of this size, as ImageMagick arguments. */
export function playBadgeArgs(width: number, height: number): string[] {
  const size = Math.round(Math.max(40, Math.min(160, Math.min(width, height) * 0.22)));
  const r = (size - 1) / 2;
  const point = (x: number, y: number) => `${(r + x * size).toFixed(1)},${(r + y * size).toFixed(1)}`;
  return [
    "(", "-size", `${size}x${size}`, "xc:none",
    "-fill", "rgba(0,0,0,0.55)", "-draw", `circle ${r},${r} ${r},0.5`,
    "-fill", "rgba(255,255,255,0.95)", "-draw", `polygon ${point(-0.15, -0.24)} ${point(-0.15, 0.24)} ${point(0.27, 0)}`,
    ")", "-gravity", "center", "-composite",
  ];
}

async function posterFrame(path: string, durationMs: number | undefined, transparent: boolean): Promise<Buffer> {
  const scale = `scale='min(${POSTER_MAX_DIMENSION},iw)':'min(${POSTER_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`;
  const frameAt = async (seconds: number) => run([
    "ffmpeg", "-v", "error", "-nostdin",
    ...(seconds > 0 ? ["-ss", seconds.toFixed(3)] : []),
    "-i", path, "-frames:v", "1", "-vf", scale, "-f", "image2pipe", "-c:v", "png", "-",
  ], FFMPEG_TIMEOUT_MS, "taking a poster frame");
  // A seek past the last frame (a very short clip) writes nothing: take the first.
  const at = posterTimeSeconds(durationMs);
  let frame = at > 0 ? await frameAt(at).catch(() => null) : null;
  if (!frame || !sniffImage(frame)) frame = await frameAt(0);
  const sniffed = sniffImage(frame);
  if (!sniffed) throw new Error("taking a poster frame failed: ffmpeg wrote no image");
  return runMagick([
    "png:-",
    ...playBadgeArgs(sniffed.width, sniffed.height),
    ...(transparent ? ["png:-"] : ["-background", "black", "-flatten", "-quality", "86", "jpeg:-"]),
  ], frame);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function copyIntoStore(source: string, id: string, mediaType: VideoMediaType): string {
  const path = storedVideoPath(id, mediaType);
  if (existsSync(path)) return path;
  mkdirSync(attachmentsDir(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    copyFileSync(source, temp);
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* never written */ }
    throw error;
  }
  return path;
}

/**
 * Copy one video into the store and describe it: the poster's ImageRef with
 * `video` set. Throws a short reason when it can't (too large, unreadable,
 * no video stream, no ffmpeg).
 */
export async function storeVideoFile(path: string, mediaType: VideoMediaType, name = basename(path)): Promise<ImageRef> {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size === 0) throw new Error("file is empty");
  if (stat.size > MAX_ATTACH_VIDEO_BYTES) {
    throw new Error(`video is ${(stat.size / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_ATTACH_VIDEO_BYTES / 1024 / 1024} MB`);
  }
  if (!videoToolsAvailable()) throw new Error("attaching videos needs ffmpeg and ffprobe on the daemon's host");
  const probed = await probeVideo(path);
  const id = await hashFile(path);
  const stored = copyIntoStore(path, id, mediaType);
  const poster = await posterFrame(stored, probed.durationMs, mediaType === "image/gif");
  const sniffed = sniffImage(poster);
  if (!sniffed) throw new Error("taking a poster frame failed");
  const posterId = putImageBytes(poster, sniffed.mediaType);
  const video: VideoRef = { id, mediaType, sizeBytes: stat.size, ...probed, path: stored };
  return {
    id: posterId,
    mediaType: sniffed.mediaType,
    width: sniffed.width,
    height: sniffed.height,
    sizeBytes: poster.length,
    ...(name ? { name: name.slice(0, 200) } : {}),
    video,
  };
}

/**
 * Store a file the attach tool was given: a video (or an animated GIF, when
 * ffmpeg is here to play it) as a video, anything else as an image.
 */
export async function storeAttachmentFile(path: string): Promise<ImageRef> {
  if (!statSync(path).isFile()) throw new Error("not a regular file");
  const head = readHead(path, 64);
  const container = sniffVideoContainer(head);
  if (container === "image/gif") {
    const stat = statSync(path);
    if (stat.size <= MAX_ATTACH_VIDEO_BYTES && videoToolsAvailable()) {
      const bytes = readHead(path, stat.size);
      if (gifFrameCount(bytes) > 1) return storeVideoFile(path, container);
    }
    return storeImageFile(path);
  }
  if (container) return storeVideoFile(path, container);
  try {
    return await storeImageFile(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("not a PNG")) {
      throw new Error("not an image (PNG, JPEG, GIF, WebP) or a video (MP4, MOV, WebM, MKV)");
    }
    throw error;
  }
}
