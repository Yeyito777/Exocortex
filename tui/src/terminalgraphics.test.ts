import { describe, expect, test } from "bun:test";
import {
  DA1_QUERY,
  GRAPHICS_QUERY_IMAGE_ID,
  TerminalGraphicsDetector,
  forcedImageMode,
  kittyGraphicsQuery,
  parseCellSizeResponse,
  parseKittyGraphicsResponse,
  type TerminalImageMode,
} from "./terminalgraphics";
import { TerminalControlBuffer } from "./terminalclipboard";

function detector() {
  const writes: string[] = [];
  const modes: TerminalImageMode[] = [];
  const instance = new TerminalGraphicsDetector({ write: data => writes.push(data), onModeChanged: mode => modes.push(mode), queryTimeoutMs: 50 });
  return { instance, writes, modes };
}

describe("TerminalGraphicsDetector", () => {
  test("asks with a graphics query followed by DA1", () => {
    const { instance, writes } = detector();
    instance.start({});
    expect(writes).toEqual([kittyGraphicsQuery() + DA1_QUERY]);
    expect(kittyGraphicsQuery()).toBe(`\x1b_Ga=q,t=d,f=32,s=1,v=1,i=${GRAPHICS_QUERY_IMAGE_ID};AAAAAA==\x1b\\`);
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
    const { instance, writes, modes } = detector();
    instance.start({ TMUX: "/tmp/tmux-1000/default,1,0" });
    expect(writes).toEqual([]);
    expect(modes).toEqual(["halfblock"]);
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
