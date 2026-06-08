import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { resolve } from "path";
import { configuredConversationDefaults, effectiveConversationDefaults, productConversationDefaults, type ExocortexConfig, agentWorkingDirectory } from "./config";
import { agentCwdDir, repoRoot } from "./paths";

describe("agentWorkingDirectory", () => {
  test("defaults to the repo-local agent cwd", () => {
    expect(agentWorkingDirectory({})).toBe(agentCwdDir());
  });

  test("resolves relative paths from the repo root", () => {
    expect(agentWorkingDirectory({ agent: { workingDirectory: "scratch/agent" } }))
      .toBe(resolve(repoRoot(), "scratch/agent"));
  });

  test("expands home-relative paths", () => {
    expect(agentWorkingDirectory({ agent: { workingDirectory: "~/Workspace/playground/" } }))
      .toBe(resolve(homedir(), "Workspace/playground"));
  });

  test("keeps absolute paths absolute", () => {
    expect(agentWorkingDirectory({ agent: { workingDirectory: "/tmp/exocortex-agent" } }))
      .toBe("/tmp/exocortex-agent");
  });
});

describe("conversation defaults config", () => {
  test("uses GPT-5.5 medium fast-off as the product conversation default", () => {
    expect(productConversationDefaults()).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      effort: "medium",
      fastMode: false,
    });
    expect(effectiveConversationDefaults({})).toEqual(productConversationDefaults());
  });

  test("normalizes saved conversation defaults", () => {
    const config: ExocortexConfig = {
      defaults: {
        conversation: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          effort: "max",
          fastMode: true,
        },
      },
    };

    const configured = configuredConversationDefaults(config);
    expect(configured).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      effort: "max",
      fastMode: true,
    });
    expect(configured).not.toBeNull();
    expect(effectiveConversationDefaults(config)).toEqual(configured!);
  });

  test("falls back missing saved fields from the selected provider/model", () => {
    expect(configuredConversationDefaults({ defaults: { conversation: { provider: "openai", model: "gpt-5.5-pro" } } })).toEqual({
      provider: "openai",
      model: "gpt-5.5-pro",
      effort: "medium",
      fastMode: false,
    });
  });
});
