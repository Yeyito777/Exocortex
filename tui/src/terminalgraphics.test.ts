import { describe, expect, test } from "bun:test";
import {
  DA1_QUERY,
  GRAPHICS_QUERY_IMAGE_ID,
  TerminalGraphicsDetector,
  VIDEO_QUERY_IMAGE_ID,
  forcedImageMode,
  kittyGraphicsQuery,
  parseCellSizeResponse,
  parseKittyGraphicsResponse,
  videoCapabilityPlays,
  videoCapabilityQuery,
  videoDisabled,
  type TerminalImageMode,
  type TerminalVideoSupport,
} from "./terminalgraphics";
import { TerminalControlBuffer } from "./terminalclipboard";

function detector() {
  const writes: string[] = [];
  const modes: TerminalImageMode[] = [];
  const video: TerminalVideoSupport[] = [];
  const instance = new TerminalGraphicsDetector({
    write: data => writes.push(data),
    onModeChanged: mode => modes.push(mode),
    onVideoChanged: support => video.push(support),
    queryTimeoutMs: 50,
  });
  return { instance, writes, modes, video };
}

describe("TerminalGraphicsDetector", () => {
  test("asks with a graphics query and st's video query followed by DA1", () => {
    const { instance, writes } = detector();
    instance.start({});
    expect(writes).toEqual([kittyGraphicsQuery() + videoCapabilityQuery() + DA1_QUERY]);
    expect(kittyGraphicsQuery()).toBe(`\x1b_Ga=q,t=d,f=32,s=1,v=1,i=${GRAPHICS_QUERY_IMAGE_ID};AAAAAA==\x1b\\`);
    expect(videoCapabilityQuery()).toBe(`\x1b_Ga=v,i=${VIDEO_QUERY_IMAGE_ID},k=c\x1b\\`);
    instance.dispose();
  });

  test("an OK graphics reply before DA1 means Kitty graphics", () => {
    const { instance, modes } = detector();
    instance.start({});
    expect(instance.handleControlSequence(`\x1b_Gi=${GRAPHICS_QUERY_IMAGE_ID};OK\x1b\\`)).toBe(true);
    expect(instance.handleControlSequence("\x1b[?62;22c")).toBe(true);
    expect(modes).toEqual(["kitty"]);
  });

  test("DA1 without a graphics reply means the half-block fallback", () => {
    const { instance, modes } = detector();
    instance.start({});
    expect(instance.handleControlSequence("\x1b[?6c")).toBe(true);
    // A late reply cannot flip the decision.
    instance.handleControlSequence(`\x1b_Gi=${GRAPHICS_QUERY_IMAGE_ID};OK\x1b\\`);
    expect(modes).toEqual(["halfblock"]);
  });

  test("an error reply means the fallback", () => {
    const { instance, modes } = detector();
    instance.start({});
    instance.handleControlSequence(`\x1b_Gi=${GRAPHICS_QUERY_IMAGE_ID};EINVAL:unsupported\x1b\\`);
    expect(modes).toEqual(["halfblock"]);
  });

  test("silence falls back after the timeout", async () => {
    const { instance, modes } = detector();
    instance.start({});
    await Bun.sleep(80);
    expect(modes).toEqual(["halfblock"]);
  });

  test("EXOCORTEX_TUI_IMAGES forces a mode without querying", () => {
    const { instance, writes, modes } = detector();
    instance.start({ EXOCORTEX_TUI_IMAGES: "halfblock" });
    expect(writes).toEqual([]);
    expect(modes).toEqual(["halfblock"]);
    expect(forcedImageMode({ EXOCORTEX_TUI_IMAGES: "Kitty" })).toBe("kitty");
    expect(forcedImageMode({ EXOCORTEX_TUI_IMAGES: "maybe" })).toBeNull();
  });

  test("inside tmux the fallback is chosen without a query", () => {
    const { instance, writes, modes, video } = detector();
    instance.start({ TMUX: "/tmp/tmux-1000/default,1,0" });
    expect(writes).toEqual([]);
    expect(modes).toEqual(["halfblock"]);
    expect(video).toEqual(["no"]);
  });
});

describe("video detection", () => {
  test("st's video answer before DA1 means videos play", () => {
    const { instance, modes, video } = detector();
    instance.start({});
    instance.handleControlSequence(`\x1b_Gi=${GRAPHICS_QUERY_IMAGE_ID};OK\x1b\\`);
    expect(instance.handleControlSequence(`\x1b_Gi=${VIDEO_QUERY_IMAGE_ID};OK video=h264 audio=aac max=4096x4096\x1b\\`)).toBe(true);
    instance.handleControlSequence("\x1b[?62;22c");
    expect(modes).toEqual(["kitty"]);
    expect(video).toEqual(["yes"]);
    expect(instance.getVideoSupport()).toBe("yes");
  });

  test("a Kitty terminal without st's video (DA1 first, or ENOSYS) can't play", () => {
    const silent = detector();
    silent.instance.start({});
    silent.instance.handleControlSequence(`\x1b_Gi=${GRAPHICS_QUERY_IMAGE_ID};OK\x1b\\`);
    silent.instance.handleControlSequence("\x1b[?62;22c");
    // A late answer cannot flip it.
    silent.instance.handleControlSequence(`\x1b_Gi=${VIDEO_QUERY_IMAGE_ID};OK video=h264\x1b\\`);
    expect(silent.modes).toEqual(["kitty"]);
    expect(silent.video).toEqual(["no"]);

    const refused = detector();
    refused.instance.start({});
    refused.instance.handleControlSequence(`\x1b_Gi=${VIDEO_QUERY_IMAGE_ID};ENOSYS:no video backend\x1b\\`);
    expect(refused.video).toEqual(["no"]);
  });

  test("silence means no video after the timeout", async () => {
    const { instance, video } = detector();
    instance.start({});
    for (let i = 0; i < 100 && video.length === 0; i++) await Bun.sleep(5);
    expect(video).toEqual(["no"]);
  });

  test("EXOCORTEX_TUI_VIDEO=off skips the query; forced Kitty still asks about video", () => {
    const off = detector();
    off.instance.start({ EXOCORTEX_TUI_VIDEO: "off" });
    expect(off.writes).toEqual([kittyGraphicsQuery() + DA1_QUERY]);
    expect(off.video).toEqual(["no"]);
    off.instance.dispose();
    expect(videoDisabled({ EXOCORTEX_TUI_VIDEO: "OFF" })).toBe(true);
    expect(videoDisabled({})).toBe(false);

    const forced = detector();
    forced.instance.start({ EXOCORTEX_TUI_IMAGES: "kitty" });
    expect(forced.modes).toEqual(["kitty"]);
    expect(forced.writes).toEqual([videoCapabilityQuery() + DA1_QUERY]);
    forced.instance.handleControlSequence(`\x1b_Gi=${VIDEO_QUERY_IMAGE_ID};OK video=h264 audio=aac\x1b\\`);
    expect(forced.video).toEqual(["yes"]);
  });

  test("only an OK naming h264 plays", () => {
    expect(videoCapabilityPlays("OK video=h264 audio=aac max=4096x4096")).toBe(true);
    expect(videoCapabilityPlays("OK video=hevc,h264")).toBe(true);
    expect(videoCapabilityPlays("OK video=hevc")).toBe(false);
    expect(videoCapabilityPlays("OK audio=aac")).toBe(false);
    expect(videoCapabilityPlays("ENOSYS:video=h264")).toBe(false);
  });
});

describe("reply parsing", () => {
  test("cell size", () => {
    expect(parseCellSizeResponse("\x1b[6;18;9t")).toEqual({ width: 9, height: 18 });
    expect(parseCellSizeResponse("\x1b[6;0;9t")).toBeNull();
    expect(parseCellSizeResponse("\x1b[4;800;600t")).toBeNull();
  });

  test("graphics replies", () => {
    expect(parseKittyGraphicsResponse("\x1b_Gi=42,p=7;ENOENT:image not found\x1b\\")).toEqual({ imageId: 42, placementId: 7, message: "ENOENT:image not found" });
    expect(parseKittyGraphicsResponse("\x1b_Gi=0;OK\x1b\\")).toBeNull();
  });
});

describe("TerminalControlBuffer routing", () => {
  test("terminal replies never reach key input, even split across reads", () => {
    const input: string[] = [];
    const control: string[] = [];
    const buffer = new TerminalControlBuffer(data => input.push(data), sequence => control.push(sequence));
    buffer.feed("a\x1b_Gi=5;O");
    buffer.feed("K\x1b\\b\x1b[?62;");
    buffer.feed("22c\x1b[6;18;9tc");
    expect(control).toEqual(["\x1b_Gi=5;OK\x1b\\", "\x1b[?62;22c", "\x1b[6;18;9t"]);
    expect(input.join("")).toBe("abc");
    buffer.dispose();
  });
});
