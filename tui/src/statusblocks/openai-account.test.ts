import { describe, expect, test } from "bun:test";
import { createInitialState } from "../state";
import { openAIAccountBlock } from "./openai-account";

describe("OpenAI account status block", () => {
  test("shows current account and plan only when multiple OpenAI accounts are connected", () => {
    const state = createInitialState();
    state.provider = "openai";
    state.authInfoByProvider.openai = {
      ...state.authInfoByProvider.openai,
      configured: true,
      authenticated: true,
      status: "logged_in",
      accounts: [
        { email: "one@example.com", displayName: null, subscriptionType: "plus", accountId: "acct_one", current: false },
        { email: "two@example.com", displayName: null, subscriptionType: "pro", accountId: "acct_two", current: true },
      ],
      currentAccount: { email: "two@example.com", displayName: null, subscriptionType: "pro", accountId: "acct_two", current: true },
    };

    const block = openAIAccountBlock(state);
    expect(block?.id).toBe("openai-account");
    expect(block?.height).toBe(2);
    expect(block?.rows.join("\n")).toContain("Account: ");
    expect(block?.rows.join("\n")).toContain("two@example.com");
    expect(block?.rows.join("\n")).toContain("Plan: ");
    expect(block?.rows.join("\n")).toContain("pro");
  });

  test("does not show for a single OpenAI account", () => {
    const state = createInitialState();
    state.provider = "openai";
    state.authInfoByProvider.openai = {
      ...state.authInfoByProvider.openai,
      accounts: [
        { email: "one@example.com", displayName: null, subscriptionType: "pro", accountId: "acct_one", current: true },
      ],
      currentAccount: { email: "one@example.com", displayName: null, subscriptionType: "pro", accountId: "acct_one", current: true },
    };

    expect(openAIAccountBlock(state)).toBeNull();
  });
});
