import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiToolCall } from "../types";
import { createHostToolServer, type HostToolBinding } from "./host-tools";

const chronoDef = { name: "chrono", description: "Schedule things.", input_schema: { type: "object" as const, properties: { action: { type: "string" } } } };
const goalDef = { name: "goal", description: "Report on the goal.", input_schema: { type: "object" as const, properties: { action: { type: "string" } } } };
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
    const client = await connect(createHostToolServer([bashDef, chronoDef, goalDef], bind(async () => []))!);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      { name: "chrono", description: "Schedule things.", inputSchema: chronoDef.input_schema, _meta: { "anthropic/alwaysLoad": true } },
      { name: "goal", description: "Report on the goal.", inputSchema: goalDef.input_schema, _meta: { "anthropic/alwaysLoad": true } },
    ]);
    expect(client.getInstructions()).toContain("chrono");
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
