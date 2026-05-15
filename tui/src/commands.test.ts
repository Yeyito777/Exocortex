import { beforeEach, describe, expect, test } from "bun:test";
import { defaultExocortexConfig, readExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { getCommandArgs, tryCommand } from "./commands";
import { clearPreferredProvider } from "./preferences";
import { createInitialState } from "./state";
import { DEFAULT_EFFORT, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, type ProviderInfo, type TokenStatsSnapshot, type TokenUsageTotals } from "./messages";
import { theme } from "./theme";

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
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-v4-pro",
    allowsCustomModels: true,
    supportsFastMode: false,
    models: [
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        maxContext: 1_000_000,
        supportedEfforts: [
          { effort: "none", description: "Off" },
          { effort: "high", description: "Deep" },
          { effort: "max", description: "Max" },
        ],
        defaultEffort: "high",
        supportsImages: false,
      },
    ],
  },
];

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const todayDate = new Date();
todayDate.setHours(0, 0, 0, 0);
const yesterdayDate = new Date(todayDate);
yesterdayDate.setDate(yesterdayDate.getDate() - 1);
const todayKey = localDayKey(todayDate);
const yesterdayKey = localDayKey(yesterdayDate);

function totals(inputTokens: number, outputTokens: number, requests: number, cachedInputTokens = 0, uncachedInputTokens = 0): TokenUsageTotals {
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requests,
  };
}

const tokenStats: TokenStatsSnapshot = {
  updatedAt: Date.now(),
  today: {
    day: todayKey,
    ...totals(1_500, 500, 3, 1_000, 500),
    byProvider: {
      openai: totals(1_500, 500, 3, 1_000, 500),
    },
    byModel: {
      "gpt-5.4": totals(1_200, 400, 2, 1_000, 200),
      "deepseek-v4-pro": totals(300, 100, 1),
    },
    bySource: {
      conversation: totals(1_200, 400, 2, 1_000, 200),
      title_generation: totals(300, 100, 1),
    },
  },
  lifetime: {
    ...totals(2_200, 800, 5, 1_200, 700),
    byProvider: {
      openai: totals(1_900, 700, 4, 1_200, 700),
      deepseek: totals(300, 100, 1),
    },
    byModel: {
      "gpt-5.4": totals(1_600, 600, 3, 1_200, 400),
      "deepseek-v4-pro": totals(600, 200, 2),
    },
    bySource: {
      conversation: totals(1_900, 700, 4, 1_200, 700),
      title_generation: totals(300, 100, 1),
    },
  },
  days: [
    {
      day: todayKey,
      ...totals(1_500, 500, 3, 1_000, 500),
      byProvider: {
        openai: totals(1_500, 500, 3, 1_000, 500),
      },
      byModel: {
        "gpt-5.4": totals(1_200, 400, 2, 1_000, 200),
        "deepseek-v4-pro": totals(300, 100, 1),
      },
      bySource: {
        conversation: totals(1_200, 400, 2, 1_000, 200),
        title_generation: totals(300, 100, 1),
      },
    },
    {
      day: yesterdayKey,
      ...totals(700, 300, 2, 200, 200),
      byProvider: {
        openai: totals(400, 200, 1, 200, 200),
        deepseek: totals(300, 100, 1),
      },
      byModel: {
        "gpt-5.4": totals(400, 200, 1, 200, 200),
        "deepseek-v4-pro": totals(300, 100, 1),
      },
      bySource: {
        conversation: totals(700, 300, 2, 200, 200),
      },
    },
  ],
};

beforeEach(() => {
  clearPreferredProvider();
  writeExocortexConfig(defaultExocortexConfig());
});

describe("/new", () => {
  test("resets pending conversation settings to product defaults", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "deepseek";
    state.model = "deepseek-v4-pro";
    state.effort = "max";
    state.fastMode = true;
    state.hasChosenProvider = true;
    state.contextTokens = 42_000;
    state.messages.push({ role: "user", text: "old chat", metadata: null });

    const result = tryCommand("/new", state);

    expect(result).toEqual({ type: "new_conversation" });
    expect(state.messages).toEqual([]);
    expect(state.contextTokens).toBeNull();
    expect(String(state.provider)).toBe(DEFAULT_PROVIDER_ID);
    expect(String(state.model)).toBe(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    expect(String(state.effort)).toBe(DEFAULT_EFFORT);
    expect(state.fastMode).toBe(false);
    expect(state.hasChosenProvider).toBe(true);
  });
});

describe("/fast command", () => {
  test("enables fast mode for supported providers", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.convId = "conv-openai";

    const result = tryCommand("/fast on", state);

    expect(result).toEqual({ type: "fast_mode_changed", enabled: true });
    expect(state.fastMode).toBe(true);
    expect(state.messages.at(-1)?.role).toBe("system");
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toContain("Fast mode enabled");
  });

  test("reports unsupported providers without mutating fast mode", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "deepseek";
    state.model = "deepseek-v4-pro";
    state.fastMode = false;

    const result = tryCommand("/fast on", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.fastMode).toBe(false);
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Fast mode is only available for deepseek conversations that support it.");
  });

  test("toggles fast mode when called without arguments", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.fastMode = true;
    state.convId = "conv-openai";

    const result = tryCommand("/fast", state);

    expect(result).toEqual({ type: "fast_mode_changed", enabled: false });
    expect(state.fastMode).toBe(false);
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Fast mode disabled.");
  });

  test("rejects the deprecated toggle argument", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.fastMode = false;

    const result = tryCommand("/fast toggle", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.fastMode).toBe(false);
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Usage: /fast [on|off]");
  });
});

describe("/replay", () => {
  test("returns a replay request for the active conversation", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    state.messages.push(
      { role: "user", text: "hello", metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.4", tokens: 0 } },
      { role: "assistant", blocks: [{ type: "text", text: "partial" }], metadata: { startedAt: 2, endedAt: 3, model: "gpt-5.4", tokens: 12 } },
    );

    const result = tryCommand("/replay", state);

    expect(result).toEqual({ type: "replay_requested" });
    expect(state.messages).toHaveLength(2);
  });

  test("requires an active conversation", () => {
    const state = createInitialState();

    const result = tryCommand("/replay", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("No active conversation to replay.");
  });

  test("rejects replay while streaming", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    state.messages.push({ role: "user", text: "hello", metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.4", tokens: 0 } });
    state.pendingAI = { role: "assistant", blocks: [], metadata: null };

    const result = tryCommand("/replay", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.streamingTailMessages.at(-1) as { text?: string } | undefined)?.text).toBe("Cannot replay the conversation while it is streaming.");
  });

  test("requires existing conversation history", () => {
    const state = createInitialState();
    state.convId = "conv-replay";

    const result = tryCommand("/replay", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("No conversation history to replay.");
  });

  test("shows usage when extra arguments are provided", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    state.messages.push({ role: "user", text: "hello", metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.4", tokens: 0 } });

    const result = tryCommand("/replay now", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Usage: /replay");
  });
});

describe("/model", () => {
  test("switches an active conversation across providers and normalizes effort/fast mode", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.effort = "low";
    state.fastMode = true;
    state.contextTokens = 12_345;
    state.convId = "conv-openai";

    const result = tryCommand("/model deepseek deepseek-v4-pro", state);

    expect(result).toEqual({ type: "model_changed", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(String(state.provider)).toBe("deepseek");
    expect(String(state.model)).toBe("deepseek-v4-pro");
    expect(String(state.effort)).toBe("high");
    expect(state.fastMode).toBe(false);
    expect(state.contextTokens).toBeNull();
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Model set to deepseek/deepseek-v4-pro (effort high) (fast off)");
  });

  test("warns when switching to a model with a smaller known context window", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "deepseek";
    state.model = "deepseek-v4-pro";
    state.contextTokens = 500_000;
    state.convId = "conv-deepseek";

    const result = tryCommand("/model openai gpt-5.4", state);

    expect(result).toEqual({ type: "model_changed", provider: "openai", model: "gpt-5.4" });
    const warning = state.messages.at(-1) as { text?: string; color?: string } | undefined;
    expect(warning?.text ?? "").toContain("last known context (500,000 tokens) exceeds openai/gpt-5.4's max context (272,000)");
    expect(warning?.color).toBe(theme.warning);
    expect(state.contextTokens).toBeNull();
  });

  test("rejects provider/model changes while streaming", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.convId = "conv-openai";
    state.pendingAI = { role: "assistant", blocks: [], metadata: null };

    const result = tryCommand("/model deepseek deepseek-v4-pro", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.4");
    expect((state.streamingTailMessages.at(-1) as { text?: string } | undefined)?.text).toBe("Cannot switch provider/model while this conversation is streaming.");
  });
});

describe("/trim", () => {
  test("shows help when called without arguments", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.contextTokens = 42_000;

    const result = tryCommand("/trim", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Current context: 42,000 / 272,000 tokens");
    expect(text).toContain("/trim messages <n>");
    expect(text).toContain("/trim thinking <n>");
    expect(text).toContain("/trim toolresults <n>");
  });

  test("returns a trim request for valid input", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.convId = "conv-openai";

    const result = tryCommand("/trim thinking 5", state);

    expect(result).toEqual({ type: "trim_requested", mode: "thinking", count: 5 });
  });

  test("requires an active conversation", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const result = tryCommand("/trim messages 3", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("No active conversation to trim.");
  });

  test("rejects trimming while streaming", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.convId = "conv-openai";
    state.pendingAI = { role: "assistant", blocks: [], metadata: null };

    const result = tryCommand("/trim toolresults 2", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.streamingTailMessages.at(-1) as { text?: string } | undefined)?.text).toBe("Cannot trim the conversation while it is streaming.");
  });

  test("rejects non-positive counts", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.convId = "conv-openai";

    const result = tryCommand("/trim messages 0", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Trim count must be a positive integer.");
  });
});

describe("/tokens", () => {
  test("shows a github-style heatmap and bottom summary stats from cached stats", () => {
    const state = createInitialState();
    state.tokenStats = structuredClone(tokenStats);

    const result = tryCommand("/tokens 2", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).not.toContain("Top models today:");
    expect(text).not.toContain("Top models lifetime:");
    expect(text).not.toContain("Sources today:");
    expect(text).toContain("Heatmap (");
    expect(text).not.toContain("max ");
    expect(text).toContain("Less");
    expect(text).toContain("More");
    expect(text).toContain("■");
    expect(text).toContain(`Tokens today: \x1b[38;2;`);
    expect(text).toContain("2,000");
    expect(text).toContain("Maximum tokens:");
    expect(text).toContain("Average tokens:");
    expect(text).toContain("1,500");
    expect(text).toContain("Lifetime tokens:");
    expect(text).toContain("3,000");
  });

  test("averages only across active days in the displayed range", () => {
    const state = createInitialState();
    const sparseStats = structuredClone(tokenStats);
    sparseStats.lifetime = structuredClone(tokenStats.today);
    sparseStats.days = [structuredClone(tokenStats.today)];
    state.tokenStats = sparseStats;

    const result = tryCommand("/tokens 3", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Average tokens:");
    expect(text).toContain("2,000");
    expect(text).not.toContain("667");
  });

  test("shows per-model token breakdowns when using the models view", () => {
    const state = createInitialState();
    state.tokenStats = structuredClone(tokenStats);

    const result = tryCommand("/tokens models 2", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Models (");
    expect(text).not.toContain("Heatmap (");
    expect(text).toContain("Gpt-5.4:");
    expect(text).toContain("1,600");
    expect(text).toContain("600");
    expect(text).toContain("req");
    expect(text).not.toContain("— all");
    expect(text).toContain("DeepSeek V4 Pro:");
    expect(text).toContain("Top model: \x1b[38;2;");
    expect(text).toContain("Top model tokens: \x1b[38;2;");
    expect(text).not.toContain("Total tokens:");
    expect(text).not.toContain("Models used:");
  });

  test("shows simplified per-provider token breakdowns when using the providers view", () => {
    const state = createInitialState();
    state.tokenStats = structuredClone(tokenStats);

    const result = tryCommand("/tokens providers 2", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Providers (");
    expect(text).toContain("OpenAI:");
    expect(text).toContain("1,900");
    expect(text).toContain("700");
    expect(text).toContain("DeepSeek:");
    expect(text).not.toContain("req — all");
    expect(text).not.toContain("Top provider:");
    expect(text).not.toContain("Top provider tokens:");
  });

  test("shows simplified per-source token breakdowns when using the sources view", () => {
    const state = createInitialState();
    state.tokenStats = structuredClone(tokenStats);

    const result = tryCommand("/tokens sources 2", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Sources (");
    expect(text).toContain("conversation:");
    expect(text).toContain("1,900");
    expect(text).toContain("700");
    expect(text).toContain("4");
    expect(text).toContain("req");
    expect(text).toContain("title generation:");
    expect(text).not.toContain("Top source:");
    expect(text).not.toContain("Top source tokens:");
  });

  test("shows estimated cost summaries and provider-grouped lifetime model costs", () => {
    const state = createInitialState();
    state.tokenStats = structuredClone(tokenStats);

    const result = tryCommand("/tokens cost", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Today:");
    expect(text).toContain("$0.000764");
    expect(text).toContain("$0.006087");
    expect(text).toContain("Week:");
    expect(text).toContain("$0.001328");
    expect(text).toContain("$0.009174");
    expect(text).toContain("Lifetime:");
    expect(text).toContain("Measured input cache:");
    expect(text).toContain("1,200");
    expect(text).toContain("Unmeasured input:");
    expect(text).toContain("600");
    expect(text).not.toContain("Cost (");
    expect(text).toContain("OpenAI:");
    expect(text).toContain("    Gpt-5.4: ");
    expect(text).toContain("$0.001300");
    expect(text).toContain("$0.009000");
    expect(text).toContain("DeepSeek:");
    expect(text).toContain("    DeepSeek V4 Pro: ");
    expect(text).toContain("$0.000028");
    expect(text).toContain("$0.000174");
  });

  test("reports when stats are not available yet", () => {
    const state = createInitialState();

    const result = tryCommand("/tokens", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Token stats are still loading. Try again in a moment.");
  });
});

describe("/time", () => {
  test("shows the timestamp of the most recent chat message", () => {
    const state = createInitialState();
    const ts = Date.UTC(2026, 3, 13, 15, 30, 45);
    state.messages.push(
      { role: "user", text: "hello", metadata: { startedAt: ts, endedAt: ts, model: "gpt-5.4", tokens: 0 } },
    );

    const result = tryCommand("/time", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe(new Date(ts).toLocaleString("en-US"));
  });

  test("supports indexing messages from the end starting at zero", () => {
    const state = createInitialState();
    const first = Date.UTC(2026, 3, 13, 15, 0, 0);
    const second = Date.UTC(2026, 3, 13, 15, 5, 0);
    state.messages.push(
      { role: "user", text: "hello", metadata: { startedAt: first, endedAt: first, model: "gpt-5.4", tokens: 0 } },
      { role: "assistant", blocks: [{ type: "text", text: "hi" }], metadata: { startedAt: second, endedAt: second + 1_000, model: "gpt-5.4", tokens: 12 } },
    );

    const result = tryCommand("/time 1", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe(new Date(first).toLocaleString("en-US"));
  });

  test("counts a streaming assistant message as the latest message", () => {
    const state = createInitialState();
    const userTs = Date.UTC(2026, 3, 13, 15, 0, 0);
    const aiTs = Date.UTC(2026, 3, 13, 15, 1, 0);
    state.messages.push({ role: "user", text: "hello", metadata: { startedAt: userTs, endedAt: userTs, model: "gpt-5.4", tokens: 0 } });
    state.pendingAI = { role: "assistant", blocks: [], metadata: { startedAt: aiTs, endedAt: null, model: "gpt-5.4", tokens: 0 } };

    const result = tryCommand("/time", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.streamingTailMessages.at(-1) as { text?: string } | undefined)?.text).toBe(new Date(aiTs).toLocaleString("en-US"));
  });

  test("reports when there are no chat messages", () => {
    const state = createInitialState();

    const result = tryCommand("/time", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("No chat messages yet.");
  });
});

describe("/login", () => {
  test("selects a provider and returns a provider-scoped login command", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const result = tryCommand("/login openai", state);

    expect(result).toEqual({ type: "login", provider: "openai" });
    expect(state.hasChosenProvider).toBe(true);
    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.4");
  });

  test("returns an API-key login command for DeepSeek", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const result = tryCommand("/login deepseek sk-test123", state);

    expect(result).toEqual({ type: "login", provider: "deepseek", apiKey: "sk-test123" });
    expect(state.hasChosenProvider).toBe(true);
    expect(state.provider).toBe("deepseek");
    expect(state.model).toBe("deepseek-v4-pro");
  });

  test("returns OpenAI account-management login commands", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    expect(tryCommand("/login openai add", state)).toEqual({ type: "login", provider: "openai", action: "add" });
    expect(tryCommand("/login openai remove user@example.com", state)).toEqual({
      type: "login",
      provider: "openai",
      action: "remove",
      target: "user@example.com",
    });
  });

  test("autocompletes OpenAI login lifecycle subcommands", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const args = getCommandArgs(state);
    expect(args["/login openai"].map((item) => item.name)).toEqual(["add", "remove"]);
  });

  test("returns OpenAI account commands", () => {
    const state = createInitialState();

    expect(tryCommand("/account", state)).toEqual({ type: "account", provider: "openai" });
    expect(tryCommand("/account user@example.com", state)).toEqual({
      type: "account",
      provider: "openai",
      target: "user@example.com",
    });
  });

  test("autocompletes OpenAI account switching and censors emails when hide mode is enabled", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.hideSensitiveInfo = true;
    state.authInfoByProvider.openai = {
      ...state.authInfoByProvider.openai,
      accounts: [
        { email: "one@example.com", displayName: null, subscriptionType: "plus", accountId: "acct_one", current: false },
        { email: "two@example.com", displayName: null, subscriptionType: "pro", accountId: "acct_two", current: true },
      ],
      currentAccount: { email: "two@example.com", displayName: null, subscriptionType: "pro", accountId: "acct_two", current: true },
    };

    const args = getCommandArgs(state);
    expect(args["/account"].map((item) => item.name)).toEqual(["o**@example.com", "t**@example.com"]);
    expect(args["/account"].map((item) => item.desc).join("\n")).toContain("current");
  });

  test("instructs DeepSeek users to supply an API key", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const result = tryCommand("/login deepseek", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("/login deepseek <api-key>");
    expect(text).toContain("platform.deepseek.com/api_keys");
  });

  test("shows simplified login status when called without a provider", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.authByProvider.openai = true;
    state.authInfoByProvider.openai = {
      configured: true,
      authenticated: true,
      status: "logged_in",
      email: "user@example.com",
      displayName: "Example User",
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
      subscriptionType: "pro",
      rateLimitTier: null,
      scopes: ["openid", "profile"],
      expiresAt: Date.now() + 3_600_000,
      updatedAt: new Date().toISOString(),
      source: "oauth",
    };
    state.authInfoByProvider.deepseek = {
      configured: false,
      authenticated: false,
      status: "not_logged_in",
      email: null,
      displayName: null,
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
      subscriptionType: null,
      rateLimitTier: null,
      scopes: [],
      expiresAt: null,
      updatedAt: null,
      source: null,
    };

    const result = tryCommand("/login", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Login status:");
    expect(text).toContain("✓ OpenAI — user@example.com");
    expect(text).toContain("✗ DeepSeek");
    expect(text).toContain("Use /login <provider> to authenticate.");
  });

  test("censors emails in login status when hide mode is enabled", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.hideSensitiveInfo = true;
    state.authInfoByProvider.openai = {
      ...state.authInfoByProvider.openai,
      configured: true,
      authenticated: true,
      status: "logged_in",
      email: "user@example.com",
      displayName: "Example User",
    };

    const result = tryCommand("/login", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("✓ OpenAI — u***@example.com");
    expect(text).not.toContain("user@example.com");
  });
});

describe("/hide", () => {
  test("toggles email hiding", () => {
    const state = createInitialState();

    expect(tryCommand("/hide", state)).toEqual({ type: "handled" });
    expect(state.hideSensitiveInfo).toBe(true);
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Email hiding enabled.");

    expect(tryCommand("/hide", state)).toEqual({ type: "handled" });
    expect(state.hideSensitiveInfo).toBe(false);
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Email hiding disabled.");
  });

  test("supports explicit on/off", () => {
    const state = createInitialState();

    expect(tryCommand("/hide on", state)).toEqual({ type: "handled" });
    expect(state.hideSensitiveInfo).toBe(true);
    expect(readExocortexConfig().tui?.hideSensitiveInfo).toBe(true);

    expect(tryCommand("/hide off", state)).toEqual({ type: "handled" });
    expect(state.hideSensitiveInfo).toBe(false);
    expect(readExocortexConfig().tui?.hideSensitiveInfo).toBe(false);
  });

  test("loads the hide preference from config.json", () => {
    writeExocortexConfig({ ...defaultExocortexConfig(), tui: { hideSensitiveInfo: true } });

    const state = createInitialState();

    expect(state.hideSensitiveInfo).toBe(true);
  });
});

describe("/logout", () => {
  test("returns a provider-scoped logout command when given a provider", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.hasChosenProvider = true;

    const result = tryCommand("/logout deepseek", state);

    expect(result).toEqual({ type: "logout", provider: "deepseek" });
    expect(state.provider).toBe("openai");
  });

  test("requires an explicit provider even when one is currently selected", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "deepseek";
    state.hasChosenProvider = true;

    const result = tryCommand("/logout", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("/logout openai");
    expect(text).toContain("/logout deepseek");
  });

  test("requires an explicit provider when none has been chosen yet", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const result = tryCommand("/logout", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("/logout openai");
    expect(text).toContain("/logout deepseek");
  });
});

describe("/instructions", () => {
  test("on a new chat with text, requests conversation creation for instructions", () => {
    const state = createInitialState();

    const result = tryCommand("/instructions be concise", state);

    expect(result).toEqual({ type: "create_conversation_for_instructions", text: "be concise" });
    expect(state.pendingSystemInstructions).toBeNull();
    expect(state.pendingGenerateTitleOnCreate).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  test("on a new chat with no text, reports that no instructions are set", () => {
    const state = createInitialState();

    const result = tryCommand("/instructions", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "system",
      text: "No system instructions set for this conversation.",
    });
  });

  test("on a new chat with clear, does not create a conversation", () => {
    const state = createInitialState();

    const result = tryCommand("/instructions clear", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.pendingSystemInstructions).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "system",
      text: "No system instructions set for this conversation.",
    });
  });
});
