import { describe, expect, test } from "bun:test";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { buildToolSystemHints, getToolDefs, getToolDisplayInfo } from "./registry";

describe("tool availability", () => {
  test("image generation and file transcription are external CLI tools, not internal API tools", () => {
    expect(getToolDefs().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(getToolDefs().some((tool) => tool.name === "transcribe_audio")).toBe(false);
    expect(getToolDisplayInfo().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(getToolDisplayInfo().some((tool) => tool.name === "transcribe_audio")).toBe(false);
    expect(buildToolSystemHints()).not.toContain("Use image generation to create assets");
    expect(buildToolSystemHints()).not.toContain("Use audio transcription");
  });

  test("tool schemas avoid OpenAI-rejected top-level JSON Schema composition keywords", () => {
    const forbiddenTopLevelKeywords = ["oneOf", "anyOf", "allOf", "enum", "not"];

    for (const tool of getToolDefs()) {
      expect(tool.input_schema.type).toBe("object");
      for (const keyword of forbiddenTopLevelKeywords) {
        expect(tool.input_schema).not.toHaveProperty(keyword);
      }
    }
  });

  test("computer use tools are gated by the default-on feature flag", () => {
    writeExocortexConfig({ features: { computerUse: true } });
    const enabledTools = getToolDefs().map((tool) => tool.name);
    expect(enabledTools).toContain("computer_list_apps");
    expect(enabledTools).toContain("computer_get_app_state");
    expect(enabledTools).toContain("computer_click");
    expect(buildToolSystemHints()).toContain("Use computer_list_apps");
    expect(getToolDisplayInfo().find((tool) => tool.name === "computer_click")?.color).toBe("#ff79c6");

    writeExocortexConfig({ features: { computerUse: false } });
    const disabledTools = getToolDefs().map((tool) => tool.name);
    expect(disabledTools).not.toContain("computer_list_apps");
    expect(disabledTools).not.toContain("computer_get_app_state");

    writeExocortexConfig({ features: { computerUse: true } });
  });
});
