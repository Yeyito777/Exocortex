/**
 * Where attached videos play, decided every frame (docs/video-attachments.md):
 *
 * - The viewer opened on a video plays it (once per opening: after a stop or
 *   an error, space plays it again). An inline playback of the same video
 *   carries on from where it was.
 * - Inline playback (space on a thumbnail) lasts while its thumbnail has a
 *   row on screen, in the conversation it started in, with no viewer open.
 * - Keys: in the viewer space, ←/→ (h/l) ±5 s, ↓/↑ ∓60 s, 0-9 jump to that
 *   tenth, m mute, o open the file in a player; in history, on a video's
 *   thumbnail, space plays/pauses inline, < > seek 5 s, x stops.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import type { ImageModalState } from "./imagemodal";
import type { HistoryVideoCaption } from "./historyimages";
import type { KittyImageData } from "./kittyimages";
import { inlineVideoPlayable, type CellSize, type InlineImageLayout, type InlineImageTarget } from "./inlineimages";
import {
  activeVideo,
  seekVideo,
  skipVideo,
  startVideo,
  stopVideo,
  toggleVideo,
  toggleVideoMute,
  resizeVideo,
  videoCaptionText,
  videoFor,
  videoPositionMs,
  type ActiveVideo,
} from "./videoplayer";
import type { VideoPlaybackLink } from "@exocortex/shared/video";
import { activeHistorySurface } from "./historysurface";
import { imageHitAt } from "./inlineimages";
import { termWidth } from "./textwidth";

/** The terminal is across a network link from the daemon's st-play (or from this TUI). */
export function videoLink(state: Pick<RenderState, "sshRemote">, env: NodeJS.ProcessEnv = process.env): VideoPlaybackLink {
  return state.sshRemote || env.SSH_TTY || env.SSH_CONNECTION ? "remote" : "local";
}

function sameThumbnail(video: ActiveVideo, layout: InlineImageLayout): boolean {
  return layout.source.video?.id === video.videoId
    && (!video.target || (layout.owner === video.target.owner && layout.index === video.target.index));
}

/** The playing video placed over this thumbnail instead of its poster, if it plays inline here. */
export function inlineVideoImage(layout: InlineImageLayout): KittyImageData | null {
  const video = activeVideo();
  if (!video || video.place !== "inline" || !video.image) return null;
  return sameThumbnail(video, layout) ? video.image : null;
}

/** The viewer index each opening has auto-played: it never starts again by itself. */
const viewerStarted = new WeakMap<ImageModalState, number>();

function playInViewer(state: RenderState, modal: ImageModalState, pixels: { width: number; height: number }): void {
  const source = modal.images[modal.index];
  const current = activeVideo();
  viewerStarted.set(modal, modal.index);
  const startMs = current && current.videoId === source.video?.id && current.state !== "ended" ? videoPositionMs(current) : 0;
  startVideo(source, { place: "viewer", convId: state.convId, width: pixels.width, height: pixels.height, link: videoLink(state), startMs });
}

export interface VideoFrame {
  /** The viewer's image box in pixels, when it is open. */
  modalPixels: { width: number; height: number } | null;
  /** Thumbnails with a row on screen this frame. */
  visible: readonly InlineImageLayout[];
  cell: CellSize;
}

/** Start, move or stop playback to match what the screen shows. */
export function reconcileVideoPlayback(state: RenderState, frame: VideoFrame): void {
  const video = activeVideo();
  const modal = state.imageModal;
  const source = modal ? modal.images[modal.index] : null;
  if (modal && source?.video && frame.modalPixels && inlineVideoPlayable()) {
    if (video?.place === "viewer" && video.videoId === source.video.id) {
      resizeVideo(frame.modalPixels.width, frame.modalPixels.height);
    } else if (viewerStarted.get(modal) !== modal.index) {
      playInViewer(state, modal, frame.modalPixels);
    } else if (video) {
      stopVideo();
    }
    return;
  }
  if (!video) return;
  if (video.place === "viewer" || modal || video.convId !== state.convId) {
    stopVideo();
    return;
  }
  // A history reload makes new thumbnails for the same message: follow the video.
  const layout = frame.visible.find(item => sameThumbnail(video, item))
    ?? frame.visible.find(item => item.source.video?.id === video.videoId);
  if (!layout) {
    stopVideo();
    return;
  }
  video.target = { owner: layout.owner, index: layout.index };
  resizeVideo(layout.cols * frame.cell.width, layout.rows * frame.cell.height);
}

export interface VideoCaptionWrite {
  row: number;
  col: number;
  /** Exactly the caption's width, styled. */
  text: string;
}

/** Live status for the caption row of the thumbnail playing inline (or the one whose playback failed). */
export function videoCaptionWrites(captions: readonly HistoryVideoCaption[], theme: { text: string; warning: string; reset: string }): VideoCaptionWrite[] {
  const writes: VideoCaptionWrite[] = [];
  for (const caption of captions) {
    const ref = caption.layout.source.video;
    const video = ref ? videoFor(ref.id) : null;
    if (!video || video.place !== "inline" || (video.target && !sameThumbnail(video, caption.layout))) continue;
    const line = videoCaptionText(caption.layout.source, video, inlineVideoPlayable(), caption.width, termWidth, "inline");
    const color = video.state === "error" ? theme.warning : theme.text;
    writes.push({ row: caption.row, col: caption.col, text: `${color}${line}${" ".repeat(Math.max(0, caption.width - termWidth(line)))}${theme.reset}` });
  }
  return writes;
}

// ── Keys ────────────────────────────────────────────────────────────

function char(key: Readonly<KeyEvent>): string | undefined {
  return key.type === "char" ? key.char : undefined;
}

/**
 * Keys for the video the viewer shows. Returns false for keys it leaves to
 * the viewer (paging, closing). `openFile` opens the stored file in a player.
 */
export function handleVideoModalKey(key: Readonly<KeyEvent>, state: RenderState, openFile: (path: string) => void): boolean {
  const modal = state.imageModal;
  const source = modal?.images[modal.index];
  const ref = source?.video;
  if (!modal || !source || !ref) return false;
  const video = activeVideo();
  const playing = video?.place === "viewer" && video.videoId === ref.id ? video : null;
  const c = char(key);
  if (c === "o") {
    stopVideo();
    openFile(ref.path);
    return true;
  }
  if (c === " " || c === "p") {
    if (playing) toggleVideo();
    else if (inlineVideoPlayable()) viewerStarted.delete(modal);
    return true;
  }
  if (!playing) return false;
  if (c === "m") toggleVideoMute();
  else if (key.type === "left" || c === "h") skipVideo(-5_000);
  else if (key.type === "right" || c === "l") skipVideo(5_000);
  else if (key.type === "down") skipVideo(-60_000);
  else if (key.type === "up") skipVideo(60_000);
  else if (c !== undefined && /^[0-9]$/.test(c) && ref.durationMs) seekVideo(ref.durationMs * Number(c) / 10);
  else return false;
  return true;
}

/** The video thumbnail under the history cursor, with the layout it is drawn by. */
function videoAtHistoryCursor(state: RenderState): { layout: InlineImageLayout; target: InlineImageTarget } | null {
  const surface = activeHistorySurface(state);
  const hit = imageHitAt(surface.lineAnchors[surface.cursor.row]?.openImages, surface.cursor.col);
  if (!hit?.layout?.source.video) return null;
  return { layout: hit.layout, target: hit.target };
}

export type VideoHistoryKeyResult = { type: "handled" } | { type: "open_viewer"; target: InlineImageTarget } | null;

/** Space, x, < and > on a video thumbnail in history (normal mode); null for every other key. */
export function handleVideoHistoryKey(key: Readonly<KeyEvent>, state: RenderState, cell: CellSize): VideoHistoryKeyResult {
  const c = char(key);
  if (c !== " " && c !== "x" && c !== "<" && c !== ">") return null;
  const vim = state.vim;
  if (vim.mode !== "normal" || vim.pendingOperator || vim.pendingKeys || vim.pendingFind || vim.pendingTextObjectModifier) return null;
  const found = videoAtHistoryCursor(state);
  if (!found) return null;
  const video = activeVideo();
  const here = video?.place === "inline" && sameThumbnail(video, found.layout) ? video : null;
  if (c === " ") {
    if (here) toggleVideo();
    else if (!inlineVideoPlayable()) return { type: "open_viewer", target: found.target };
    else {
      startVideo(found.layout.source, {
        place: "inline", target: { owner: found.layout.owner, index: found.layout.index }, convId: state.convId,
        width: found.layout.cols * cell.width, height: found.layout.rows * cell.height, link: videoLink(state),
      });
    }
    return { type: "handled" };
  }
  if (!here) return null;
  if (c === "x") stopVideo();
  else skipVideo(c === "<" ? -5_000 : 5_000);
  return { type: "handled" };
}
