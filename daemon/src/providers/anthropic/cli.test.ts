import { describe, expect, test } from "bun:test";
import { parseClaudeAuthStatus, parseClaudeVersion } from "./cli";

describe("Claude Code auth parsing", () => {
  test("parses JSON auth status from Claude Code", () => {
    const status = parseClaudeAuthStatus(`{
      "loggedIn": true,
      "authMethod": "claude.ai",
      "apiProvider": "firstParty",
      "email": "user@example.com",
      "orgId": "org_123",
      "orgName": "Example Org",
      "subscriptionType": "max"
    }`);

    expect(status).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "user@example.com",
      orgId: "org_123",
      orgName: "Example Org",
      subscriptionType: "max",
    });
  });

  test("falls back to unauthenticated for text output mentioning login", () => {
    expect(parseClaudeAuthStatus("Not logged in. Run claude auth login.")).toEqual({
      loggedIn: false,
    });
  });

  test("parses version output", () => {
    expect(parseClaudeVersion("2.1.96 (Claude Code)")).toBe("2.1.96");
  });
});
