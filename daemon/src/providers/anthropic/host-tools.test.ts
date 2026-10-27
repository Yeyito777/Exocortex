import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiToolCall } from "../types";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setToolTextDirForTest, toolTextDir } from "../../tools/tool-text";
import { claudeProcessPrompt, createHostToolServer, hostToolInstructions, hostToolServerInstructions, type HostToolBinding } from "./host-tools";
import { getRegisteredTools, toolHint } from "../../tools/registry";
import { isClaudeCodeHostTool } from "../../tools/claude-code";
import { loadClaudeSdks } from "./sdk";

beforeAll(async () => { await loadClaudeSdks(); });

const chronoDef = { name: "chrono", description: "Schedule things.", input_schema: { type: "object" as const, properties: { action: { type: "string" } } } };
const goalDef = { name: "goal", description: "Report on the goal.", input_schema: { type: "object" as const, properties: { action: { type: "string" } } } };
const exoDef = { name: "exo", description: "Start a subagent.", input_schema: { type: "object" as const, properties: { subagent: { type: "string" } } } };
const bashDef = { name: "bash", description: "Run a command.", input_schema: { type: "object" } };

const bind = (execute: HostToolBinding["execute"]) => async () => ({ execute });

async function connect(config: NonNullable<ReturnType<typeof createHostToolServer>>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("Claude Code host tools", () => {
  test("offers nothing without an executor or a host tool in the turn's tool surface", () => {
    expect(createHostToolServer([chronoDef], null)).toBeNull();
    expect(createHostToolServer([bashDef], bind(async () => []))).toBeNull();
  });

  test("lists only host tools, kept out of Claude Code's tool search", async () => {
    const client = await connect(createHostToolServer([bashDef, chronoDef, goalDef, exoDef], bind(async () => []))!);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      { name: "chrono", description: "Schedule things.", inputSchema: chronoDef.input_schema, _meta: { "anthropic/alwaysLoad": true } },
      { name: "goal", description: "Report on the goal.", inputSchema: goalDef.input_schema, _meta: { "anthropic/alwaysLoad": true } },
      { name: "exo", description: "Start a subagent.", inputSchema: exoDef.input_schema, _meta: { "anthropic/alwaysLoad": true } },
    ]);
    // Each offered host tool's hint, under its name; bash is not a host tool.
    expect(client.getInstructions()).toBe(hostToolServerInstructions([chronoDef, goalDef, exoDef]));
    expect(client.getInstructions()).toContain(`### chrono\n${hostToolInstructions("chrono")}`);
    expect(client.getInstructions()).toContain(`### goal\n${hostToolInstructions("goal")}`);
    expect(client.getInstructions()).toContain("### exo\nDo the user's task yourself by default");
    expect(client.getInstructions()).toContain("Never use Claude Code's Agent tool or another built-in subagent tool: delegate all subagent work, including search and exploration fan-out, with exo.");
    expect(client.getInstructions()).toContain("default is opus at high effort");
    expect(client.getInstructions()).not.toContain("### bash");
  });

  test("every host tool's hint reaches the MCP server instructions", async () => {
    const hostTools = getRegisteredTools().filter(tool => isClaudeCodeHostTool(tool.name));
    expect(hostTools.map(tool => tool.name)).toEqual(expect.arrayContaining(["chrono", "goal", "exo", "client_bash", "remote_bash", "attach"]));
    const defs = hostTools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
    const dir = mkdtempSync(join(tmpdir(), "host-tool-hints-"));
    cpSync(toolTextDir(), dir, { recursive: true });
    const restore = setToolTextDirForTest(dir);
    try {
      // Tools without a hint get one too: whatever the owner writes must reach Claude.
      for (const tool of hostTools) writeFileSync(join(dir, `${tool.name}.hint.md`), `Hint for ${tool.name}.\n`);
      const client = await connect(createHostToolServer(defs, bind(async () => []))!);
      for (const tool of hostTools) expect(client.getInstructions()).toContain(`### ${tool.name}\nHint for ${tool.name}.`);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
    // With the real files, each host tool that has a hint is in there word for word.
    const instructions = hostToolServerInstructions(defs);
    for (const tool of hostTools) {
      const hint = toolHint(tool, "anthropic");
      if (hint) expect(instructions).toContain(`### ${tool.name}\n${hint}`);
    }
    expect(instructions).toContain("### goal\nGoals are user-owned persistent objectives.");
  });

  test("chrono instructions steer toward exact waits and short checks", () => {
    const instructions = hostToolInstructions("chrono")!;
    expect(instructions).toContain("use it instead of shell sleep, cron, or polling loops");
    expect(instructions).toContain("prefer it on the exact task, unit:NAME (systemd user unit) or subagent over a fixed sleep");
    expect(instructions).toContain("at most ~5–10 min per check");
  });

  test("a running process's fingerprint changes when its tools' text does, so the next turn picks it up", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-tool-text-"));
    cpSync(toolTextDir(), dir, { recursive: true });
    const restore = setToolTextDirForTest(dir);
    try {
      const before = claudeProcessPrompt("append", [chronoDef, exoDef]);
      expect(claudeProcessPrompt("append", [chronoDef, exoDef])).toBe(before);
      expect(claudeProcessPrompt("append", [])).toBe("append");
      writeFileSync(join(dir, "chrono.hint.md"), "chrono schedules.\n");
      expect(hostToolInstructions("chrono")).toBe("chrono schedules.");
      expect(claudeProcessPrompt("append", [chronoDef, exoDef])).not.toBe(before);
      const withHint = claudeProcessPrompt("append", [chronoDef, exoDef]);
      writeFileSync(join(dir, "exo.hint.md"), "Delegate less.\n");
      expect(hostToolInstructions("exo")).toBe("Delegate less.");
      expect(claudeProcessPrompt("append", [chronoDef, exoDef])).not.toBe(withHint);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("instructs only on the tools it offers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-tool-text-"));
    cpSync(toolTextDir(), dir, { recursive: true });
    const restore = setToolTextDirForTest(dir);
    try {
      writeFileSync(join(dir, "attach.hint.md"), "");
      const client = await connect(createHostToolServer([{ ...goalDef, name: "attach" }], bind(async () => []))!);
      expect(client.getInstructions()).toBeUndefined();
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs calls through the Exocortex executor under Claude Code's tool_use id", async () => {
    const calls: ApiToolCall[] = [];
    const server = createHostToolServer([chronoDef], bind(async (batch) => {
      calls.push(...batch);
      return batch.map(call => ({ toolCallId: call.id, toolName: call.name, output: "No Chrono schedules for this conversation.", isError: false }));
    }))!;
    expect(server).toMatchObject({ type: "sdk", name: "exocortex" });
    const client = await connect(server);

    const result = await client.callTool({ name: "chrono", arguments: { action: "list" }, _meta: { "claudecode/toolUseId": "toolu_1" } });
    expect(calls).toEqual([{ id: "toolu_1", name: "chrono", input: { action: "list" } }]);
    expect(result).toMatchObject({ content: [{ type: "text", text: "No Chrono schedules for this conversation." }], isError: false });
  });

  test("refuses tools outside the host set", async () => {
    const client = await connect(createHostToolServer([bashDef, chronoDef], bind(async () => []))!);
    const result = await client.callTool({ name: "bash", arguments: { command: "ls" } });
    expect(result).toMatchObject({ isError: true });
  });

  test("reports a call no Exocortex turn can run", async () => {
    const client = await connect(createHostToolServer([chronoDef], async () => { throw new Error("No Exocortex turn is attached."); })!);
    const result = await client.callTool({ name: "chrono", arguments: { action: "list" } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "No Exocortex turn is attached." }], isError: true });
  });
});
