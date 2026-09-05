import { describe, expect, test } from "bun:test";
import { selectOpenAIModelsForTest } from "./models";

describe("OpenAI model selection", () => {
  test("adds the GPT-6 Astra and GPT-5.6 fallbacks while keeping the currently listed older family", () => {
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
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(models[0]).toMatchObject({
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      maxContext: 272_000,
      defaultEffort: "low",
      supportsImages: true,
      supportsFastMode: true,
    });
    expect(models[0]?.supportedEfforts.map((item) => item.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(models[1]).toMatchObject({
      id: "gpt-5.6-sol",
      maxContext: 372_000,
      defaultEffort: "medium",
      supportsImages: true,
    });
    expect(models[1]?.supportedEfforts.map((item) => item.effort)).toEqual(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(models[2]?.supportedEfforts.map((item) => item.effort)).toEqual(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(models[3]?.supportedEfforts.map((item) => item.effort)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(models[4]).toMatchObject({
      id: "gpt-daybreak-blue-latest",
      label: "Daybreak Blue",
      maxContext: 272_000,
      defaultEffort: "low",
      supportsImages: true,
      supportsFastMode: false,
    });
    expect(models[4]?.supportedEfforts.map((item) => item.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(models[8]?.maxContext).toBe(128_000);
    expect(models[8]?.supportsImages).toBe(false);
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
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  test("keeps the Codex GPT-6 Astra metadata and prefers it over older families", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-6-astra",
        display_name: "GPT-6-Astra",
        supported_in_api: true,
        visibility: "list",
        priority: 1,
        context_window: 272_000,
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced" },
          { effort: "high", description: "Deep" },
          { effort: "xhigh", description: "Extra deep" },
          { effort: "max", description: "Hardest problems" },
          { effort: "ultra", description: "Automatic delegation" },
        ],
      },
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        supported_in_api: true,
        visibility: "list",
        priority: 6,
      },
    ]);

    expect(models[0]).toEqual({
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      maxContext: 272_000,
      supportedEfforts: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Deep" },
        { effort: "xhigh", description: "Extra deep" },
        { effort: "max", description: "Hardest problems" },
        { effort: "ultra", description: "Automatic delegation" },
      ],
      defaultEffort: "low",
      supportsImages: true,
      supportsFastMode: true,
    });
    expect(models.some((model) => model.id === "gpt-5.6-sol")).toBe(true);
  });

  test("does not re-add GPT-6 Astra when the Codex endpoint explicitly hides it", () => {
    const models = selectOpenAIModelsForTest([{
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      supported_in_api: true,
      visibility: "hide",
      priority: 1,
    }]);

    expect(models.some((model) => model.id === "gpt-6-astra")).toBe(false);
  });

  test("exposes hidden Daybreak Blue with its Codex endpoint metadata", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-daybreak-blue-latest",
        display_name: "Daybreak Blue",
        supported_in_api: true,
        visibility: "hide",
        priority: 3,
        context_window: 271_000,
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast defensive work" },
          { effort: "max", description: "Deep defensive work" },
          { effort: "ultra", description: "Delegate defensive work" },
        ],
      },
      {
        slug: "gpt-daybreak-red-latest",
        display_name: "Daybreak Red",
        supported_in_api: true,
        visibility: "hide",
        priority: 3,
      },
    ]);

    expect(models.find((model) => model.id === "gpt-daybreak-blue-latest")).toEqual({
      id: "gpt-daybreak-blue-latest",
      label: "Daybreak Blue",
      maxContext: 271_000,
      supportedEfforts: [
        { effort: "low", description: "Fast defensive work" },
        { effort: "max", description: "Deep defensive work" },
        { effort: "ultra", description: "Delegate defensive work" },
      ],
      defaultEffort: "low",
      supportsImages: true,
      supportsFastMode: false,
    });
    expect(models.some((model) => model.id === "gpt-daybreak-red-latest")).toBe(false);
  });

  test("uses Daybreak Blue defaults when remote metadata omits effort details", () => {
    const models = selectOpenAIModelsForTest([{
      slug: "gpt-daybreak-blue-latest",
      display_name: "Daybreak Blue",
      supported_in_api: true,
      visibility: "hide",
      priority: 3,
    }]);
    const daybreak = models.find((model) => model.id === "gpt-daybreak-blue-latest");

    expect(daybreak?.defaultEffort).toBe("low");
    expect(daybreak?.supportedEfforts.map((item) => item.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("does not expose broad GPT family aliases even when upstream lists them", () => {
    const models = selectOpenAIModelsForTest([
      {
        slug: "gpt-6",
        display_name: "GPT-6",
        supported_in_api: true,
        visibility: "list",
        priority: 0,
      },
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

    expect(models.map((model) => model.id)).not.toContain("gpt-6");
    expect(models.map((model) => model.id)).not.toContain("gpt-5.6");
    expect(models.map((model) => model.id).slice(0, 4)).toEqual([
      "gpt-6-astra",
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
      supportsFastMode: true,
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
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.defaultEffort).toBe("medium");
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.maxContext).toBe(372_000);
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.supportedEfforts.map((item) => item.effort)).toContain("max");
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.supportedEfforts.map((item) => item.effort)).toContain("ultra");
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
