import { describe, expect, test } from "bun:test";
import { formatGenerateImageOutput } from "./generate-image";

describe("generate_image tool output", () => {
  test("returns only the saved image path", () => {
    const output = formatGenerateImageOutput("/tmp/example.png", "A polished prompt.");

    expect(output).toBe("/tmp/example.png");
    expect(output).not.toContain("Revised prompt:");
    expect(output).not.toContain("Saved:");
  });

  test("still returns only the saved path when OpenAI does not return a revised prompt", () => {
    const output = formatGenerateImageOutput("/tmp/example.png", null);

    expect(output).toBe("/tmp/example.png");
  });
});
