import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiToolCall } from "../types";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setToolTextDirForTest, toolTextDir } from "../../tools/tool-text";
import { claudeProcessPrompt, createHostToolServer, hostToolInstructions, type HostToolBinding } from "./host-tools";
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
    expect(client.getInstructions()).toContain("chrono");
    expect(client.getInstructions()).toContain("Never use Claude Code's Agent tool: delegate all subagent work, including search and exploration fan-out, with exo.");
    expect(client.getInstructions()).toContain("Do the user's task yourself by default");
    expect(client.getInstructions()).toContain("default is opus at high effort");
  });

  test("chrono instructions steer toward exact waits and short checks", () => {
    const instructions = hostToolInstructions("chrono")!;
    expect(instructions).toContain("end early when the user sends a message or one of your background tasks finishes");
    expect(instructions).toContain("Prefer wait on the exact task, unit:NAME (systemd user unit) or subagent over a fixed sleep");
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
      writeFileSync(join(dir, "chrono.mcp.md"), "chrono schedules.\n");
      expect(hostToolInstructions("chrono")).toBe("chrono schedules.");
      expect(claudeProcessPrompt("append", [chronoDef, exoDef])).not.toBe(before);
      // exo's server instructions end with its system hint, so a hint edit counts too.
      const withHint = claudeProcessPrompt("append", [chronoDef, exoDef]);
      writeFileSync(join(dir, "exo.hint.md"), "Delegate less.\n");
      expect(hostToolInstructions("exo")).toEndWith("\nDelegate less.");
      expect(claudeProcessPrompt("append", [chronoDef, exoDef])).not.toBe(withHint);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("instructs only on the tools it offers", async () => {
    const client = await connect(createHostToolServer([goalDef], bind(async () => []))!);
    expect(client.getInstructions()).toBeUndefined();
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
