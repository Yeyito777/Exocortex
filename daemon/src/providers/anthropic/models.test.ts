import { describe, expect, test } from "bun:test";
import { FALLBACK_ANTHROPIC_MODELS } from "./models";

describe("Anthropic fallback models", () => {
  test("uses deterministic display labels derived from canonical ids", () => {
    expect(FALLBACK_ANTHROPIC_MODELS.map((model) => ({ id: model.id, label: model.label }))).toEqual([
      { id: "claude-opus-4-6", label: "Opus-4.6" },
      { id: "claude-sonnet-4-6", label: "Sonnet-4.6" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku-4.5" },
    ]);
  });
});
