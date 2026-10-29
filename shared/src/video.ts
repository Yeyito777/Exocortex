/**
 * Video attachment helpers the daemon and clients share: how a duration and
 * a video's description read, and the commands of in-terminal playback
 * (docs/video-attachments.md).
 */

import type { VideoRef } from "./messages";

/** `0:07`, `12:34`, `1:02:03`; under a second, `0.4 s`. */
export function formatVideoDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264", hevc: "HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1", gif: "GIF", mpeg4: "MPEG-4", prores: "ProRes",
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** `0:12, 1920×1080, 30 fps, H.264 with sound, 3.4 MB`: what a model or a caption says about a video. */
export function describeVideo(video: VideoRef): string {
  const fps = video.fps && video.fps > 0 ? `${Math.round(video.fps * 100) / 100} fps` : null;
  const codec = video.codec ? CODEC_NAMES[video.codec] ?? video.codec : null;
  const sound = video.hasAudio ? "with sound" : "no sound";
  return [
    video.durationMs !== undefined ? formatVideoDuration(video.durationMs) : "unknown length",
    `${video.width}×${video.height}`,
    fps,
    codec ? `${codec} ${sound}` : sound,
    formatBytes(video.sizeBytes),
  ].filter(Boolean).join(", ");
}

/** A playback's link to the terminal: st-play's flow control starts from it. */
export type VideoPlaybackLink = "local" | "remote";

/** What a client may ask of a playing video (video_control). */
export type VideoControlAction = "pause" | "resume" | "toggle" | "seek" | "skip" | "size" | "volume" | "mute";
