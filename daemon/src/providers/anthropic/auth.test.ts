import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasConfiguredCredentials } from "./auth";

const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
});

describe("Anthropic Claude Code auth helpers", () => {
  test("hasConfiguredCredentials reads Claude Code local profile metadata", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "exo-claude-auth-"));
    process.env.HOME = tempHome;
    writeFileSync(join(tempHome, ".claude.json"), JSON.stringify({
      oauthAccount: {
        accountUuid: "acct_123",
        emailAddress: "user@example.com",
        organizationUuid: "org_123",
        organizationName: "Example Org",
        billingType: "claude_max",
      },
    }));

    expect(hasConfiguredCredentials()).toBe(true);

    rmSync(tempHome, { recursive: true, force: true });
  });
});
