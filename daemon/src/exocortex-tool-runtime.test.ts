import { describe, expect, mock, test } from "bun:test";
import { createExocortexToolRuntime } from "./exocortex-tool-runtime";

function runtimeWithStop(stopCall = mock(async (_convId: string) => {})) {
  const runtime = createExocortexToolRuntime({
    server: {} as never,
    runTurn: async () => ({ ok: true, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now() }),
    stopCall,
  });
  return { runtime, stopCall };
}

describe("native Exocortex hangup command", () => {
  test("is discoverable with a minimal argument schema", async () => {
    const { runtime } = runtimeWithStop();

    const listing = await runtime.execute({ action: "commands", command: "ls" }, "conv-call");
    expect(listing.isError).toBe(false);
    expect(JSON.parse(listing.output).commands).toContainEqual(expect.objectContaining({
      name: "hangup",
      description: expect.stringContaining("End the realtime call"),
    }));

    const help = await runtime.execute({
      action: "commands",
      command: "help",
      args: { command: "hangup" },
    }, "conv-call");
    expect(help.isError).toBe(false);
    expect(JSON.parse(help.output)).toMatchObject({
      command: "hangup",
      input_schema: {
        type: "object",
        properties: { conversation_id: { type: "string" } },
        additionalProperties: false,
      },
    });
  });

  test("hangs up the active conversation by default", async () => {
    const { runtime, stopCall } = runtimeWithStop();

    const result = await runtime.execute({
      action: "commands",
      command: "hangup",
      args: {},
    }, "conv-call");

    expect(result).toEqual({
      output: JSON.stringify({ hung_up: true, conversation_id: "conv-call" }, null, 2),
      isError: false,
    });
    expect(stopCall).toHaveBeenCalledWith("conv-call");
  });

  test("accepts an explicit owning conversation", async () => {
    const { runtime, stopCall } = runtimeWithStop();

    await runtime.execute({
      action: "commands",
      command: "hangup",
      args: { conversation_id: "other-call" },
    }, "conv-call");

    expect(stopCall).toHaveBeenCalledWith("other-call");
  });
});
