import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageCellSize, setInlineImageMode } from "./inlineimages";
import { cursorZone, handleMouseEvent, refreshMouseCursor } from "./mouse";
import { disposeHistoryImages } from "./historyimages";
import { openEditMessageModal, editMessageItemIndexAtMouse } from "./editmessage";
import { stripAnsi } from "./historycursor";
import type { ImageRef } from "./messages";

/** Run `fn`, returning everything it wrote to stdout instead of printing it. */
function captureOutput(fn: () => void): string {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  return out;
}

const capture = (state: RenderState) => captureOutput(() => render(state));

async function readyFrame(state: RenderState): Promise<string> {
  capture(state);
  await Bun.sleep(0);
  await Bun.sleep(0);
  return capture(state);
}

const placements = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)H\x1b_G(a=p[^;]*);/g)]
  .map(match => ({ row: Number(match[1]), col: Number(match[2]) }));

const portrait = { width: 945, height: 1253 };
const refs = (count: number): ImageRef[] => Array.from({ length: count }, (_, i) => ({
  id: String(i).repeat(64).slice(0, 64),
  mediaType: "image/png" as const,
  width: portrait.width,
  height: portrait.height,
  sizeBytes: 533_000,
  name: `shot-${i + 1}.png`,
}));

const fetchPreview = async (request: { width: number; height: number; format: string }) => request.format === "png"
  ? { format: "png" as const, width: request.width, height: request.height, base64: "UE5H" }
  : { format: "rgba" as const, width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") };

const LINK_TEXT = "See [Paper](https://example.com) and /tmp/exo-notes.md for details.";

/** A link, a bare file path, and an assistant message attaching `images`, scrolled into view. */
function conversation(images: ImageRef[], cols = 70): RenderState {
  const state = createInitialState();
  state.cols = cols;
  state.rows = 40;
  state.convId = "conv";
  state.sidebar.open = false;
  state.messages = [
    { role: "user", text: "show me", metadata: null },
    {
      role: "assistant",
      blocks: [
        { type: "text", text: LINK_TEXT },
        { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: images.map(image => image.name) }, summary: "" },
        { type: "tool_result", toolCallId: "c1", toolName: "attach", output: `Attached ${images.length} images`, isError: false, images },
        { type: "text", text: "Here they are." },
      ],
      metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
    },
    ...Array.from({ length: 60 }, (_, i) => ({ role: "system" as const, text: `filler ${i}`, metadata: null })),
  ];
  capture(state);
  const linkRow = state.historyLines.findIndex(line => stripAnsi(line).includes("Paper"));
  state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - linkRow + 2;
  return state;
}

const mouse = (col: number, row: number, action: "press" | "release" | "motion", button = 0) =>
  ({ type: "mouse" as const, shift: false, meta: false, ctrl: false, col, row, button, action });

/** Hover with no button held, as any-motion tracking reports it; returns the OSC 777 escapes written. */
function hover(state: RenderState, col: number, row: number): string {
  return captureOutput(() => handleMouseEvent(mouse(col, row, "motion", 3), state));
}

/** Screen cell of the first occurrence of `needle` in the rendered history. */
function screenCellOf(state: RenderState, needle: string): { col: number; row: number } {
  for (let index = 0; index < state.layout.historyViewportRows.length; index++) {
    const viewport = state.layout.historyViewportRows[index];
    if (!viewport) continue;
    const plain = stripAnsi(state.historyLines[viewport.lineIndex]);
    const at = plain.indexOf(needle, viewport.startCol);
    if (at >= 0) return { col: state.layout.chatCol + viewport.displayPrefixWidth + at - viewport.startCol, row: 3 + index };
  }
  throw new Error(`${needle} is not on screen`);
}

function kitty(): void {
  configureInlineImages({ fetch: fetchPreview, onChange: () => {} });
  setInlineImageMode("kitty");
  setInlineImageCellSize({ width: 8, height: 16 });
}

beforeEach(() => {
  inlineImagesInternalsForTest.reset();
  writeExocortexConfig({ openers: { rules: [{ text: true, command: "configured-editor", args: ["{path}"] }] } });
});
afterEach(() => {
  inlineImagesInternalsForTest.reset();
  writeExocortexConfig(defaultExocortexConfig());
});

describe("hand cursor over clickable history", () => {
  test("links and file paths show a hand; plain text keeps the I-beam", async () => {
    kitty();
    const state = conversation(refs(1));
    await readyFrame(state);
    const link = screenCellOf(state, "Paper");
    expect(hover(state, link.col + 1, link.row)).toBe("\x1b]777;mouseshape;hand\x07");
    expect(state.mouseCursor).toBe("hand");
    const path = screenCellOf(state, "/tmp/exo-notes.md");
    expect(hover(state, path.col + 5, path.row)).toBe("");
    expect(state.mouseCursor).toBe("hand");
    const plain = screenCellOf(state, "details");
    expect(hover(state, plain.col + 1, plain.row)).toBe("\x1b]777;mouseshape;text\x07");
    // Past the end of a row is not the row's last word.
    hover(state, state.cols - 1, link.row);
    expect(state.mouseCursor).toBe("text");
    disposeHistoryImages(state);
  });

  test("a single image shows a hand across its rows, as a click there opens it", async () => {
    kitty();
    const state = conversation(refs(1));
    const [thumb] = placements(await readyFrame(state));
    expect(thumb).toBeDefined();
    hover(state, thumb.col + 2, thumb.row + 3);
    expect(state.mouseCursor).toBe("hand");
    hover(state, state.cols - 1, thumb.row + 3);
    expect(state.mouseCursor).toBe("hand");
    // The blank row above the image is not part of it.
    hover(state, thumb.col + 2, thumb.row - 1);
    expect(state.mouseCursor).toBe("text");
    disposeHistoryImages(state);
  });

  test("strip thumbnails and `› +N` show a hand; the gaps between them do not", async () => {
    kitty();
    const state = conversation(refs(5));
    const shown = placements(await readyFrame(state));
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(5);
    const [first, second] = shown;
    hover(state, first.col + 1, first.row + 2);
    expect(state.mouseCursor).toBe("hand");
    hover(state, second.col - 1, second.row + 2);
    expect(state.mouseCursor).toBe("text");
    hover(state, second.col, second.row + 2);
    expect(state.mouseCursor).toBe("hand");
    const overflow = screenCellOf(state, `› +${5 - shown.length}`);
    hover(state, overflow.col - 1, overflow.row);
    expect(state.mouseCursor).toBe("text");
    hover(state, overflow.col + 2, overflow.row);
    expect(state.mouseCursor).toBe("hand");
    disposeHistoryImages(state);
  });

  test("every message-area cell shows a hand exactly when a click there opens something", async () => {
    kitty();
    const state = conversation(refs(5));
    await readyFrame(state);
    let hands = 0;
    for (let row = 3; row < state.layout.sepAbove; row++) {
      for (let col = 1; col <= state.cols; col++) {
        const zone = cursorZone(col, row, state);
        let result = "";
        captureOutput(() => {
          handleMouseEvent(mouse(col, row, "press"), state);
          result = handleMouseEvent(mouse(col, row, "release"), state).type;
        });
        const clickable = result === "open_image" || result === "open_target";
        if (clickable) hands++;
        expect({ col, row, hand: zone === "hand" }).toEqual({ col, row, hand: clickable });
      }
    }
    expect(hands).toBeGreaterThan(0);
    disposeHistoryImages(state);
  });

  test("content scrolled under a still pointer updates the shape after the render", async () => {
    kitty();
    const state = conversation(refs(1));
    await readyFrame(state);
    const link = screenCellOf(state, "Paper");
    hover(state, link.col + 1, link.row);
    expect(state.mouseCursor).toBe("hand");
    state.scrollOffset -= 1;
    capture(state);
    expect(captureOutput(() => refreshMouseCursor(state))).toBe("\x1b]777;mouseshape;text\x07");
    state.scrollOffset += 1;
    capture(state);
    expect(captureOutput(() => refreshMouseCursor(state))).toBe("\x1b]777;mouseshape;hand\x07");
    disposeHistoryImages(state);
  });
});

describe("cursor over overlays", () => {
  test("the image viewer is a dismiss-anywhere backdrop: arrow, never a hand", async () => {
    kitty();
    const state = conversation(refs(1));
    const [thumb] = placements(await readyFrame(state));
    hover(state, thumb.col + 2, thumb.row + 3);
    expect(state.mouseCursor).toBe("hand");
    handleMouseEvent(mouse(thumb.col + 2, thumb.row + 3, "press"), state);
    const opened = handleMouseEvent(mouse(thumb.col + 2, thumb.row + 3, "release"), state);
    if (opened.type !== "open_image") throw new Error(`expected open_image, got ${opened.type}`);
    state.imageModal = { images: opened.target.images, index: opened.target.index };
    expect(cursorZone(thumb.col + 2, thumb.row + 3, state)).toBe("pointer");
    expect(captureOutput(() => refreshMouseCursor(state))).toBe("\x1b]777;mouseshape;pointer\x07");
    state.imageModal = null;
    expect(captureOutput(() => refreshMouseCursor(state))).toBe("\x1b]777;mouseshape;hand\x07");
    disposeHistoryImages(state);
  });

  test("edit-message picker rows show a hand; the rest of the modal does not", () => {
    const state = createInitialState();
    state.convId = "conv-click";
    state.cols = 100;
    state.layout.chatCol = 1;
    state.layout.sepAbove = 20;
    state.layout.messageAreaHeight = 17;
    state.messages.push(
      { role: "user", text: "first", metadata: null },
      { role: "user", text: "second", metadata: null },
    );
    openEditMessageModal(state);
    let items = 0;
    for (let row = 1; row <= state.rows; row++) {
      for (let col = 1; col <= state.cols; col++) {
        const item = editMessageItemIndexAtMouse(state, col, row);
        if (item !== null) items++;
        expect(cursorZone(col, row, state)).toBe(item === null ? "pointer" : "hand");
      }
    }
    expect(items).toBeGreaterThan(0);
  });

  test("the queue prompt swallows clicks, so links under it show no hand", async () => {
    kitty();
    const state = conversation(refs(1));
    const [thumb] = placements(await readyFrame(state));
    const link = screenCellOf(state, "Paper");
    state.queuePrompt = { text: "queued", selection: "message-end" };
    expect(cursorZone(link.col + 1, link.row, state)).toBe("text");
    expect(cursorZone(thumb.col + 2, thumb.row + 3, state)).toBe("text");
    disposeHistoryImages(state);
  });
});
