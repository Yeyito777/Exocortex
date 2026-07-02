import { beforeEach, describe, expect, test } from "bun:test";
import type { ConversationSummary, FolderSummary, ProviderInfo } from "./messages";
import { clearPreferredProvider } from "./preferences";
import { highlightPromptInput } from "./prompthighlight";
import { createInitialState } from "./state";
import { theme } from "./theme";

function conversation(id: string, title: string, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    title,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 1,
    ...overrides,
  };
}

function folder(id: string, name: string, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    name,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    sortOrder: 1,
    ...overrides,
  };
}

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

  test("highlights inline commands but not other mid-message slash commands", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";

    const input = "Use /model openai gpt-5.4 and /effort high with /fast on please";
    const [line] = highlightPromptInput(state, [input], input, 120, 0);

    expect(line).toBe(`Use /model openai gpt-5.4 and ${theme.command}/effort high${theme.reset} with ${theme.command}/fast on${theme.reset} please`);
  });

  test("highlights multi-word /queue conversation targets without swallowing message text", () => {
    const state = createInitialState();
    state.sidebar.conversations = [conversation("conv-build", "Build the Thing")];

    const input = "please /queue Build the Thing answer this";
    const [line] = highlightPromptInput(state, [input], input, 120, 0);

    expect(line).toBe(`please ${theme.command}/queue Build the Thing${theme.reset} answer this`);
  });

  test("highlights /queue folder targets selected with the folder icon", () => {
    const state = createInitialState();
    state.sidebar.folders = [folder("folder-work", "Work Projects")];

    const input = "/queue 📁 Work Projects do it";
    const [line] = highlightPromptInput(state, [input], input, 120, 0);

    expect(line).toBe(`${theme.command}/queue 📁 Work Projects${theme.reset} do it`);
  });
});
