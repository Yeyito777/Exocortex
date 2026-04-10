import { beforeEach, describe, expect, test } from "bun:test";
import { tryCommand } from "./commands";
import { clearPreferredProvider } from "./preferences";
import { createInitialState } from "./state";
import type { ProviderInfo } from "./messages";

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
        label: "Claude Opus 4.6",
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
        label: "gpt-5.4",
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

  test("status check reports current fast mode", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.fastMode = true;

    const result = tryCommand("/fast", state);

    expect(result).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Fast mode is on.");
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
    const text = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("last known context (500,000 tokens) exceeds openai/gpt-5.4's max context (272,000)");
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
    expect((state.systemMessageBuffer.at(-1) as { text?: string } | undefined)?.text).toBe("Cannot switch provider/model while this conversation is streaming.");
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
    expect((state.systemMessageBuffer.at(-1) as { text?: string } | undefined)?.text).toBe("Cannot trim the conversation while it is streaming.");
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
