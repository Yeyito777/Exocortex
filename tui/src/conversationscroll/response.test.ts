import { describe, expect, test } from "bun:test";
import { updateStreamingResponseAutoscroll } from "./response";

describe("streaming response autoscroll", () => {
  test("follows a new response from a scrolled position, then holds its first row on overflow", () => {
    let update = updateStreamingResponseAutoscroll({
      state: null,
      responseId: "turn-1:text-2",
      responseStart: 90,
      responseEnd: 95,
      previousScrollOffset: 30,
      scrollOffset: 30,
      totalLines: 96,
      viewportHeight: 10,
    });
    expect(update).toMatchObject({
      state: { responseId: "turn-1:text-2", mode: "following", lastScrollOffset: 0 },
      scrollOffset: 0,
    });

    update = updateStreamingResponseAutoscroll({
      state: update.state,
      responseId: "turn-1:text-2",
      responseStart: 90,
      responseEnd: 101,
      previousScrollOffset: 0,
      scrollOffset: 0,
      totalLines: 102,
      viewportHeight: 10,
    });
    expect(update).toMatchObject({ state: { mode: "anchored" }, scrollOffset: 2 });

    // Ordinary document-growth pinning changes 2 -> 6 before the helper runs.
    update = updateStreamingResponseAutoscroll({
      state: update.state,
      responseId: "turn-1:text-2",
      responseStart: 90,
      responseEnd: 105,
      previousScrollOffset: 2,
      scrollOffset: 6,
      totalLines: 106,
      viewportHeight: 10,
    });
    expect(update).toMatchObject({ state: { mode: "anchored", lastScrollOffset: 6 }, scrollOffset: 6 });
    expect(106 - 10 - update.scrollOffset).toBe(90);
  });

  test("cedes control when the user scrolls during the response", () => {
    const update = updateStreamingResponseAutoscroll({
      state: { responseId: "turn-1:text-2", mode: "following", lastScrollOffset: 0 },
      responseId: "turn-1:text-2",
      responseStart: 90,
      responseEnd: 96,
      previousScrollOffset: 4,
      scrollOffset: 4,
      totalLines: 97,
      viewportHeight: 10,
    });

    expect(update).toMatchObject({ state: { mode: "dismissed" }, scrollOffset: 4 });
  });

  test("anchors when viewport-only reflow overflows even if canonical rows fit", () => {
    const update = updateStreamingResponseAutoscroll({
      state: null,
      responseId: "turn-1:text-2",
      responseStart: 90,
      responseEnd: 98,
      responseHeight: 12,
      previousScrollOffset: 0,
      scrollOffset: 0,
      totalLines: 99,
      viewportHeight: 10,
    });

    expect(update).toMatchObject({ state: { mode: "anchored" } });
  });
});
