/**
 * Attached videos playing in this terminal (docs/video-attachments.md).
 *
 * One video plays at a time, either inline in its history thumbnail or in
 * the viewer. The daemon runs `st-play --pipe` for it (video_play); this
 * module writes the APCs it sends (`video_output`) to the terminal as they
 * come, relays the terminal's replies about the video's image id back
 * (`video_input`, the acknowledgements st-play's flow control runs on), and
 * reads position and state from those replies for the status line. The
 * renderer places the video like any image once its open has been written
 * (`videoImageFor`), so it scrolls, crops and hides with history; deleting
 * the image stops the sound at once.
 */

import type { Command, Event } from "./protocol";
import type { InlineImageSource } from "./inlineimages";
import type { KittyImageData } from "./kittyimages";
import { deleteImage } from "./kittyimages";
import { parseKittyGraphicsResponse } from "./terminalgraphics";
import { formatVideoDuration } from "@exocortex/shared/video";
import type { VideoPlaybackLink } from "@exocortex/shared/video";

export type VideoPlace = "inline" | "viewer";
export type VideoState = "starting" | "buffering" | "playing" | "paused" | "ended" | "error";

/** Which rendered thumbnail plays inline: its owner and index (as placements count them). */
export interface VideoTarget {
  owner: object;
  index: number;
}

export interface ActiveVideo {
  playbackId: string;
  source: InlineImageSource;
  videoId: string;
  kittyId: number;
  place: VideoPlace;
  target: VideoTarget | null;
  convId: string | null;
  /** The placement's pixels, as last told to st-play. */
  size: { width: number; height: number };
  /** Set once the open has been written: what placements use. */
  image: KittyImageData | null;
  state: VideoState;
  posMs: number;
  posAt: number;
  muted: boolean;
  sent: { kbps: number; width: number; height: number; copy: boolean } | null;
  error: string | null;
}

export interface VideoPlayerHost {
  send(command: Command): void;
  /** Bytes for the terminal, written before anything else that follows. */
  write(data: string): void;
  /** Something the status line or placements show changed. */
  changed(): void;
  now?: () => number;
}

const FIRST_KITTY_ID = 0x10000000;
const LAST_KITTY_ID = 0x1fffffff;

let host: VideoPlayerHost | null = null;
let active: ActiveVideo | null = null;
/** A playback that failed or ended by itself, kept for its message until the next start. */
let finished: ActiveVideo | null = null;
let nextKittyId = FIRST_KITTY_ID;
let playbackCounter = 0;

export function configureVideoPlayer(options: VideoPlayerHost): void {
  host = options;
}

const now = () => host?.now?.() ?? Date.now();

export function activeVideo(): ActiveVideo | null {
  return active;
}

/** The playback a thumbnail or the viewer shows status for: the running one, or the last one that failed. */
export function videoFor(videoId: string): ActiveVideo | null {
  if (active?.videoId === videoId) return active;
  return finished?.videoId === videoId ? finished : null;
}

function base64Text(data: string): string {
  try {
    return Buffer.from(data, "base64").toString("latin1");
  } catch {
    return "";
  }
}

/** The display size in an open (`k=o`) for this video's image id, if `data` carries one. */
export function openSizeIn(data: string, kittyId: number): { width: number; height: number } | null {
  const pattern = new RegExp(`\\x1b_Ga=v,i=${kittyId},k=o[^;\\x1b]*;([A-Za-z0-9+/=]*)\\x1b\\\\`);
  const match = pattern.exec(data);
  if (!match) return null;
  const text = base64Text(match[1]);
  const width = Number(/(?:^|\s)width=(\d+)/.exec(text)?.[1]);
  const height = Number(/(?:^|\s)height=(\d+)/.exec(text)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

const STATES: Record<string, VideoState> = { buffering: "buffering", playing: "playing", paused: "paused", ended: "ended" };

/** A k=q status reply's state and position (µs → ms). */
export function parseVideoStatusReply(message: string): { state?: VideoState; posMs?: number } {
  const state = STATES[/(?:^|\s)state=(\w+)/.exec(message)?.[1] ?? ""];
  const pos = Number(/(?:^|\s)pos=(-?\d+)/.exec(message)?.[1]);
  return { ...(state ? { state } : {}), ...(Number.isFinite(pos) && pos >= 0 ? { posMs: Math.round(pos / 1000) } : {}) };
}

/** Where playback is now, by the last report and the clock. */
export function videoPositionMs(video: ActiveVideo): number {
  const duration = video.source.video?.durationMs;
  const pos = video.state === "playing" ? video.posMs + (now() - video.posAt) : video.posMs;
  return duration !== undefined ? Math.min(duration, Math.max(0, pos)) : Math.max(0, pos);
}

export interface StartVideoOptions {
  place: VideoPlace;
  target?: VideoTarget | null;
  convId: string | null;
  width: number;
  height: number;
  link: VideoPlaybackLink;
  startMs?: number;
}

/** Play `source` (which must carry a video); stops whatever was playing. */
export function startVideo(source: InlineImageSource, options: StartVideoOptions): ActiveVideo | null {
  const video = source.video;
  if (!host || !video) return null;
  stopVideo();
  finished = null;
  const kittyId = nextKittyId;
  nextKittyId = nextKittyId >= LAST_KITTY_ID ? FIRST_KITTY_ID : nextKittyId + 1;
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const startMs = options.startMs && video.durationMs && options.startMs < video.durationMs - 500 ? Math.round(options.startMs) : 0;
  active = {
    playbackId: `v${(++playbackCounter).toString(36)}${now().toString(36)}`,
    source,
    videoId: video.id,
    kittyId,
    place: options.place,
    target: options.place === "inline" ? options.target ?? null : null,
    convId: options.convId,
    size: { width, height },
    image: null,
    state: "starting",
    posMs: startMs,
    posAt: now(),
    muted: false,
    sent: null,
    error: null,
  };
  host.send({
    type: "video_play", playbackId: active.playbackId, videoId: video.id, kittyId,
    width, height, link: options.link, ...(startMs ? { startMs } : {}),
  });
  host.changed();
  return active;
}

/** Stop playing: the image (and its sound) goes at once, the sender after. */
export function stopVideo(): void {
  if (!active) return;
  const stopping = active;
  active = null;
  host?.send({ type: "video_stop", playbackId: stopping.playbackId });
  host?.write(deleteImage(stopping.kittyId));
  host?.changed();
}

/** Forget everything without telling the daemon (it went away): just clear the terminal. */
export function resetVideoPlayer(): void {
  if (active) host?.write(deleteImage(active.kittyId));
  active = null;
  finished = null;
  host?.changed();
}

function control(command: Omit<Extract<Command, { type: "video_control" }>, "type" | "playbackId">): void {
  if (!active || !host) return;
  host.send({ type: "video_control", playbackId: active.playbackId, ...command });
}

export function toggleVideo(): void {
  if (!active) return;
  const pos = videoPositionMs(active);
  if (active.state === "ended") {
    active.posMs = 0;
    active.state = "buffering";
  } else {
    active.posMs = pos;
    active.state = active.state === "paused" ? "buffering" : "paused";
  }
  active.posAt = now();
  control({ action: "toggle" });
  host?.changed();
}

export function seekVideo(ms: number): void {
  if (!active) return;
  const duration = active.source.video?.durationMs;
  const target = Math.max(0, duration !== undefined ? Math.min(duration - 500, ms) : ms);
  active.posMs = target;
  active.posAt = now();
  if (active.state !== "paused") active.state = "buffering";
  control({ action: "seek", value: target / 1000 });
  host?.changed();
}

export function skipVideo(deltaMs: number): void {
  if (active) seekVideo(videoPositionMs(active) + deltaMs);
}

export function toggleVideoMute(): void {
  if (!active) return;
  active.muted = !active.muted;
  control({ action: "mute", value: active.muted ? 1 : 0 });
  host?.changed();
}

/** The placement changed size: st-play sends a resolution that fits it. */
export function resizeVideo(width: number, height: number): void {
  if (!active) return;
  const size = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  if (size.width === active.size.width && size.height === active.size.height) return;
  active.size = size;
  control({ action: "size", width: size.width, height: size.height });
}

/** The image placements use for `videoId` while it plays, once its open is in the terminal. */
export function videoImageFor(videoId: string, place: VideoPlace): KittyImageData | null {
  return active?.videoId === videoId && active.place === place ? active.image : null;
}

/** Daemon events about playbacks. Returns true when the event was one. */
export function handleVideoEvent(event: Event): boolean {
  if (event.type !== "video_output" && event.type !== "video_status" && event.type !== "video_ended") return false;
  const current = active?.playbackId === event.playbackId ? active : null;
  if (!current) return true;
  if (event.type === "video_output") {
    if (typeof event.data !== "string" || !event.data) return true;
    host?.write(event.data);
    if (!current.image) {
      const size = openSizeIn(event.data, current.kittyId);
      if (size) {
        current.image = { kittyId: current.kittyId, base64: "", pixelWidth: size.width, pixelHeight: size.height, external: true };
        host?.changed();
      }
    }
    return true;
  }
  if (event.type === "video_status") {
    current.sent = { kbps: event.kbps, width: event.width, height: event.height, copy: event.copy };
    host?.changed();
    return true;
  }
  host?.write(deleteImage(current.kittyId));
  active = null;
  if (event.reason === "error") finished = { ...current, state: "error", error: event.message ?? "playback failed", image: null };
  host?.changed();
  return true;
}

/**
 * A terminal reply. Those about the playing video go to its sender, and
 * their state and position update the status line. Returns true when it was one.
 */
export function handleVideoTerminalReply(sequence: string): boolean {
  if (!active) return false;
  const reply = parseKittyGraphicsResponse(sequence);
  if (!reply || reply.imageId !== active.kittyId) return false;
  host?.send({ type: "video_input", playbackId: active.playbackId, data: sequence });
  const status = parseVideoStatusReply(reply.message);
  if (status.state || status.posMs !== undefined) {
    const before = videoStatusSignature(active);
    if (status.state) active.state = status.state;
    if (status.posMs !== undefined) {
      active.posMs = status.posMs;
      active.posAt = now();
    }
    if (videoStatusSignature(active) !== before) host?.changed();
  }
  return true;
}

function videoStatusSignature(video: ActiveVideo): string {
  return `${video.state}:${Math.floor(videoPositionMs(video) / 1000)}`;
}

// ── Status lines ────────────────────────────────────────────────────

function icon(video: ActiveVideo | null): string {
  switch (video?.state) {
    case "playing": return "▶";
    case "paused": return "⏸";
    case "ended": return "↻";
    case "error": return "⚠";
    case "starting":
    case "buffering": return "…";
    default: return "▶";
  }
}

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "━".repeat(filled) + "─".repeat(Math.max(0, width - filled));
}

function fitParts(parts: readonly string[], width: number, widthOf: (text: string) => number): string {
  // Drop optional parts from the right until it fits; the first always stays.
  for (let count = parts.length; count > 1; count--) {
    const line = parts.slice(0, count).filter(Boolean).join("  ");
    if (widthOf(line) <= width) return line;
  }
  return parts[0];
}

/**
 * What a thumbnail's caption row says: its length and how to play it when
 * idle; time, progress, bitrate and keys while it plays.
 */
export function videoCaptionText(
  source: InlineImageSource,
  video: ActiveVideo | null,
  canPlay: boolean,
  width: number,
  widthOf: (text: string) => number,
  place: VideoPlace = "inline",
): string {
  const ref = source.video;
  if (!ref) return "";
  const duration = ref.durationMs !== undefined ? formatVideoDuration(ref.durationMs) : "--:--";
  if (!video) {
    if (!canPlay) return fitParts([`▶ ${duration} video · o opens it in a player`, "this terminal can't play it inline"], width, widthOf);
    return fitParts([`▶ ${duration}`, place === "viewer" ? "space plays" : "space plays here · enter plays big"], width, widthOf);
  }
  if (video.state === "error") return fitParts([`⚠ ${video.error ?? "playback failed"}`], width, widthOf);
  const position = formatVideoDuration(videoPositionMs(video));
  const time = `${icon(video)} ${position} / ${duration}`;
  const sent = video.sent && video.sent.width > 0
    ? `${video.sent.copy ? "original" : `${(video.sent.kbps / 1000).toFixed(1)} Mb/s`} ${video.sent.width}×${video.sent.height}`
    : "";
  const state = video.state === "buffering" || video.state === "starting" ? "buffering" : video.muted ? "muted" : "";
  const keys = place === "viewer"
    ? "space ⏯  ←/→ 5s  0-9 jump  m mute  o open  q close"
    : "space ⏯  < > seek  x stop  enter big";
  const fraction = ref.durationMs ? videoPositionMs(video) / ref.durationMs : 0;
  // Keep what fits beside a bar of at least 6 cells (details go first), then let the bar fill the rest.
  const kept = [state, keys, sent].filter(Boolean);
  const used = () => widthOf([time, ...kept].join("  ")) + 2;
  while (kept.length > 0 && used() + 6 > width) kept.pop();
  const barWidth = Math.min(40, width - used());
  return [time, barWidth >= 3 ? bar(fraction, barWidth) : "", ...kept].filter(Boolean).join("  ");
}

export const videoPlayerInternalsForTest = {
  reset(): void {
    host = null;
    active = null;
    finished = null;
    nextKittyId = FIRST_KITTY_ID;
    playbackCounter = 0;
  },
};
