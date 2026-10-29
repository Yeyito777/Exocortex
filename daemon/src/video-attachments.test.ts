import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStoredImage, findStoredVideo, imageIdForBytes, sniffImage } from "./attachments";
import {
  MAX_ATTACH_VIDEO_BYTES,
  gifFrameCount,
  parseProbe,
  playBadgeArgs,
  posterTimeSeconds,
  sniffVideoContainer,
  storeAttachmentFile,
  videoToolsAvailable,
} from "./video-attachments";
import { attach } from "./tools/attach";
import { describeVideo, formatVideoDuration } from "@exocortex/shared/video";

let dir: string;
const haveFfmpeg = videoToolsAvailable();

function ffmpeg(args: string[]): void {
  const proc = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args], { timeout: 20_000 });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-video-attach-"));
  if (!haveFfmpeg) return;
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "clip.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=5:duration=0.6", join(dir, "anim.gif")]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=8x8:duration=0.1", "-frames:v", "1", join(dir, "still.gif")]);
}, 30_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sniffVideoContainer", () => {
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, "latin1"), Buffer.alloc(8)]);

  test("names containers by their first bytes", () => {
    expect(sniffVideoContainer(ftyp("isom"))).toBe("video/mp4");
    expect(sniffVideoContainer(ftyp("mp42"))).toBe("video/mp4");
    expect(sniffVideoContainer(ftyp("qt  "))).toBe("video/quicktime");
    expect(sniffVideoContainer(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("moov....", "latin1")]))).toBe("video/quicktime");
    const ebml = (doc: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from(doc, "latin1")]);
    expect(sniffVideoContainer(ebml("webm"))).toBe("video/webm");
    expect(sniffVideoContainer(ebml("matroska"))).toBe("video/x-matroska");
    expect(sniffVideoContainer(Buffer.from("GIF89a\0\0\0\0\0\0", "latin1"))).toBe("image/gif");
  });

  test("leaves everything else alone", () => {
    expect(sniffVideoContainer(Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\0", "latin1"))).toBeNull();
    expect(sniffVideoContainer(Buffer.from("hello, world", "latin1"))).toBeNull();
    expect(sniffVideoContainer(Buffer.alloc(0))).toBeNull();
  });
});

describe("parseProbe", () => {
  const probe = (streams: unknown[], format: Record<string, unknown> = { duration: "12.345" }) => JSON.stringify({ streams, format });

  test("keeps the display size, length, frame rate, audio and codec", () => {
    expect(parseProbe(probe([
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
      { codec_type: "audio", codec_name: "aac" },
    ]))).toEqual({ width: 1920, height: 1080, durationMs: 12345, fps: 29.97, hasAudio: true, codec: "h264" });
  });

  test("turns a portrait phone video upright and skips cover art", () => {
    expect(parseProbe(probe([
      { codec_type: "video", codec_name: "mjpeg", width: 300, height: 300, disposition: { attached_pic: 1 } },
      { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, r_frame_rate: "60/1", side_data_list: [{ rotation: -90 }] },
    ], {}))).toEqual({ width: 1080, height: 1920, fps: 60, hasAudio: false, codec: "hevc" });
    expect(parseProbe(probe([{ codec_type: "video", width: 640, height: 480, tags: { rotate: "270" } }]))).toMatchObject({ width: 480, height: 640 });
  });

  test("rejects a file without a video stream", () => {
    expect(() => parseProbe(probe([{ codec_type: "audio" }]))).toThrow("no video stream");
  });
});

test("posters come from a tenth of the way in, at most 3 s", () => {
  expect(posterTimeSeconds(undefined)).toBe(0);
  expect(posterTimeSeconds(2_000)).toBeCloseTo(0.2);
  expect(posterTimeSeconds(600_000)).toBe(3);
});

test("the play badge scales with the poster, within bounds", () => {
  const size = (args: string[]) => args[args.indexOf("-size") + 1];
  expect(size(playBadgeArgs(100, 100))).toBe("40x40");
  expect(size(playBadgeArgs(640, 360))).toBe("79x79");
  expect(size(playBadgeArgs(4000, 3000))).toBe("160x160");
});

test("durations and descriptions read the same for the model and the TUI", () => {
  expect(formatVideoDuration(400)).toBe("0.4 s");
  expect(formatVideoDuration(7_900)).toBe("0:07");
  expect(formatVideoDuration(754_000)).toBe("12:34");
  expect(formatVideoDuration(3_723_000)).toBe("1:02:03");
  expect(describeVideo({
    id: "x", mediaType: "video/mp4", sizeBytes: 3.4 * 1024 * 1024, durationMs: 12_000, width: 1920, height: 1080,
    fps: 30, hasAudio: true, codec: "h264", path: "/x.mp4",
  })).toBe("0:12, 1920×1080, 30 fps, H.264 with sound, 3.4 MB");
  expect(describeVideo({ id: "x", mediaType: "image/gif", sizeBytes: 2048, width: 64, height: 48, hasAudio: false, path: "/x.gif" }))
    .toBe("unknown length, 64×48, no sound, 2 KB");
});

describe.skipIf(!haveFfmpeg)("storing videos", () => {
  test("a video is kept with its metadata and a badged poster, once", async () => {
    const ref = await storeAttachmentFile(join(dir, "clip.mp4"));
    const bytes = readFileSync(join(dir, "clip.mp4"));
    expect(ref.video).toMatchObject({
      id: imageIdForBytes(bytes), mediaType: "video/mp4", sizeBytes: bytes.length,
      width: 160, height: 120, fps: 25, hasAudio: true, codec: "h264",
    });
    expect(ref.video!.durationMs).toBeGreaterThan(900);
    expect(ref.video!.durationMs).toBeLessThan(1200);
    expect(ref.video!.path).toBe(findStoredVideo(ref.video!.id)!.path);
    expect(readFileSync(ref.video!.path).equals(bytes)).toBe(true);
    expect(ref).toMatchObject({ mediaType: "image/jpeg", width: 160, height: 120, name: "clip.mp4" });
    const poster = readFileSync(findStoredImage(ref.id)!.path);
    expect(sniffImage(poster)).toEqual({ mediaType: "image/jpeg", width: 160, height: 120 });
    // The badge darkens the middle of the poster.
    const center = Bun.spawnSync(["magick", "jpeg:-", "-crop", "4x4+78+58", "-format", "%[fx:mean]", "info:-"], { stdin: poster });
    const corner = Bun.spawnSync(["magick", "jpeg:-", "-crop", "4x4+150+110", "-format", "%[fx:mean]", "info:-"], { stdin: poster });
    expect(Number(center.stdout.toString())).toBeGreaterThan(0.8);
    expect(Number(corner.stdout.toString())).toBeGreaterThan(0);

    const again = await storeAttachmentFile(join(dir, "clip.mp4"));
    expect(again).toEqual(ref);
  }, 20_000);

  test("an animated GIF is a video, a still one an image", async () => {
    const anim = await storeAttachmentFile(join(dir, "anim.gif"));
    expect(anim.video).toMatchObject({ mediaType: "image/gif", width: 64, height: 48, hasAudio: false, codec: "gif" });
    expect(anim.mediaType).toBe("image/png");
    const still = await storeAttachmentFile(join(dir, "still.gif"));
    expect(still.video).toBeUndefined();
    expect(still.mediaType).toBe("image/gif");
    expect(gifFrameCount(readFileSync(join(dir, "anim.gif")))).toBe(2);
    expect(gifFrameCount(readFileSync(join(dir, "still.gif")))).toBe(1);
  }, 20_000);

  test("refuses what it can't play, and files over the limit", async () => {
    writeFileSync(join(dir, "fake.mp4"), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64)]));
    await expect(storeAttachmentFile(join(dir, "fake.mp4"))).rejects.toThrow("reading the video failed");
    const huge = join(dir, "huge.mp4");
    const fd = openSync(huge, "w");
    writeFileSync(fd, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1")]));
    ftruncateSync(fd, MAX_ATTACH_VIDEO_BYTES + 1);
    closeSync(fd);
    await expect(storeAttachmentFile(huge)).rejects.toThrow("the limit is 1024 MB");
  });

  test("the attach tool tells the model what the user got", async () => {
    const result = await attach.execute({ paths: ["clip.mp4", "anim.gif"] }, { cwd: dir });
    expect(result.isError).toBe(false);
    expect(result.attachments?.map(ref => ref.video?.mediaType)).toEqual(["video/mp4", "image/gif"]);
    expect(result.output).toStartWith("Attached 2 videos; the user sees them after your message:");
    expect(result.output).toMatch(/- clip\.mp4 \(video: 0:01, 160×120, 25 fps, H\.264 with sound, \d+ KB\)/);
    expect(result.output).toContain("- anim.gif (video: ");
    expect(result.output).toContain(`; poster frame: ${findStoredImage(result.attachments![0].id)!.path}`);
    expect(result.output).toContain("you can't watch it");
  }, 20_000);
});
