import { describe, expect, test } from "bun:test";
import {
  pinBottomRelativeScrollOffset,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
  scrollWithCursorInViewport,
  updateStreamingResponseAutoscroll,
} from "./viewportscroll";

describe("bottom-relative viewport pinning", () => {
  test("tracks document growth only after the user scrolls away from the bottom", () => {
    expect(pinBottomRelativeScrollOffset(10, 30, 35)).toBe(15);
    expect(pinBottomRelativeScrollOffset(0, 30, 35)).toBe(0);
  });
});

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
});

describe("vim-style viewport scrolling", () => {
  test("Ctrl+E/Y keep the cursor sticky unless it leaves the viewport", () => {
    expect(scrollLineWithStickyCursorInViewport({ totalLines: 100, viewportHeight: 22, viewStart: 19, cursorRow: 29 }, -1))
      .toMatchObject({ viewStart: 20, cursorRow: 29 });

    expect(scrollLineWithStickyCursorInViewport({ totalLines: 100, viewportHeight: 22, viewStart: 19, cursorRow: 19 }, -1))
      .toMatchObject({ viewStart: 20, cursorRow: 20 });

    expect(scrollLineWithStickyCursorInViewport({ totalLines: 100, viewportHeight: 22, viewStart: 19, cursorRow: 29 }, 1))
      .toMatchObject({ viewStart: 18, cursorRow: 29 });
  });

  test("Ctrl+D/U move the cursor and viewport by the scroll amount", () => {
    expect(scrollWithCursorInViewport({ totalLines: 100, viewportHeight: 22, viewStart: 19, cursorRow: 29 }, -1, 5))
      .toMatchObject({ viewStart: 24, cursorRow: 34 });

    expect(scrollWithCursorInViewport({ totalLines: 100, viewportHeight: 22, viewStart: 19, cursorRow: 29 }, 1, 5))
      .toMatchObject({ viewStart: 14, cursorRow: 24 });
  });

  test("Ctrl+F/B scroll by a Vim page and place cursor at the new page edge", () => {
    // Matches Vim's middle-of-buffer behavior for a 22-row window:
    // visible 20-41 (1-indexed) => Ctrl+F shows 40-61 with cursor on 40,
    // and Ctrl+B shows 1-22 with cursor on 22.
    expect(scrollPageWithCursorInViewport({ totalLines: 100, viewportHeight: 22, viewStart: 19, cursorRow: 29 }, -1))
      .toMatchObject({ viewStart: 39, cursorRow: 39 });

    expect(scrollPageWithCursorInViewport({ totalLines: 100, viewportHeight: 22, viewStart: 19, cursorRow: 29 }, 1))
      .toMatchObject({ viewStart: 0, cursorRow: 21 });
  });
});
