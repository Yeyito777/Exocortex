import { describe, expect, test } from "bun:test";

import { sanitizePromptTextForInsertion } from "./prompttext";

describe("sanitizePromptTextForInsertion", () => {
  test("strips ANSI/control sequences before text enters the prompt buffer", () => {
    expect(sanitizePromptTextForInsertion("E\x1b[31mred\x1b[0m\u009b32mgreen\x07!")).toBe("Eredgreen!");
  });

  test("normalizes line endings and tabs while preserving multiline text", () => {
    expect(sanitizePromptTextForInsertion("a\r\nb\rc\td")).toBe("a\nb\nc    d");
  });
});
