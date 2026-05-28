import { describe, expect, test } from "bun:test";

import { processKey } from "./engine";
import { createVimState } from "./types";

describe("visual prompt deletion", () => {
  test("Shift+D deletes the visual selection and returns it for clipboard yank", () => {
    const vim = createVimState();
    vim.mode = "visual";
    vim.visualAnchor = 0;

    const result = processKey({ type: "char", char: "D" }, vim, "prompt", "hello world", 4);

    expect(result).toEqual({
      type: "visual_edit",
      buffer: " world",
      cursor: 0,
      mode: "normal",
      yankText: "hello",
    });
  });
});
