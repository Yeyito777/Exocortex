import { describe, expect, mock, test } from "bun:test";
import { createExocortexToolRuntime } from "./exocortex-tool-runtime";
import type { CompleteOptions } from "./llm";

describe("OpenAI family nicknames", () => {
  test("prefers GPT-6 for Sol/Luna while preserving Terra and explicit older IDs", async () => {
    const complete = mock(async (_system: string, _text: string, _options?: CompleteOptions) => ({ text: "OK" }));
    const runtime = createExocortexToolRuntime({
      server: { broadcast: () => {} } as never,
      runTurn: async () => ({ ok: true, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now() }),
      hasCredentials: () => true,
      runCompletion: complete,
    });
    for (const [nickname, model] of [
      ["sol", "gpt-6-sol"],
      ["LUNA", "gpt-6-luna"],
      ["openai/sol", "gpt-6-sol"],
      ["openai/luna", "gpt-6-luna"],
      ["terra", "gpt-5.6-terra"],
      ["gpt-5.6-sol", "gpt-5.6-sol"],
      ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
    ]) {
      const result = await runtime.execute({
        action: "commands", command: "llm", args: { model: nickname, text: "Hello" },
      });
      expect(result.isError).toBe(false);
      expect(complete.mock.calls.at(-1)?.[2]).toMatchObject({ provider: "openai", model, effort: "medium" });
    }
  });
});

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
