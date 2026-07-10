import { afterEach, describe, expect, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { buildToolSystemHints, getToolDefs, getToolDisplayInfo } from "./registry";

afterEach(() => {
  writeExocortexConfig(defaultExocortexConfig());
});

describe("tool availability", () => {
  test("context compaction is daemon-managed and not exposed as a model tool", () => {
    expect(getToolDefs().map((tool) => tool.name)).not.toContain("context");
    expect(getToolDisplayInfo().map((tool) => tool.name)).not.toContain("context");
    expect(buildToolSystemHints()).not.toContain("context list");
  });

  test("image generation and file transcription are external CLI tools, not internal API tools", () => {
    expect(getToolDefs().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(getToolDefs().some((tool) => tool.name === "transcribe_audio")).toBe(false);
    expect(getToolDisplayInfo().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(getToolDisplayInfo().some((tool) => tool.name === "transcribe_audio")).toBe(false);
    expect(buildToolSystemHints()).not.toContain("Use image generation to create assets");
    expect(buildToolSystemHints()).not.toContain("Use audio transcription");
  });

  test("native exo management is available while transcription remains external", () => {
    const definition = getToolDefs().find((tool) => tool.name === "exo");
    expect(definition).toBeTruthy();
    const actionEnum = (definition?.input_schema.properties as Record<string, { enum?: string[] }>).action.enum;
    expect(actionEnum).toContain("send");
    expect(actionEnum).toContain("commands");
    expect(actionEnum).not.toContain("transcribe");
    expect(actionEnum).not.toContain("llm");
    expect(actionEnum).not.toContain("folder_mkdir");
    expect(actionEnum).not.toContain("rename");
    expect(actionEnum).not.toContain("delete");
    expect(actionEnum).not.toContain("status");
    expect(JSON.stringify(definition?.input_schema)).not.toContain("system_prompt");
    expect(getToolDisplayInfo().find((tool) => tool.name === "exo")?.label).toBe("Exocortex");
    expect(buildToolSystemHints()).toContain("Use the native `exo` tool");
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

  test("computer use tools are gated by an opt-in feature flag", () => {
    writeExocortexConfig({});
    const defaultTools = getToolDefs().map((tool) => tool.name);
    expect(defaultTools).not.toContain("computer_list_apps");
    expect(defaultTools).not.toContain("computer_get_app_state");

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
  });

  test("goal tool is enabled by default and can be disabled by feature flag", () => {
    writeExocortexConfig({});
    const defaultTools = getToolDefs().map((tool) => tool.name);
    expect(defaultTools).toContain("goal");
    expect(getToolDisplayInfo().some((tool) => tool.name === "goal")).toBe(true);
    expect(buildToolSystemHints()).toContain("Only set a goal when");

    writeExocortexConfig({ features: { goalTool: false } });
    const disabledTools = getToolDefs().map((tool) => tool.name);
    expect(disabledTools).not.toContain("goal");
    expect(getToolDisplayInfo().some((tool) => tool.name === "goal")).toBe(false);
    expect(buildToolSystemHints()).not.toContain("Only set a goal when");

    writeExocortexConfig({ features: { goalTool: true } });
    const enabledTools = getToolDefs().map((tool) => tool.name);
    expect(enabledTools).toContain("goal");
  });
});
