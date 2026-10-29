import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, focusHistory, type RenderState } from "./state";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageCellSize, setInlineImageMode, setInlineVideoSupport } from "./inlineimages";
import { handleImageModalKey } from "./imagemodal";
import { handleFocusedKey } from "./focus";
import { stripAnsi } from "./historycursor";
import type { Command } from "./protocol";
import type { VideoRef } from "./messages";
import {
  activeVideo,
  configureVideoPlayer,
  handleVideoEvent,
  handleVideoTerminalReply,
  openSizeIn,
  parseVideoStatusReply,
  videoCaptionText,
  videoPlayerInternalsForTest,
} from "./videoplayer";
import { handleVideoHistoryKey, handleVideoModalKey, videoLink } from "./videoview";
import { KittyImageSync } from "./kittyimages";
import { termWidth } from "./textwidth";

const video: VideoRef = {
  id: "f".repeat(64), mediaType: "video/mp4", sizeBytes: 3_400_000, durationMs: 12_000,
  width: 400, height: 200, fps: 30, hasAudio: true, codec: "h264", path: "/data/attachments/fff.mp4",
};
const poster = { id: "e".repeat(64), mediaType: "image/jpeg" as const, width: 400, height: 200, sizeBytes: 5000, name: "clip.mp4", video };

function capture(state: RenderState): string {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  return out;
}

const placements = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)H\x1b_G(a=p[^;]*);/g)].map(match => ({ row: Number(match[1]), col: Number(match[2]), controls: match[3] }));

function videoState(): RenderState {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 40;
  state.convId = "conv";
  state.messages = [
    { role: "user", text: "make a clip\nwith sound", metadata: null },
    {
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: ["clip.mp4"] }, summary: "clip.mp4" },
        { type: "tool_result", toolCallId: "c1", toolName: "attach", output: "Attached 1 video", isError: false, images: [poster] },
        { type: "text", text: "Here is the clip." },
      ],
      metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
    },
    ...Array.from({ length: 60 }, (_, i) => ({ role: "system" as const, text: `filler ${i}`, metadata: null })),
  ];
  return state;
}

const pngFetch = async (request: { width: number; height: number; format: string }) => request.format === "png"
  ? { format: "png" as const, width: Math.min(400, request.width), height: Math.min(200, Math.round(Math.min(400, request.width) / 2)), base64: "UE5H" }
  : { format: "rgba" as const, width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") };

let sent: Command[] = [];
let written = "";
const savedSsh = { tty: process.env.SSH_TTY, connection: process.env.SSH_CONNECTION };

beforeEach(() => {
  inlineImagesInternalsForTest.reset();
  videoPlayerInternalsForTest.reset();
  sent = [];
  written = "";
  configureVideoPlayer({ send: command => { sent.push(command); }, write: data => { written += data; }, changed: () => {} });
  configureInlineImages({ fetch: pngFetch, onChange: () => {} });
  setInlineImageCellSize({ width: 8, height: 16 });
  delete process.env.SSH_TTY;
  delete process.env.SSH_CONNECTION;
});

afterEach(() => {
  inlineImagesInternalsForTest.reset();
  videoPlayerInternalsForTest.reset();
  if (savedSsh.tty !== undefined) process.env.SSH_TTY = savedSsh.tty;
  if (savedSsh.connection !== undefined) process.env.SSH_CONNECTION = savedSsh.connection;
});

/** Scroll so the thumbnail's top sits on viewport row 5, and put the history cursor on it. */
async function showVideo(state: RenderState): Promise<number> {
  capture(state);
  const first = state.historyLineAnchors.findIndex(anchor => anchor.images?.length);
  state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - first + 5;
  capture(state);
  await Bun.sleep(0);
  capture(state);
  focusHistory(state);
  state.historyCursor = { row: first + 2, col: 4 };
  return first;
}

const openApc = (kittyId: number) => `\x1b_Ga=v,i=${kittyId},k=o,q=1;${btoa("video=h264 width=400 height=200 audio=aac rate=48000 channels=2 prebuffer=300 volume=1.000 pause=0")}\x1b\\`;
const lastOf = <T extends Command["type"]>(type: T) => sent.filter(command => command.type === type).at(-1) as Extract<Command, { type: T }> | undefined;

describe("video thumbnails in history", () => {
  test("a poster with a caption row: its length and how to play it", async () => {
    setInlineImageMode("kitty");
    setInlineVideoSupport("yes");
    const state = videoState();
    const first = await showVideo(state);
    const anchors = state.historyLineAnchors;
    const captionRow = anchors.findIndex(anchor => anchor.videoCaptions);
    // 12 poster rows, then the caption.
    expect(captionRow).toBe(first + 12);
    expect(anchors[captionRow].images).toEqual([]);
    expect(stripAnsi(state.historyLines[captionRow]).trim()).toBe("▶ 0:12  space plays here · enter plays big");
    // A yank of the poster copies what it is.
    expect(state.historyCopyLines?.[first]?.text).toBe("[video: clip.mp4 · 0:12 · 400×200 · 3.2 MB]");
  });

  test("space plays it inline; the video replaces the poster; scrolling away stops it", async () => {
    setInlineImageMode("kitty");
    setInlineVideoSupport("yes");
    const state = videoState();
    await showVideo(state);
    const posterPlacement = placements(capture(state)).find(placement => placement.controls.includes("c=48,r=12"));
    expect(posterPlacement).toBeDefined();

    expect(handleVideoHistoryKey({ type: "char", char: " " }, state, { width: 8, height: 16 })).toEqual({ type: "handled" });
    const play = lastOf("video_play")!;
    expect(play).toMatchObject({ videoId: video.id, width: 48 * 8, height: 12 * 16, link: "local" });
    expect(play.kittyId).toBeGreaterThanOrEqual(0x10000000);
    expect(activeVideo()?.place).toBe("inline");

    // Until the open is written, the poster stays.
    expect(placements(capture(state)).some(placement => placement.controls.includes(`i=${play.kittyId},`))).toBe(false);
    expect(handleVideoEvent({ type: "video_output", playbackId: play.playbackId, data: openApc(play.kittyId) })).toBe(true);
    expect(written).toBe(openApc(play.kittyId));
    const playing = capture(state);
    const videoPlacement = placements(playing).find(placement => placement.controls.includes(`i=${play.kittyId},`));
    expect(videoPlacement).toMatchObject({ row: posterPlacement!.row, col: posterPlacement!.col });
    expect(videoPlacement!.controls).toContain("c=48,r=12,");
    expect(videoPlacement!.controls).toEndWith("q=2");

    // The terminal's replies go back to the sender and drive the caption.
    const reply = `\x1b_Gi=${play.kittyId};OK seq=4 state=playing pos=3200000 vbuf=5000000 abuf=5000000 shown=90 dropped=0 rx=1000\x1b\\`;
    expect(handleVideoTerminalReply(reply)).toBe(true);
    expect(lastOf("video_input")).toEqual({ type: "video_input", playbackId: play.playbackId, data: reply });
    expect(handleVideoTerminalReply(`\x1b_Gi=42;OK\x1b\\`)).toBe(false);
    handleVideoEvent({ type: "video_status", playbackId: play.playbackId, kbps: 1200, width: 384, height: 192, copy: false, rateKbps: 3000, rttMs: 100 });
    const caption = stripAnsi(capture(state));
    expect(caption).toMatch(/▶ 0:03 \/ 0:12\s+━+─+\s+space pause  < > seek  x stop  enter big  1\.2 Mb\/s 384×192/);

    // Keys on the thumbnail: seek, pause.
    handleVideoHistoryKey({ type: "char", char: ">" }, state, { width: 8, height: 16 });
    expect(lastOf("video_control")).toMatchObject({ action: "seek" });
    expect((lastOf("video_control")!.value ?? 0)).toBeGreaterThanOrEqual(8.2);
    handleVideoHistoryKey({ type: "char", char: " " }, state, { width: 8, height: 16 });
    expect(lastOf("video_control")).toMatchObject({ action: "toggle" });

    // Scrolled away: stopped, and the terminal drops it at once.
    state.scrollOffset = 0;
    capture(state);
    expect(lastOf("video_stop")).toEqual({ type: "video_stop", playbackId: play.playbackId });
    expect(written).toEndWith(`\x1b_Ga=d,d=I,i=${play.kittyId},q=2;\x1b\\`);
    expect(activeVideo()).toBeNull();
    // Late output from the old playback is dropped.
    const before = written;
    handleVideoEvent({ type: "video_output", playbackId: play.playbackId, data: openApc(play.kittyId) });
    expect(written).toBe(before);
  });

  test("Enter moves it to the viewer, which carries on; closing the viewer stops it", async () => {
    setInlineImageMode("kitty");
    setInlineVideoSupport("yes");
    const state = videoState();
    await showVideo(state);
    handleVideoHistoryKey({ type: "char", char: " " }, state, { width: 8, height: 16 });
    const inline = lastOf("video_play")!;
    handleVideoTerminalReply(`\x1b_Gi=${inline.kittyId};OK seq=1 state=playing pos=4000000\x1b\\`);

    const result = handleFocusedKey({ type: "enter" }, state);
    expect(result.type).toBe("open_image");
    if (result.type !== "open_image") throw new Error("not opened");
    state.imageModal = { images: result.target.images, index: result.target.index };
    const opening = capture(state);
    const viewer = lastOf("video_play")!;
    expect(viewer.playbackId).not.toBe(inline.playbackId);
    expect(viewer.startMs).toBeGreaterThanOrEqual(4000);
    expect(lastOf("video_stop")?.playbackId).toBe(inline.playbackId);
    expect(activeVideo()?.place).toBe("viewer");
    handleVideoEvent({ type: "video_output", playbackId: viewer.playbackId, data: openApc(viewer.kittyId) });
    const open = capture(state);
    const shown = placements(opening + open);
    // The poster under (z=2), the video above it (z=3), the same box.
    const posterInViewer = shown.find(placement => placement.controls.includes(",z=2,"));
    const videoInViewer = shown.find(placement => placement.controls.includes(`i=${viewer.kittyId},`));
    expect(videoInViewer!.controls).toContain(",z=3,");
    expect(videoInViewer).toMatchObject({ row: posterInViewer!.row, col: posterInViewer!.col });
    expect(stripAnsi(opening)).toContain("clip.mp4 · 0:12 · 400×200 · 3.2 MB");
    // Narrow: the buffering mark (…) and the short key list.
    expect(stripAnsi(open)).toMatch(/… 0:04 \/ 0:12\s+━*─+\s+space pause  ←\/→  q close/);

    // Viewer keys.
    expect(handleVideoModalKey({ type: "right" }, state, () => {})).toBe(true);
    expect(lastOf("video_control")).toMatchObject({ action: "seek" });
    expect(handleVideoModalKey({ type: "char", char: "5" }, state, () => {})).toBe(true);
    expect(lastOf("video_control")).toEqual({ type: "video_control", playbackId: viewer.playbackId, action: "seek", value: 6 });
    expect(handleVideoModalKey({ type: "char", char: "m" }, state, () => {})).toBe(true);
    expect(lastOf("video_control")).toMatchObject({ action: "mute", value: 1 });
    // j/k still page; Esc closes.
    expect(handleVideoModalKey({ type: "char", char: "j" }, state, () => {})).toBe(false);
    expect(handleImageModalKey({ type: "escape" }, state.imageModal!)).toBe("close");
    state.imageModal = null;
    capture(state);
    expect(lastOf("video_stop")?.playbackId).toBe(viewer.playbackId);
    expect(activeVideo()).toBeNull();
  });

  test("a failed playback says why and does not restart by itself", async () => {
    setInlineImageMode("kitty");
    setInlineVideoSupport("yes");
    const state = videoState();
    await showVideo(state);
    state.imageModal = { images: [{ imageId: poster.id, width: 400, height: 200, mediaType: "image/jpeg", sizeBytes: 5000, name: "clip.mp4", video }], index: 0 };
    capture(state);
    const play = lastOf("video_play")!;
    handleVideoEvent({ type: "video_ended", playbackId: play.playbackId, reason: "error", message: "st-play is too old to play in Exocortex (no --pipe): update st" });
    const out = stripAnsi(capture(state));
    expect(out).toContain("⚠ st-play is too old");
    expect(sent.filter(command => command.type === "video_play")).toHaveLength(1);
    // Space asks again.
    handleVideoModalKey({ type: "char", char: " " }, state, () => {});
    capture(state);
    expect(sent.filter(command => command.type === "video_play")).toHaveLength(2);
  });

  test("without st's video: the caption says how to open it, and the viewer offers the file", async () => {
    setInlineImageMode("kitty");
    setInlineVideoSupport("no");
    const state = videoState();
    await showVideo(state);
    const captionRow = state.historyLineAnchors.findIndex(anchor => anchor.videoCaptions);
    expect(stripAnsi(state.historyLines[captionRow]).trim()).toBe("▶ 0:12 video  enter for details");
    const result = handleVideoHistoryKey({ type: "char", char: " " }, state, { width: 8, height: 16 });
    if (result?.type !== "open_viewer") throw new Error(`expected open_viewer, got ${JSON.stringify(result)}`);
    state.imageModal = { images: result.target.images, index: result.target.index };
    const out = stripAnsi(capture(state));
    expect(out).toContain("▶ 0:12 video · o opens it in a player");
    expect(sent).toEqual([]);
    const opened: string[] = [];
    expect(handleVideoModalKey({ type: "char", char: "o" }, state, path => opened.push(path))).toBe(true);
    expect(opened).toEqual([video.path]);
  });

  test("the half-block fallback draws the poster and the caption, and never asks to play", async () => {
    setInlineImageMode("halfblock");
    setInlineVideoSupport("no");
    const state = videoState();
    await showVideo(state);
    const captionRow = state.historyLineAnchors.findIndex(anchor => anchor.videoCaptions);
    expect(stripAnsi(state.historyLines[captionRow - 1])).toContain("▀");
    expect(stripAnsi(state.historyLines[captionRow]).trim()).toStartWith("▶ 0:12 video");
    expect(sent).toEqual([]);
  });
});

function activeVideoStub(source: Parameters<typeof videoCaptionText>[0]) {
  return {
    playbackId: "p", source, videoId: video.id, kittyId: 1, place: "viewer" as const, target: null, convId: null,
    size: { width: 1, height: 1 }, image: null, state: "playing" as const, posMs: 3000, posAt: Date.now(), muted: false,
    sent: { kbps: 1200, width: 960, height: 540, copy: false }, error: null,
  };
}

describe("player pieces", () => {
  test("the open's display size and the status replies", () => {
    expect(openSizeIn(`junk${openApc(77)}`, 77)).toEqual({ width: 400, height: 200 });
    expect(openSizeIn(openApc(77), 78)).toBeNull();
    expect(parseVideoStatusReply("OK seq=3 state=paused pos=1500000")).toEqual({ state: "paused", posMs: 1500 });
    expect(parseVideoStatusReply("OK seq=3 state=buffering pos=-1")).toEqual({ state: "buffering" });
  });

  test("an inline video that ended gives back its sender after a while", async () => {
    setInlineImageMode("kitty");
    setInlineVideoSupport("yes");
    videoPlayerInternalsForTest.setEndedReleaseMs(20);
    const state = videoState();
    await showVideo(state);
    handleVideoHistoryKey({ type: "char", char: " " }, state, { width: 8, height: 16 });
    const play = lastOf("video_play")!;
    handleVideoTerminalReply(`\x1b_Gi=${play.kittyId};OK seq=9 state=ended pos=8000000\x1b\\`);
    expect(stripAnsi(capture(state))).toContain("↻ 0:08 / 0:12  ━");
    for (let i = 0; i < 100 && activeVideo(); i++) await Bun.sleep(5);
    expect(activeVideo()).toBeNull();
    expect(lastOf("video_stop")?.playbackId).toBe(play.playbackId);
  });

  test("captions fit their width, dropping details first", () => {
    const source = { imageId: poster.id, width: 400, height: 200, mediaType: "image/jpeg" as const, sizeBytes: 5000, video };
    expect(videoCaptionText(source, null, true, 60, termWidth)).toBe("▶ 0:12  space plays here · enter plays big");
    expect(videoCaptionText(source, null, true, 10, termWidth)).toBe("▶ 0:12");
    expect(videoCaptionText(source, null, false, 80, termWidth, "viewer")).toBe("▶ 0:12 video · o opens it in a player  this terminal can't play it inline");
    const playing = { ...activeVideoStub(source), state: "playing" as const };
    const wide = videoCaptionText(source, playing, true, 120, termWidth, "viewer");
    expect(wide).toContain("space pause  ←/→ 5s  0-9 jump  m mute  o open  q close");
    // Narrow: the short key list, never no keys at all.
    const narrow = videoCaptionText(source, playing, true, 50, termWidth, "viewer");
    expect(narrow).toMatch(/^▶ 0:0\d \/ 0:12  ━*─+  space pause  ←\/→  q close$/);
    expect(termWidth(narrow)).toBeLessThanOrEqual(50);
  });

  test("an external image is placed, never sent, and its placements report nothing", () => {
    const sync = new KittyImageSync();
    const out = sync.sync([{ image: { kittyId: 5, base64: "", pixelWidth: 400, pixelHeight: 200, external: true }, placementId: 1, row: 2, col: 3, columns: 10, rows: 5 }]);
    expect(out).not.toContain("a=t");
    expect(out).toContain("a=p,i=5,p=1,c=10,r=5,C=1,z=1,q=2");
    expect(sync.dispose()).toBe("\x1b_Ga=d,d=i,i=5,p=1,q=2;\x1b\\");
  });

  test("the link is remote over /ssh or when this terminal is reached over SSH", () => {
    expect(videoLink({ sshRemote: null }, {})).toBe("local");
    expect(videoLink({ sshRemote: { alias: "whale", connected: true } }, {})).toBe("remote");
    expect(videoLink({ sshRemote: null }, { SSH_CONNECTION: "1 2 3 4" })).toBe("remote");
  });
});
