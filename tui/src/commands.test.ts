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
