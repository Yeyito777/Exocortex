import { describe, expect, test } from "bun:test";
import { censorKnownAuthEmails } from "./privacy";
import { createInitialState } from "./state";

describe("privacy helpers", () => {
  test("censors known and newly mentioned auth emails when hide mode is enabled", () => {
    const state = createInitialState();
    state.hideSensitiveInfo = true;
    state.authInfoByProvider.openai = {
      ...state.authInfoByProvider.openai,
      email: "known@example.com",
      accounts: [
        { email: "account@example.com", displayName: null, subscriptionType: "pro", accountId: "acct", current: true },
      ],
    };

    const text = censorKnownAuthEmails(state, "known@example.com account@example.com fresh@example.com");
    expect(text).toBe("k****@example.com a******@example.com f****@example.com");
  });

  test("leaves text unchanged when hide mode is disabled", () => {
    const state = createInitialState();
    state.hideSensitiveInfo = false;

    expect(censorKnownAuthEmails(state, "user@example.com")).toBe("user@example.com");
  });
});
