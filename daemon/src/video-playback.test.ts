import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putImageBytes, storedVideoPath } from "./attachments";
import type { ConnectedClient } from "./server";
import type { Event } from "./protocol";
import { VideoPlayback, controlCommand, parseStatusLine, stPlayPath, takeCompleteApcs, videoPlaybackInternalsForTest } from "./video-playback";
import { imageIdForBytes } from "./attachments";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ESC = "\x1b";
const apc = (body: string) => `${ESC}_${body}${ESC}\\`;

describe("takeCompleteApcs", () => {
  test("passes whole APCs and keeps the unfinished one", () => {
    const a = apc("Ga=v,i=1,k=o;eA==");
    const b = apc("Ga=v,i=1,k=q;c2VxPTE=");
    expect(takeCompleteApcs(a + b)).toEqual({ complete: a + b, rest: "" });
    expect(takeCompleteApcs(a + b.slice(0, 7))).toEqual({ complete: a, rest: b.slice(0, 7) });
    expect(takeCompleteApcs(a + ESC)).toEqual({ complete: a, rest: ESC });
  });

  test("never splits a chunked transfer", () => {
    const first = apc("Ga=v,i=1,k=d,q=2,m=1;AAAA");
    const middle = apc("Gm=1;BBBB");
    const last = apc("Gm=0;CCCC");
    expect(takeCompleteApcs(first + middle)).toEqual({ complete: "", rest: first + middle });
    expect(takeCompleteApcs(first + middle + last.slice(0, 4))).toEqual({ complete: "", rest: first + middle + last.slice(0, 4) });
    const after = apc("Ga=v,i=1,k=q;eQ==");
    expect(takeCompleteApcs(first + middle + last + after)).toEqual({ complete: first + middle + last + after, rest: "" });
  });

  test("drops bytes outside APCs", () => {
    const a = apc("Ga=v,i=1,k=e");
    expect(takeCompleteApcs(`junk${a}more`)).toEqual({ complete: a, rest: "" });
  });
});

test("status lines become video_status events", () => {
  expect(parseStatusLine("status kbps=1234 size=1280x720 copy=0 rate=3100 rtt=0.105", "p1")).toEqual({
    type: "video_status", playbackId: "p1", kbps: 1234, width: 1280, height: 720, copy: false, rateKbps: 3100, rttMs: 105,
  });
  expect(parseStatusLine("st-play: the terminal did not answer", "p1")).toBeNull();
});

test("controls become pipe commands, malformed ones nothing", () => {
  expect(controlCommand({ action: "toggle" })).toBe("toggle");
  expect(controlCommand({ action: "seek", value: 12.5 })).toBe("seek 12.500");
  expect(controlCommand({ action: "skip", value: -5 })).toBe("skip -5.000");
  expect(controlCommand({ action: "size", width: 640, height: 360 })).toBe("size 640x360");
  expect(controlCommand({ action: "volume", value: 0.5 })).toBe("volume 0.500");
  expect(controlCommand({ action: "mute", value: 1 })).toBe("mute 1");
  expect(controlCommand({ action: "seek", value: -1 })).toBeNull();
  expect(controlCommand({ action: "seek", value: Number.NaN })).toBeNull();
  expect(controlCommand({ action: "size", width: 0, height: 10 })).toBeNull();
  expect(controlCommand({ action: "volume", value: 2 })).toBeNull();
  expect(controlCommand({ action: "quit" as never })).toBeNull();
});

// ── With a scripted st-play ─────────────────────────────────────────

let dir: string;
let videoId: string;
const previousStPlay = process.env.EXOCORTEX_ST_PLAY;

/** Plays the pipe protocol: query, open, a chunked packet, status; echoes commands as APCs. */
const FAKE = String.raw`
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("usage: st-play [--pipe]"); process.exit(0); }
require("node:fs").writeFileSync(require("node:path").join(__dirname, "args.json"), JSON.stringify(args));
const id = args[args.indexOf("--id") + 1];
const out = (s) => process.stdout.write(s);
const apc = (body) => "\x1b_" + body + "\x1b\\";
out(apc("Ga=v,i=" + id + ",k=c"));
let input = "";
let opened = false;
process.stdin.on("data", async chunk => {
  input += chunk.toString("latin1");
  for (;;) {
    const start = input.indexOf("\x1b_");
    const end = input.indexOf("\x1b\\", start + 2);
    if (start === -1 || end === -1) break;
    const body = input.slice(start + 2, end);
    input = input.slice(end + 2);
    if (body.startsWith("G") && !opened) {
      opened = true;
      out(apc("Ga=v,i=" + id + ",k=o,q=1;" + btoa("video=h264")));
      out(apc("Ga=v,i=" + id + ",k=d,q=2,m=1;AAAA"));
      await Bun.sleep(20);
      out(apc("Gm=0;BBBB"));
      process.stderr.write("status kbps=500 size=160x120 copy=0 rate=3000 rtt=0.100\n");
    } else if (body.startsWith("!")) {
      const command = body.slice(1);
      if (command === "fail") { process.stderr.write("st-play: boom\n"); process.exit(1); }
      out(apc("Ga=v,i=" + id + ",k=q;" + btoa("cmd=" + command)));
      if (command === "quit") process.exit(0);
    }
  }
});
process.stdin.on("end", () => process.exit(129));
`;

function fakeClient(id: string): ConnectedClient {
  return { id } as unknown as ConnectedClient;
}

function harness() {
  const events: Array<{ client: string; event: Event }> = [];
  const closeListeners: Array<(client: ConnectedClient) => void> = [];
  const playback = new VideoPlayback({
    sendTo: (client, event) => events.push({ client: client.id, event }),
    onClientClosed: listener => {
      closeListeners.push(listener);
      return () => {};
    },
  });
  const output = (playbackId: string) => events
    .filter(item => item.event.type === "video_output" && item.event.playbackId === playbackId)
    .map(item => (item.event as { data: string }).data).join("");
  const waitFor = async (what: () => boolean, label: string) => {
    for (let i = 0; i < 300 && !what(); i++) await Bun.sleep(10);
    if (!what()) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(events.map(item => item.event))}`);
  };
  return { events, playback, output, waitFor, close: (client: ConnectedClient) => closeListeners.forEach(listener => listener(client)) };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-video-playback-"));
  writeFileSync(join(dir, "fake.js"), FAKE);
  writeFileSync(join(dir, "st-play"), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake.js")}" "$@"\n`);
  chmodSync(join(dir, "st-play"), 0o755);
  process.env.EXOCORTEX_ST_PLAY = join(dir, "st-play");
  videoPlaybackInternalsForTest.resetStPlay();
  const bytes = Buffer.from("not really a video, the fake never reads it");
  videoId = imageIdForBytes(bytes);
  const path = storedVideoPath(videoId, "video/mp4");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  putImageBytes(Buffer.from("unused"), "image/png");
});

afterAll(() => {
  if (previousStPlay === undefined) delete process.env.EXOCORTEX_ST_PLAY;
  else process.env.EXOCORTEX_ST_PLAY = previousStPlay;
  videoPlaybackInternalsForTest.resetStPlay();
  rmSync(dir, { recursive: true, force: true });
});

let live: VideoPlayback[] = [];
afterEach(() => {
  for (const playback of live) playback.dispose();
  live = [];
});

describe("VideoPlayback", () => {
  const play = (playbackId: string, extra: Record<string, unknown> = {}) => ({
    type: "video_play" as const, playbackId, videoId, kittyId: 4242, width: 640, height: 360, link: "remote" as const, ...extra,
  });

  test("relays a playback both ways and stops it", async () => {
    const { events, playback, output, waitFor } = harness();
    live.push(playback);
    const client = fakeClient("c1");
    playback.play(client, play("p1", { startMs: 1500, volume: 0.25 }));
    await waitFor(() => output("p1").includes("k=c"), "the capability query");
    expect(JSON.parse(readFileSync(join(dir, "args.json"), "utf8"))).toEqual([
      "--pipe", "--id", "4242", "--size", "640x360", "--link", "remote", "--copy", "--start", "1.500", "--volume", "0.250",
      storedVideoPath(videoId, "video/mp4"),
    ]);

    playback.input(client, "p1", apc("Gi=4242;OK video=h264 audio=aac"));
    await waitFor(() => output("p1").includes("Gm=0;BBBB"), "the packet");
    // The chunked packet arrived in one event, whole.
    const packet = events.find(item => item.event.type === "video_output" && (item.event as { data: string }).data.includes("m=1"));
    expect((packet!.event as { data: string }).data).toContain("Gm=0;BBBB");
    await waitFor(() => events.some(item => item.event.type === "video_status"), "a status");
    expect(events.find(item => item.event.type === "video_status")!.event).toMatchObject({ kbps: 500, width: 160, height: 120 });

    playback.control(client, { type: "video_control", playbackId: "p1", action: "seek", value: 3 });
    await waitFor(() => output("p1").includes(btoa("cmd=seek 3.000")), "the seek");
    playback.control(client, { type: "video_control", playbackId: "p1", action: "seek", value: -3 });
    expect(events.at(-1)!.event).toMatchObject({ type: "error" });

    playback.stop(client, "p1");
    await waitFor(() => events.some(item => item.event.type === "video_ended"), "the end");
    expect(events.find(item => item.event.type === "video_ended")!.event).toEqual({ type: "video_ended", playbackId: "p1", reason: "stopped" });
    expect(playback.activeCount()).toBe(0);
  });

  test("reports a failure with st-play's reason", async () => {
    const { events, playback, output, waitFor } = harness();
    live.push(playback);
    const client = fakeClient("c2");
    playback.play(client, play("p2"));
    await waitFor(() => output("p2").includes("k=c"), "the query");
    playback.input(client, "p2", `${ESC}_!fail${ESC}\\`);
    await waitFor(() => events.some(item => item.event.type === "video_ended"), "the failure");
    expect(events.find(item => item.event.type === "video_ended")!.event).toEqual({ type: "video_ended", playbackId: "p2", reason: "error", message: "boom" });
  });

  test("a client that goes away takes its playbacks with it", async () => {
    const { events, playback, output, waitFor, close } = harness();
    live.push(playback);
    const client = fakeClient("c3");
    playback.play(client, play("p3"));
    await waitFor(() => output("p3").includes("k=c"), "the query");
    close(client);
    await waitFor(() => playback.activeCount() === 0, "the process to exit");
    expect(events.find(item => item.event.type === "video_ended")!.event).toMatchObject({ reason: "stopped" });
  });

  test("refuses bad requests and too many videos", async () => {
    const { events, playback, output, waitFor } = harness();
    live.push(playback);
    const client = fakeClient("c4");
    const ended = (playbackId: string) => events.find(item => item.event.type === "video_ended" && item.event.playbackId === playbackId)?.event;
    playback.play(client, play("bad-id", { videoId: "../../etc/passwd" }));
    expect(ended("bad-id")).toMatchObject({ reason: "error", message: "invalid video id" });
    playback.play(client, play("missing", { videoId: "f".repeat(64) }));
    expect(ended("missing")).toMatchObject({ reason: "error", message: "video not found on the daemon's host" });
    playback.play(client, play("big", { width: 0 }));
    expect(ended("big")).toMatchObject({ message: "invalid size" });
    playback.play(client, play("pid with spaces"));
    expect(events.at(-1)!.event).toMatchObject({ type: "error", message: "video_play: invalid playbackId" });

    playback.play(client, play("a"));
    playback.play(client, play("b"));
    playback.play(client, play("c"));
    expect(ended("c")).toMatchObject({ message: "too many videos are playing" });
    await waitFor(() => output("a").includes("k=c") && output("b").includes("k=c"), "both queries");
    // Another client still may.
    playback.play(fakeClient("c5"), play("a"));
    await waitFor(() => output("a").split("k=c").length === 3, "the other client's query");
  });

  test("an st-play without --pipe is reported, not run", () => {
    writeFileSync(join(dir, "old-st-play"), "#!/bin/sh\necho 'usage: st-play [--inline ROWS]'\n");
    chmodSync(join(dir, "old-st-play"), 0o755);
    process.env.EXOCORTEX_ST_PLAY = join(dir, "old-st-play");
    videoPlaybackInternalsForTest.resetStPlay();
    try {
      expect(stPlayPath()).toEqual({ path: null, reason: `${join(dir, "old-st-play")} is too old to play in Exocortex (no --pipe): update st` });
      const { events, playback } = harness();
      playback.play(fakeClient("c6"), { type: "video_play", playbackId: "old", videoId, kittyId: 1, width: 10, height: 10, link: "local" });
      expect(events[0].event).toMatchObject({ type: "video_ended", reason: "error", message: expect.stringContaining("update st") });
    } finally {
      process.env.EXOCORTEX_ST_PLAY = join(dir, "st-play");
      videoPlaybackInternalsForTest.resetStPlay();
    }
  });
});
