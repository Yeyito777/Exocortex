import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "@exocortex/shared/paths";
import { buildConversationRequestSurface } from "./conversation-request-surface";
import { buildClaudeCodeSystemAppend, buildSystemPrompt } from "./system";
import { createConversation } from "./messages";
import { getConversationToolNames, getToolDefs } from "./tools/registry";
import { registerAppConversation, resetAppRegistryForTests, type AppConversationRecord } from "./app-registry";
import { agentTurnOptions } from "./providers/anthropic/api";
import { loadClaudeSdks } from "./providers/anthropic/sdk";
import { createClaudeStreamState, pushClaudeMessage } from "./providers/anthropic/stream";
import { exocortexToolName } from "./tools/claude-code";
import type { StreamOptions } from "./providers/types";

const GLOBAL = "GLOBAL_INSTRUCTIONS_CANARY";
const lookup = { name: "lookup", description: "Look a word up.", inputSchema: { type: "object", properties: {} } };

function app(convId: string, overrides: Partial<AppConversationRecord> = {}): AppConversationRecord {
  const record: AppConversationRecord = {
    convId,
    app: "demo",
    lifetime: "temporary",
    createdAt: 1,
    lastActivityAt: 1,
    system: { text: "APP_TEXT", base: "none" },
    builtin: [],
    appTools: [lookup],
    ...overrides,
  };
  registerAppConversation(record);
  return record;
}

const surface = (convId: string, provider: "anthropic" | "openai" | "deepseek") => buildConversationRequestSurface(
  createConversation(convId, provider, provider === "anthropic" ? "claude-haiku-5-5" : provider === "openai" ? "gpt-5.4-mini" : "deepseek-v4-pro"),
  { conversationId: convId, workingDirectory: "/work" },
);

beforeAll(async () => {
  writeFileSync(join(configDir(), "system.md"), `${GLOBAL}\n`);
  await loadClaudeSdks();
});
afterAll(() => {
  rmSync(join(configDir(), "system.md"), { force: true });
  resetAppRegistryForTests();
});
beforeEach(() => resetAppRegistryForTests());

describe("ordinary conversations keep their surface", () => {
  test("same prompt and tools as before, and no app surface", () => {
    const openai = surface("plain-openai", "openai");
    expect(openai.claudeCodeApp).toBeUndefined();
    expect(openai.toolNames).toEqual(getConversationToolNames("openai"));
    expect(openai.tools).toEqual(getToolDefs(getConversationToolNames("openai"), "plain-openai", "openai"));
    expect(openai.system).toBe(buildSystemPrompt({
      conversationId: "plain-openai", workingDirectory: "/work", subagentMaxDepth: null,
      toolNames: getConversationToolNames("openai"), provider: "openai", includeExternalToolHints: true,
    }));
    expect(openai.system).toContain(GLOBAL);
    const anthropic = surface("plain-anthropic", "anthropic");
    expect(anthropic.system).toBe(buildClaudeCodeSystemAppend({ includeExternalToolHints: true }));
    expect(anthropic.claudeCodeApp).toBeUndefined();
  });
});

describe("app conversation prompt bases", () => {
  test("none: only the app's text, on every provider", () => {
    app("none-openai");
    app("none-anthropic");
    const openai = surface("none-openai", "openai");
    expect(openai.system).toBe("APP_TEXT");
    expect(openai.toolNames).toEqual(["lookup"]);
    expect(openai.tools).toEqual([{ name: "lookup", description: "Look a word up.", input_schema: lookup.inputSchema }]);
    const anthropic = surface("none-anthropic", "anthropic");
    expect(anthropic.system).toBe("APP_TEXT");
    expect(anthropic.claudeCodeApp).toEqual({ base: "none", tools: [], appTools: [{ name: "lookup", description: "Look a word up.", input_schema: lookup.inputSchema }], ephemeral: false });
  });

  test("agent: the environment header and selected tools' hints, never global instructions or external hints", () => {
    app("agent-openai", { system: { text: "APP_TEXT", base: "agent" }, builtin: ["read"] });
    const openai = surface("agent-openai", "openai");
    expect(openai.system).toStartWith("You are Exo, the user's assistant.\n\nEnvironment:\n- Working directory: /work");
    expect(openai.system).toContain("# Internal tools\n## read\n");
    expect(openai.system).toEndWith("APP_TEXT");
    expect(openai.system).not.toContain(GLOBAL);
    expect(openai.system).not.toContain("# External tools");
    expect(openai.toolNames).toEqual(["read", "view_image", "lookup"]);
    app("agent-anthropic", { system: { text: "APP_TEXT", base: "agent" }, builtin: ["bash", "exo"] });
    const anthropic = surface("agent-anthropic", "anthropic");
    // Claude Code's own preset supplies the rest; Exocortex appends only the app's text.
    expect(anthropic.system).toBe("APP_TEXT");
    expect(anthropic.claudeCodeApp?.tools).toEqual(["Bash"]);
    expect(anthropic.toolNames).toEqual(["exo", "lookup"]);
  });

  test("full: exactly an ordinary conversation's prompt, with the app's text as its instructions", () => {
    app("full-openai", { system: { text: "APP_TEXT", base: "full" }, builtin: "all", appTools: [] });
    const openai = surface("full-openai", "openai");
    expect(openai.system).toBe(buildSystemPrompt({
      conversationInstructions: "APP_TEXT", conversationId: "full-openai", workingDirectory: "/work", subagentMaxDepth: null,
      toolNames: getConversationToolNames("openai"), provider: "openai", includeExternalToolHints: true,
    }));
    expect(openai.system).toContain(GLOBAL);
    app("full-anthropic", { system: { text: "APP_TEXT", base: "full" }, builtin: "all", appTools: [] });
    const anthropic = surface("full-anthropic", "anthropic");
    expect(anthropic.system).toBe(buildClaudeCodeSystemAppend({ conversationInstructions: "APP_TEXT", includeExternalToolHints: true }));
    expect(anthropic.claudeCodeApp).toEqual({ base: "full", appTools: [], ephemeral: false });
  });
});

describe("Claude Code options for app conversations", () => {
  const options = (claudeCodeApp: StreamOptions["claudeCodeApp"], system = "APP_TEXT") => agentTurnOptions(
    "claude-haiku-5-5" as never,
    { system, claudeCodeApp, tools: [], toolExecutor: async () => [] } as unknown as StreamOptions,
    "/work",
    { pending: [], resume: null } as never,
    () => {},
    async () => ({ execute: async () => [] }),
    "main",
    "conv-x",
  );
  const appDefs = [{ name: "lookup", description: "Look a word up.", input_schema: { type: "object" } }];

  test("ordinary turns keep the claude_code preset with every setting source", () => {
    const ordinary = options(undefined, "ADDITIONS");
    expect(ordinary.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "ADDITIONS", snapshot: false });
    expect(ordinary.settingSources).toEqual(["user", "project", "local"]);
    expect(ordinary.tools).toBeUndefined();
    expect(ordinary.strictMcpConfig).toBeUndefined();
    expect(ordinary.persistSession).toBeUndefined();
    expect(ordinary.mcpServers).toBeUndefined();
    expect(ordinary.title).toBeUndefined();
  });

  test("none: a custom prompt, no settings, memory, CLAUDE.md, skills or user MCP servers, only the chosen tools", () => {
    const none = options({ base: "none", tools: ["Read"], appTools: appDefs, ephemeral: true });
    expect(none.systemPrompt).toBe("APP_TEXT");
    expect(none.settingSources).toEqual([]);
    expect(none.strictMcpConfig).toBe(true);
    expect(none.skills).toEqual([]);
    expect(none.tools).toEqual(["Read"]);
    expect(none.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
    expect(Object.keys(none.mcpServers ?? {})).toEqual(["app"]);
    expect(none.persistSession).toBe(false);
    expect(none.hooks).toBeDefined();
    expect(none.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
    expect(typeof none.title).toBe("string");
  });

  test("agent: Claude Code's preset with the app's text appended, still without settings", () => {
    const agent = options({ base: "agent", appTools: [], ephemeral: false });
    expect(agent.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "APP_TEXT", snapshot: false });
    expect(agent.settingSources).toEqual([]);
    expect(agent.tools).toBeUndefined();
    expect(agent.mcpServers).toBeUndefined();
    expect(agent.persistSession).toBeUndefined();
  });

  test("full: the ordinary preset and settings, with the selected tools", () => {
    const full = options({ base: "full", tools: [], appTools: [], ephemeral: false });
    expect(full.settingSources).toEqual(["user", "project", "local"]);
    expect(full.tools).toEqual([]);
    expect(full.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
  });
});

describe("Claude Code app tool calls in history", () => {
  test("mcp__app__ tools take their bare name only in app conversations", () => {
    expect(exocortexToolName("mcp__app__lookup", true)).toBe("lookup");
    expect(exocortexToolName("mcp__app__lookup")).toBe("mcp__app__lookup");
    expect(exocortexToolName("mcp__exocortex__chrono", true)).toBe("chrono");
    expect(exocortexToolName("Bash", true)).toBe("Bash");
  });

  test("the stream records an app tool call under its bare name, styled as the app", () => {
    const calls: unknown[] = [];
    const state = createClaudeStreamState({ onToolCall: (call: unknown) => calls.push(call) } as never, "/work");
    state.appToolCall = (name, input) => name === "lookup" ? { summary: `lookup ${String(input.word)}`, presentation: { toolStyle: { name, label: "demo", color: "#fff" } } } : undefined;
    pushClaudeMessage(state, {
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__app__lookup", input: { word: "zorp" } }] },
    });
    expect(state.blocks).toEqual([expect.objectContaining({ type: "tool_call", id: "toolu_1", name: "lookup", summary: "lookup zorp" })]);
    expect(calls).toEqual([expect.objectContaining({ toolName: "lookup", presentation: { toolStyle: { name: "lookup", label: "demo", color: "#fff" } } })]);
  });
});
