import { describe, expect, test } from "bun:test";
import { tryCommand } from "./commands";
import { applyInlineCommands } from "./inlineeffort";
import { createInitialState } from "./state";
import type { ProviderInfo } from "./messages";

const providers: ProviderInfo[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-v4-pro",
    allowsCustomModels: false,
    supportsFastMode: false,
    models: [
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        maxContext: 1_000_000,
        supportedEfforts: [
          { effort: "max", description: "Deep" },
        ],
        defaultEffort: "max",
      },
    ],
  },
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

    const result = applyInlineCommands("please /effort high answer this", state);

    expect(result).toEqual({ text: "please answer this", efforts: ["high"], fastModes: [] });
    expect(state.effort).toBe("high");
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Effort set to high");
  });

  test("honors the last valid inline effort while preserving message boundaries", () => {
    const state = stateWithEfforts();

    const result = applyInlineCommands("first\n/effort medium\nsecond /effort high third", state);

    expect(result).toEqual({ text: "first\nsecond third", efforts: ["medium", "high"], fastModes: [] });
    expect(state.effort).toBe("high");
  });

  test("leaves unsupported inline effort tokens as message text", () => {
    const state = stateWithEfforts();

    const result = applyInlineCommands("please /effort max answer", state);

    expect(result).toEqual({ text: "please /effort max answer", efforts: [], fastModes: [] });
    expect(state.effort).toBe("low");
    expect(state.messages).toEqual([]);
  });

  test("does not let multiline /effort prompts get swallowed by standalone command handling", () => {
    const state = stateWithEfforts();

    expect(tryCommand("/effort high\nanswer this", state)).toBeNull();
  });
});

describe("inline /fast command", () => {
  test("sets fast mode and removes the command from the message text", () => {
    const state = stateWithEfforts();
    state.fastMode = false;

    const result = applyInlineCommands("please /fast on answer this", state);

    expect(result).toEqual({ text: "please answer this", efforts: [], fastModes: [true] });
    expect(state.fastMode).toBe(true);
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Fast mode enabled.");
  });

  test("toggles fast mode without an inline argument", () => {
    const state = stateWithEfforts();
    state.fastMode = false;

    const result = applyInlineCommands("please /fast answer this", state);

    expect(result).toEqual({ text: "please answer this", efforts: [], fastModes: [true] });
    expect(state.fastMode).toBe(true);
  });

  test("honors the last inline fast mode while preserving message boundaries", () => {
    const state = stateWithEfforts();
    state.fastMode = false;

    const result = applyInlineCommands("first\n/fast on\nsecond /fast off third", state);

    expect(result).toEqual({ text: "first\nsecond third", efforts: [], fastModes: [true, false] });
    expect(state.fastMode).toBe(false);
  });

  test("leaves inline fast tokens as message text when the provider does not support fast mode", () => {
    const state = stateWithEfforts();
    state.provider = "deepseek";
    state.model = "deepseek-v4-pro";
    state.fastMode = false;

    const result = applyInlineCommands("please /fast on answer", state);

    expect(result).toEqual({ text: "please /fast on answer", efforts: [], fastModes: [] });
    expect(state.fastMode).toBe(false);
    expect(state.messages).toEqual([]);
  });

  test("does not let multiline /fast prompts get swallowed by standalone command handling", () => {
    const state = stateWithEfforts();

    expect(tryCommand("/fast on\nanswer this", state)).toBeNull();
  });
});

describe("inline /queue command", () => {
  test("marks the message for the global idle queue and removes the command token", () => {
    const state = stateWithEfforts();

    const result = applyInlineCommands("please /queue answer this", state);

    expect(result).toEqual({ text: "please answer this", efforts: [], fastModes: [], queue: true });
    expect(state.messages).toEqual([]);
  });

  test("preserves message boundaries when /queue appears on its own line", () => {
    const state = stateWithEfforts();

    const result = applyInlineCommands("first\n/queue\nsecond", state);

    expect(result).toEqual({ text: "first\nsecond", efforts: [], fastModes: [], queue: true });
  });

  test("does not let message-leading /queue prompts get swallowed by standalone command handling", () => {
    const state = stateWithEfforts();

    expect(tryCommand("/queue hello", state)).toBeNull();
  });
});
