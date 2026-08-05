import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { homedir, tmpdir } from "os";
import { createConversation } from "../messages";
import { applyToolPolicyMutation, buildToolPolicySnapshot } from "../tool-policy";
import {
  clearConversationCustomTools,
  ensureConversationCustomTools,
} from "./custom-tools";
import { buildExecutor, buildToolSystemHints, getRegisteredTools, getToolDefs } from "./registry";

const tempDirectories: string[] = [];
const conversationIds: string[] = [];

async function temporaryModule(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exocortex-custom-tools-"));
  tempDirectories.push(directory);
  const path = join(directory, "toolset.ts");
  await writeFile(path, source);
  return path;
}

function toolsetSource(version: string, name = "fixture_search"): string {
  return `
    export default {
      apiVersion: 1,
      id: "fixture.tools",
      create(context) {
        return {
          tools: [{
            name: ${JSON.stringify(name)},
            description: "Search the fixture index",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
            systemHint: "Search the fixture before editing it.",
            parallelSafety: "safe",
            display: { label: "Fixture Search", color: "#12abef" },
            summarize(input) { return { label: "Fixture Search", detail: String(input.query ?? "") }; },
            async execute(input) {
              return {
                output: ${JSON.stringify(version)} + ":" + context.conversationId + ":" + String(input.query),
                isError: false,
              };
            },
          }],
        };
      },
    };
  `;
}

afterEach(async () => {
  await Promise.all(conversationIds.splice(0).map((id) => clearConversationCustomTools(id)));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("conversation-scoped custom tools", () => {
  test("expands a leading ~/ in module paths", async () => {
    const path = await temporaryModule(toolsetSource("home-path"));
    const homeRelativePath = `~/${relative(homedir(), path)}`;
    const conversation = createConversation("custom-home-path", "openai", "gpt-5.6-sol");
    conversationIds.push(conversation.id);

    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [homeRelativePath],
    });

    expect(conversation.toolPolicy?.customToolModules?.[0]?.path).toBe(path);
    expect(conversation.toolPolicy?.internal).toContain("fixture_search");
  });

  test("enables a TypeScript toolset for exactly one conversation", async () => {
    const path = await temporaryModule(toolsetSource("v1"));
    const conversation = createConversation("custom-one", "openai", "gpt-5.6-sol");
    const other = createConversation("custom-other", "openai", "gpt-5.6-sol");
    conversationIds.push(conversation.id, other.id);

    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [path],
    });

    expect(conversation.toolPolicy?.internal).toContain("fixture_search");
    expect(conversation.toolPolicy?.customToolModules).toHaveLength(1);
    expect(conversation.toolPolicy?.customToolModules?.[0]).toMatchObject({
      path,
      id: "fixture.tools",
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      tools: [{ name: "fixture_search", label: "Fixture Search", color: "#12abef" }],
    });
    expect(getToolDefs(conversation.toolPolicy!.internal, conversation.id).map((tool) => tool.name)).toContain("fixture_search");
    expect(getToolDefs(undefined, other.id).map((tool) => tool.name)).not.toContain("fixture_search");
    expect(buildToolSystemHints(conversation.toolPolicy!.internal, conversation.id)).toContain("Search the fixture before editing it.");

    const executor = buildExecutor({ conversationId: conversation.id }, conversation.toolPolicy!.internal);
    const [result] = await executor([{
      id: "custom-call",
      name: "fixture_search",
      input: { query: "copper" },
    }]);
    expect(result).toMatchObject({ output: "v1:custom-one:copper", isError: false });

    const snapshot = buildToolPolicySnapshot(conversation);
    expect(snapshot.internal.find((tool) => tool.name === "fixture_search")).toMatchObject({
      enabled: true,
      modulePath: path,
    });
    expect(snapshot.modules).toEqual([expect.objectContaining({ path, tools: ["fixture_search"] })]);
  });

  test("pins the entry digest across lazy reload and accepts changes only when re-enabled", async () => {
    const path = await temporaryModule(toolsetSource("v1"));
    const conversation = createConversation("custom-digest", "openai", "gpt-5.6-sol");
    conversationIds.push(conversation.id);
    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [path],
    });
    const firstDigest = conversation.toolPolicy!.customToolModules![0]!.digest;

    await clearConversationCustomTools(conversation.id);
    await writeFile(path, toolsetSource("v2"));
    await expect(ensureConversationCustomTools(
      conversation,
      getRegisteredTools().map((tool) => tool.name),
    )).rejects.toThrow("changed since it was enabled");

    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [path],
    });
    expect(conversation.toolPolicy!.customToolModules![0]!.digest).not.toBe(firstDigest);
    const executor = buildExecutor({ conversationId: conversation.id }, ["fixture_search"]);
    const [result] = await executor([{
      id: "changed-call",
      name: "fixture_search",
      input: { query: "lapis" },
    }]);
    expect(result.output).toBe("v2:custom-digest:lapis");
  });

  test("pins statically imported local dependencies, not only the entry file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exocortex-custom-tools-dependency-"));
    tempDirectories.push(directory);
    const helperPath = join(directory, "version.ts");
    const modulePath = join(directory, "toolset.ts");
    await writeFile(helperPath, `export const version = "dependency-v1";\n`);
    await writeFile(modulePath, `
      import { version } from "./version";
      export default {
        name: "dependency_fixture",
        description: "Read a dependency-backed fixture version",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        display: { label: "Dependency Fixture", color: "#abcdef" },
        summarize() { return { label: "Dependency Fixture", detail: "" }; },
        async execute() { return { output: version, isError: false }; },
      };
    `);
    const conversation = createConversation("custom-dependency", "openai", "gpt-5.6-sol");
    conversationIds.push(conversation.id);
    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [modulePath],
    });

    await clearConversationCustomTools(conversation.id);
    await writeFile(helperPath, `export const version = "dependency-v2";\n`);
    await expect(ensureConversationCustomTools(
      conversation,
      getRegisteredTools().map((tool) => tool.name),
    )).rejects.toThrow("changed since it was enabled");

    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [modulePath],
    });
    const executor = buildExecutor({ conversationId: conversation.id }, ["dependency_fixture"]);
    const [result] = await executor([{
      id: "dependency-call",
      name: "dependency_fixture",
      input: {},
    }]);
    expect(result.output).toBe("dependency-v2");
  });

  test("detaches a module by path and rejects built-in name collisions", async () => {
    const path = await temporaryModule(toolsetSource("v1"));
    const conversation = createConversation("custom-disable", "openai", "gpt-5.6-sol");
    conversationIds.push(conversation.id);
    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [path],
    });

    conversation.toolPolicy = await applyToolPolicyMutation(conversation, {
      action: "disable",
      tools: [],
      modulePaths: [path],
    });
    expect(conversation.toolPolicy?.customToolModules).toBeUndefined();
    expect(conversation.toolPolicy?.internal).not.toContain("fixture_search");
    expect(getToolDefs(undefined, conversation.id).map((tool) => tool.name)).not.toContain("fixture_search");

    const conflicting = await temporaryModule(toolsetSource("bad", "read"));
    await expect(applyToolPolicyMutation(conversation, {
      action: "enable",
      tools: [],
      modulePaths: [conflicting],
    })).rejects.toThrow("conflicts with a built-in tool: read");
  });
});
