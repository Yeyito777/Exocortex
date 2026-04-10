import { describe, expect, test } from "bun:test";
import { selectOpenAIModelsForTest } from "./models";

describe("OpenAI model selection", () => {
  test("adds gpt-5.3-codex-spark to the picker when the Codex endpoint omits it", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-5.4",
        display_name: "gpt-5.4",
        supported_in_api: true,
        visibility: "list",
        priority: 1,
        context_window: 272_000,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast" },
          { effort: "medium", description: "Balanced" },
          { effort: "high", description: "Deep" },
        ],
      },
      {
        slug: "gpt-5.4-mini",
        display_name: "GPT-5.4-Mini",
        supported_in_api: true,
        visibility: "list",
        priority: 3,
        context_window: 272_000,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast" },
          { effort: "medium", description: "Balanced" },
          { effort: "high", description: "Deep" },
        ],
      },
      {
        slug: "gpt-5.3-codex",
        display_name: "gpt-5.3-codex",
        supported_in_api: true,
        visibility: "list",
        priority: 5,
        context_window: 272_000,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
      },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(models[2]?.maxContext).toBe(128_000);
    expect(models[2]?.supportsImages).toBe(false);
  });

  test("does not re-add gpt-5.3-codex-spark when the Codex endpoint explicitly hides it", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-5.3-codex-spark",
        display_name: "GPT-5.3-Codex-Spark",
        supported_in_api: true,
        visibility: "hide",
        priority: 4,
      },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  test("keeps Codex endpoint metadata for gpt-5.3-codex-spark when it is present", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-5.3-codex-spark",
        display_name: "GPT-5.3-Codex-Spark",
        supported_in_api: true,
        visibility: "list",
        priority: 4,
        context_window: 123_000,
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "high", description: "Deep coding" }],
      },
    ]);

    expect(models[0]).toEqual({
      id: "gpt-5.3-codex-spark",
      label: "Gpt-5.3-codex-spark",
      maxContext: 123_000,
      supportedEfforts: [{ effort: "high", description: "Deep coding" }],
      defaultEffort: "high",
      supportsImages: false,
    });
  });
});
