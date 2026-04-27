import { describe, expect, test } from "bun:test";
import {
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
  scrollWithCursorInViewport,
} from "./viewportscroll";

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
