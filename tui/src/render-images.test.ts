import { afterEach, describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageMode } from "./inlineimages";
import { disposeHistoryImages } from "./historyimages";

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

function imageState(): RenderState {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 40;
  state.convId = "conv";
  const ref = { id: "e".repeat(64), mediaType: "image/png" as const, width: 400, height: 200, sizeBytes: 5000, name: "chart.png" };
  state.messages = [
    { role: "user", text: "plot it", metadata: null },
    {
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: ["chart.png"] }, summary: "chart.png" },
        { type: "tool_result", toolCallId: "c1", toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] },
        { type: "text", text: "Here is the chart." },
      ],
      metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
    },
    ...Array.from({ length: 30 }, (_, i) => ({ role: "system" as const, text: `filler ${i}`, metadata: null })),
  ];
  return state;
}

async function readyFrame(state: RenderState): Promise<string> {
  capture(state);
  await Bun.sleep(0);
  return capture(state);
}

afterEach(() => inlineImagesInternalsForTest.reset());

describe("render with Kitty images", () => {
  test("transmits and places a visible image, crops it when scrolled, deletes it when gone", async () => {
    configureInlineImages({
      fetch: async request => ({ format: "png", width: request.width, height: Math.round(request.width / 2), base64: "UE5H" }),
      onChange: () => {},
    });
    setInlineImageMode("kitty");
    const state = imageState();
    // Scroll up so the attached image is on screen.
    state.scrollOffset = 18;
    const first = await readyFrame(state);
    expect(first).toContain("a=t,t=d,f=100");
    const [whole] = placements(first);
    expect(whole).toBeDefined();
    // No DECSTBM scroll-region shortcut while images are placed.
    state.scrollOffset = 16;
    const scrolled = capture(state);
    expect(scrolled).not.toMatch(/\x1b\[\d+;\d+r/);
    const [moved] = placements(scrolled);
    expect(moved.row).toBeLessThan(whole.row);
    expect(scrolled).not.toContain("a=t,t=d");

    // At the bottom only the image's last row is still on screen.
    state.scrollOffset = 0;
    const [sliver] = placements(capture(state));
    expect(sliver.controls).toMatch(/,r=1,x=0,y=\d+,w=\d+,h=\d+,/);

    // Switching conversations removes it.
    state.convId = "other";
    state.messages = [{ role: "user", text: "different conversation", metadata: null }];
    const away = capture(state);
    expect(away).toContain("a=d,d=i");
    expect(placements(away)).toEqual([]);
    disposeHistoryImages(state);
  });

  test("hides images while a floating overlay is open", async () => {
    configureInlineImages({
      fetch: async request => ({ format: "png", width: request.width, height: Math.round(request.width / 2), base64: "UE5H" }),
      onChange: () => {},
    });
    setInlineImageMode("kitty");
    const state = imageState();
    state.scrollOffset = 18;
    expect(placements(await readyFrame(state)).length).toBe(1);
    state.queuePrompt = { text: "queued", images: [], selection: "next-turn" } as never;
    expect(capture(state)).toContain("a=d,d=i");
    state.queuePrompt = null;
    expect(placements(capture(state)).length).toBe(1);
    disposeHistoryImages(state);
  });

  test("the half-block fallback draws pixels as text and sends no graphics", async () => {
    configureInlineImages({
      fetch: async request => ({ format: "rgba", width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") }),
      onChange: () => {},
    });
    setInlineImageMode("halfblock");
    const state = imageState();
    state.scrollOffset = 18;
    const out = await readyFrame(state);
    expect(out).toContain("▀▀▀▀");
    expect(out).not.toContain("\x1b_G");
  });
});
