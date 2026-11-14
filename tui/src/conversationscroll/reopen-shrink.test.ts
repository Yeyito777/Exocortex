import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleEvent, type DaemonActions } from "../events";
import { inlineImagesInternalsForTest } from "../inlineimages";
import { mathImagesInternalsForTest, type MathRenderRequest, type MathRenderResponse } from "../mathimages";
import type { ConversationSummary } from "../messages";
import { render } from "../render";
import { createInitialState, type RenderState } from "../state";
import { prepareConversationOpen } from "./position";

// A reply that finished while another conversation was open is opened at its
// first line when it is taller than the pane. Its display math is typeset
// only once it is shown, and the images take fewer rows than the text they
// replace: a reply that then fits must not stay pinned to its first line,
// with blank rows under its last one.

const daemon = new Proxy({}, { get: () => () => {} }) as DaemonActions;

/** Typesets every equation as a 10 × 2 cell image, when `flush` is called. */
function fakeRasterizer() {
  const resolvers: Array<() => void> = [];
  const rasterize = (request: MathRenderRequest) => new Promise<MathRenderResponse>(resolve => {
    resolvers.push(() => resolve({
      id: request.id,
      ok: true,
      base64: `PNG:${request.tex}`,
      pixelWidth: 10 * request.cellWidth,
      pixelHeight: 2 * request.cellHeight,
      cols: 10,
      rows: 2,
    }));
  });
  const flush = async () => {
    while (resolvers.length) resolvers.shift()!();
    await Bun.sleep(0);
  };
  return { rasterize, flush };
}

let math = fakeRasterizer();

beforeEach(() => {
  inlineImagesInternalsForTest.reset();
  math = fakeRasterizer();
  mathImagesInternalsForTest.reset({ setting: "image", rasterize: math.rasterize });
});
afterEach(() => {
  inlineImagesInternalsForTest.reset();
  mathImagesInternalsForTest.reset();
});

function silently(state: RenderState): void {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { render(state); } finally { process.stdout.write = write; }
}

function plain(line: string | undefined): string {
  return (line ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
}

/** The history rows on screen, top to bottom; null where the pane shows nothing. */
function screen(state: RenderState): Array<string | null> {
  return state.layout.historyViewportRows.map(row => row ? plain(state.historyLines[row.lineIndex]) : null);
}

function summary(id: string, unread: boolean): ConversationSummary {
  return {
    id, provider: "openai", model: "gpt-5.5", effort: "high", fastMode: false, createdAt: 1, updatedAt: 1,
    messageCount: 0, title: id, marked: false, pinned: false, streaming: false, unread, sortOrder: 1,
  };
}

const EQUATIONS = 6;

/** Six equations of five lines each: far taller as text than as 2-row images. */
function reply(): string {
  const equation = (n: number) => [
    "$$", "\\begin{aligned}",
    ...Array.from({ length: 5 }, (_, line) => `S_{${n}} &= ${line} + \\frac{${n}}{k+1} \\\\`),
    "\\end{aligned}", "$$",
  ].join("\n");
  return ["reply first line", ...Array.from({ length: EQUATIONS }, (_, n) => `${equation(n + 1)}\n\nequation ${n + 1} above`)].join("\n\n");
}

function openUnreadFinishedConversation(): RenderState {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 40;
  state.sidebar.open = false;
  state.sidebar.conversations = [summary("work", true)];
  prepareConversationOpen(state, "work");
  handleEvent({
    type: "conversation_loaded",
    reqId: "open-work",
    convId: "work",
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    entries: [
      ...Array.from({ length: 12 }, (_, turn) => [
        { type: "user" as const, text: `older prompt ${turn}` },
        { type: "ai" as const, blocks: [{ type: "text" as const, text: `older reply ${turn}\nsecond line` }], metadata: null },
      ]).flat(),
      { type: "user", text: "work it out" },
      { type: "ai", blocks: [{ type: "text", text: reply() }], metadata: null },
    ],
    contextTokens: 100,
    toolOutputsIncluded: true,
  }, state, daemon);
  return state;
}

describe("reopening a finished reply that gets shorter once shown", () => {
  test("typeset equations leave no blank rows under the reply", async () => {
    const state = openUnreadFinishedConversation();
    silently(state);

    // Taller than the pane while its equations are still text: opened at its first line.
    const height = state.layout.messageAreaHeight;
    expect(screen(state)[0]).toBe("reply first line");
    expect(screen(state)).not.toContain(null);
    expect(screen(state)).not.toContain(`equation ${EQUATIONS} above`);

    await math.flush();
    silently(state);
    silently(state);

    // Typeset, the whole reply fits: it ends at the bottom of the pane.
    const rows = screen(state);
    expect(rows).toHaveLength(height);
    expect(rows).toContain("reply first line");
    expect(rows).toContain(`equation ${EQUATIONS} above`);
    expect(rows.filter(row => row === null)).toHaveLength(0);
    expect(state.historyLines.length - 1).toBe(state.layout.historyViewportRows[height - 1]!.lineIndex);
  });
});
