import { describe, expect, test } from "bun:test";
import { selectOpenAIModelsForTest } from "./models";

describe("OpenAI model selection", () => {
  test("adds the GPT-5.6 fallbacks while keeping the currently listed older family", () => {
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
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      maxContext: 372_000,
      defaultEffort: "medium",
      supportsImages: true,
    });
    expect(models[0]?.supportedEfforts.map((item) => item.effort)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(models[6]?.maxContext).toBe(128_000);
    expect(models[6]?.supportsImages).toBe(false);
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
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  test("does not expose the broad GPT-5.6 alias even when upstream lists it", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-5.6",
        display_name: "GPT-5.6",
        supported_in_api: true,
        visibility: "list",
        priority: 1,
      },
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6 Terra",
        supported_in_api: true,
        visibility: "list",
        priority: 2,
      },
    ]);

    expect(models.map((model) => model.id)).not.toContain("gpt-5.6");
    expect(models.map((model) => model.id).slice(0, 3)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
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

    expect(models.find((model) => model.id === "gpt-5.3-codex-spark")).toEqual({
      id: "gpt-5.3-codex-spark",
      label: "Gpt-5.3-codex-spark",
      maxContext: 123_000,
      supportedEfforts: [{ effort: "high", description: "Deep coding" }],
      defaultEffort: "high",
      supportsImages: false,
    });
  });

  test("prefers the GPT-5.6 family over GPT-5.5 and GPT-5.4 when it is listed", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-5.4",
        display_name: "gpt-5.4",
        supported_in_api: true,
        visibility: "list",
        priority: 3,
      },
      {
        slug: "gpt-5.5",
        display_name: "gpt-5.5",
        supported_in_api: true,
        visibility: "list",
        priority: 2,
        default_reasoning_level: "medium",
      },
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6 Terra",
        supported_in_api: true,
        visibility: "list",
        priority: 1,
        default_reasoning_level: "high",
      },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.defaultEffort).toBe("medium");
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.maxContext).toBe(372_000);
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.supportedEfforts.map((item) => item.effort)).toContain("max");
  });

  test("still prefers the GPT-5.5 family over GPT-5.4 when GPT-5.6 is absent upstream", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-5.4-pro",
        display_name: "gpt-5.4-pro",
        supported_in_api: true,
        visibility: "list",
        priority: 3,
      },
      {
        slug: "gpt-5.5-pro",
        display_name: "gpt-5.5-pro",
        supported_in_api: true,
        visibility: "list",
        priority: 1,
        default_reasoning_level: "high",
      },
    ]);

    expect(models.some((model) => model.id === "gpt-5.5-pro")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.4-pro")).toBe(false);
    expect(models.find((model) => model.id === "gpt-5.5-pro")?.defaultEffort).toBe("medium");
  });

  test("defaults every GPT-5.6-family model to medium effort", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-5.6-sol",
        display_name: "gpt-5.6-sol",
        supported_in_api: true,
        visibility: "list",
        priority: 1,
        default_reasoning_level: "high",
      },
      {
        slug: "gpt-5.6-luna",
        display_name: "gpt-5.6-luna",
        supported_in_api: true,
        visibility: "list",
        priority: 2,
        default_reasoning_level: "high",
      },
    ]);

    expect(models.find((model) => model.id === "gpt-5.6-sol")?.defaultEffort).toBe("medium");
    expect(models.find((model) => model.id === "gpt-5.6-luna")?.defaultEffort).toBe("medium");
  });
});
