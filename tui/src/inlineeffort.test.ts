import { describe, expect, test } from "bun:test";
import { tryCommand } from "./commands";
import { applyInlineEffortCommands } from "./inlineeffort";
import { createInitialState } from "./state";
import type { ProviderInfo } from "./messages";

const providers: ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-5.4",
    allowsCustomModels: true,
    supportsFastMode: true,
    models: [
      {
        id: "gpt-5.4",
        label: "Gpt-5.4",
        maxContext: 272_000,
        supportedEfforts: [
          { effort: "low", description: "Fast" },
          { effort: "medium", description: "Balanced" },
          { effort: "high", description: "Deep" },
        ],
        defaultEffort: "medium",
      },
    ],
  },
];

function stateWithEfforts() {
  const state = createInitialState();
  state.providerRegistry = structuredClone(providers);
  state.provider = "openai";
  state.model = "gpt-5.4";
  state.effort = "low";
  return state;
}

describe("inline /effort command", () => {
  test("sets effort and removes the command from the message text", () => {
    const state = stateWithEfforts();

    const result = applyInlineEffortCommands("please /effort high answer this", state);

    expect(result).toEqual({ text: "please answer this", efforts: ["high"] });
    expect(state.effort).toBe("high");
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Effort set to high");
  });

  test("honors the last valid inline effort while preserving message boundaries", () => {
    const state = stateWithEfforts();

    const result = applyInlineEffortCommands("first\n/effort medium\nsecond /effort high third", state);

    expect(result).toEqual({ text: "first\nsecond third", efforts: ["medium", "high"] });
    expect(state.effort).toBe("high");
  });

  test("leaves unsupported inline effort tokens as message text", () => {
    const state = stateWithEfforts();

    const result = applyInlineEffortCommands("please /effort max answer", state);

    expect(result).toEqual({ text: "please /effort max answer", efforts: [] });
    expect(state.effort).toBe("low");
    expect(state.messages).toEqual([]);
  });

  test("does not let multiline /effort prompts get swallowed by standalone command handling", () => {
    const state = stateWithEfforts();

    expect(tryCommand("/effort high\nanswer this", state)).toBeNull();
  });
});

