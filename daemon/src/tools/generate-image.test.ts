import { describe, expect, test } from "bun:test";
import { formatGenerateImageOutput } from "./generate-image";

describe("generate_image tool output", () => {
  test("shows revised prompt above saved path without echoing the original prompt", () => {
    const output = formatGenerateImageOutput("/tmp/example.png", "A polished prompt.");

    expect(output).toBe("Revised prompt:\nA polished prompt.\n\nSaved:\n/tmp/example.png");
    expect(output).not.toContain("Generated image.");
    expect(output).not.toContain("Prompt: ");
  });

  test("falls back to only the saved path when OpenAI does not return a revised prompt", () => {
    const output = formatGenerateImageOutput("/tmp/example.png", null);

    expect(output).toBe("Saved:\n/tmp/example.png");
    expect(output).not.toContain("Revised prompt:");
  });
});
