import { beforeEach, describe, expect, test } from "bun:test";
import type { ProviderInfo } from "./messages";
import { clearPreferredProvider } from "./preferences";
import { highlightPromptInput } from "./prompthighlight";
import { createInitialState } from "./state";
import { theme } from "./theme";

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
        supportedEfforts: [{ effort: "high", description: "default" }],
        defaultEffort: "high",
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
        supportedEfforts: [{ effort: "high", description: "default" }],
        defaultEffort: "high",
      },
      {
        id: "gpt-5.3-codex-spark",
        label: "Gpt-5.3-codex-spark",
        maxContext: 128_000,
        supportedEfforts: [{ effort: "medium", description: "default" }],
        defaultEffort: "medium",
      },
    ],
  },
];

describe("prompt highlighting", () => {
  beforeEach(() => {
    clearPreferredProvider();
  });

  test("highlights the full /model command when the model id contains dots", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const input = "/model openai gpt-5.3-codex-spark";
    const [line] = highlightPromptInput(state, [input], input, 120, 0);

    expect(line).toBe(`${theme.command}${input}${theme.reset}`);
  });

  test("highlights custom dotted model ids for providers that allow custom models", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const input = "/model openai my.custom-model";
    const [line] = highlightPromptInput(state, [input], input, 120, 0);

    expect(line).toBe(`${theme.command}${input}${theme.reset}`);
  });

  test("does not highlight an unknown model for providers that disallow custom models", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const input = "/model deepseek deepseek.future-preview";
    const [line] = highlightPromptInput(state, [input], input, 120, 0);

    expect(line).toBe(`${theme.command}/model deepseek${theme.reset} deepseek.future-preview`);
  });

  test("highlights subsequent macros in the same message", () => {
    const state = createInitialState();

    const input = "Use /xenv then /tool install xenv please";
    const [line] = highlightPromptInput(state, [input], input, 120, 0);

    expect(line).toBe(`Use ${theme.command}/xenv${theme.reset} then ${theme.command}/tool install xenv${theme.reset} please`);
  });
});
