import { beforeEach, describe, expect, test } from "bun:test";
import { tryCommand } from "./commands";
import { clearPreferredProvider } from "./preferences";
import { createInitialState } from "./state";
import type { ProviderInfo, TokenStatsSnapshot } from "./messages";
import { theme } from "./theme";

const providers: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    defaultModel: "claude-opus-4-6",
    allowsCustomModels: false,
    supportsFastMode: false,
    models: [
      {
        id: "claude-opus-4-6",
        label: "Opus-4.6",
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

const tokenStats: TokenStatsSnapshot = {
  updatedAt: Date.now(),
  today: {
    day: todayKey,
    inputTokens: 1_500,
    outputTokens: 500,
    totalTokens: 2_000,
    requests: 3,
    byProvider: {
      openai: { inputTokens: 1_500, outputTokens: 500, totalTokens: 2_000, requests: 3 },
    },
    byModel: {
      "gpt-5.4": { inputTokens: 1_200, outputTokens: 400, totalTokens: 1_600, requests: 2 },
      "claude-opus-4-6": { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
    },
    bySource: {
      conversation: { inputTokens: 1_200, outputTokens: 400, totalTokens: 1_600, requests: 2 },
      title_generation: { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
    },
  },
  lifetime: {
    inputTokens: 2_200,
    outputTokens: 800,
    totalTokens: 3_000,
    requests: 5,
    byProvider: {
      openai: { inputTokens: 1_900, outputTokens: 700, totalTokens: 2_600, requests: 4 },
      anthropic: { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
    },
    byModel: {
      "gpt-5.4": { inputTokens: 1_600, outputTokens: 600, totalTokens: 2_200, requests: 3 },
      "claude-opus-4-6": { inputTokens: 600, outputTokens: 200, totalTokens: 800, requests: 2 },
    },
    bySource: {
      conversation: { inputTokens: 1_900, outputTokens: 700, totalTokens: 2_600, requests: 4 },
      title_generation: { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
    },
  },
  days: [
    {
      day: todayKey,
      inputTokens: 1_500,
      outputTokens: 500,
      totalTokens: 2_000,
      requests: 3,
      byProvider: {
        openai: { inputTokens: 1_500, outputTokens: 500, totalTokens: 2_000, requests: 3 },
      },
      byModel: {
        "gpt-5.4": { inputTokens: 1_200, outputTokens: 400, totalTokens: 1_600, requests: 2 },
        "claude-opus-4-6": { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
      },
      bySource: {
        conversation: { inputTokens: 1_200, outputTokens: 400, totalTokens: 1_600, requests: 2 },
        title_generation: { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
      },
    },
    {
      day: yesterdayKey,
      inputTokens: 700,
      outputTokens: 300,
      totalTokens: 1_000,
      requests: 2,
      byProvider: {
        openai: { inputTokens: 400, outputTokens: 200, totalTokens: 600, requests: 1 },
        anthropic: { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
      },
      byModel: {
        "gpt-5.4": { inputTokens: 400, outputTokens: 200, totalTokens: 600, requests: 1 },
        "claude-opus-4-6": { inputTokens: 300, outputTokens: 100, totalTokens: 400, requests: 1 },
      },
      bySource: {
        conversation: { inputTokens: 700, outputTokens: 300, totalTokens: 1_000, requests: 2 },
      },
    },
  ],
};

beforeEach(() => {
  clearPreferredProvider();
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
    state.provider = "anthropic";
    state.model = "claude-opus-4-6";
    state.fastMode = false;

    const result = tryCommand("/fast on", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.fastMode).toBe(false);
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Fast mode is only available for anthropic conversations that support it.");
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

    const result = tryCommand("/model anthropic claude-opus-4-6", state);

    expect(result).toEqual({ type: "model_changed", provider: "anthropic", model: "claude-opus-4-6" });
    expect(String(state.provider)).toBe("anthropic");
    expect(String(state.model)).toBe("claude-opus-4-6");
    expect(String(state.effort)).toBe("high");
    expect(state.fastMode).toBe(false);
    expect(state.contextTokens).toBeNull();
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Model set to anthropic/claude-opus-4-6 (effort high) (fast off)");
  });

  test("warns when switching to a model with a smaller known context window", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "anthropic";
    state.model = "claude-opus-4-6";
    state.contextTokens = 500_000;
    state.convId = "conv-anthropic";

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

    const result = tryCommand("/model anthropic claude-opus-4-6", state);

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
    expect(text).toContain("Opus-4.6:");
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
    expect(text).toContain("Anthropic:");
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
    expect(text).toContain("$0.004500");
    expect(text).toContain("$0.008500");
    expect(text).toContain("Week:");
    expect(text).toContain("$0.007000");
    expect(text).toContain("$0.0140");
    expect(text).toContain("Lifetime:");
    expect(text).not.toContain("Cost (");
    expect(text).toContain("OpenAI:");
    expect(text).toContain("    Gpt-5.4: ");
    expect(text).toContain("$0.004000");
    expect(text).toContain("$0.009000");
    expect(text).toContain("Anthropic:");
    expect(text).toContain("    Opus-4.6: ");
    expect(text).toContain("$0.003000");
    expect(text).toContain("$0.005000");
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

    const result = tryCommand("/login anthropic", state);

    expect(result).toEqual({ type: "login", provider: "anthropic" });
    expect(state.hasChosenProvider).toBe(true);
    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
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
    state.authInfoByProvider.anthropic = {
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
    expect(text).toContain("✗ Anthropic");
    expect(text).toContain("Use /login <provider> to authenticate.");
  });
});

describe("/logout", () => {
  test("returns a provider-scoped logout command when given a provider", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.hasChosenProvider = true;

    const result = tryCommand("/logout anthropic", state);

    expect(result).toEqual({ type: "logout", provider: "anthropic" });
    expect(state.provider).toBe("openai");
  });

  test("requires an explicit provider even when one is currently selected", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "anthropic";
    state.hasChosenProvider = true;

    const result = tryCommand("/logout", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("/logout openai");
    expect(text).toContain("/logout anthropic");
  });

  test("requires an explicit provider when none has been chosen yet", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    const result = tryCommand("/logout", state);

    expect(result).toEqual({ type: "handled" });
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("/logout openai");
    expect(text).toContain("/logout anthropic");
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
