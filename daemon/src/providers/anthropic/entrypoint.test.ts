import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { resetProviderProxyRoutesForTest, setProviderProxyRoute } from "../../provider-proxy/route";
import { claudeProcessOptions, claudeSubscriptionEnv } from "./cli";
import { agentSdkUserAgent } from "./entrypoint";

const inherited = process.env.CLAUDE_CODE_ENTRYPOINT;

beforeEach(() => {
  // A daemon started from a Claude Code shell inherits that shell's label.
  process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  writeExocortexConfig({});
});

afterEach(() => {
  if (inherited === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = inherited;
  writeExocortexConfig({});
  resetProviderProxyRoutesForTest();
});

describe("Claude Code entrypoint", () => {
  test("a subscription process carries Exocortex's label, whatever it inherited", () => {
    const options = claudeProcessOptions("/work", "main", "conv-1");
    expect(options.env).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: "exocortex", CLAUDE_AGENT_SDK_CLIENT_APP: "exocortex-daemon" });
    expect(claudeSubscriptionEnv({ CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "k" })).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: "exocortex" });
    expect(claudeSubscriptionEnv({ ANTHROPIC_API_KEY: "k" }).ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("what Claude Code turns on outside `sdk-*` labels stays off", () => {
    const options = claudeProcessOptions("/work");
    expect(options.env).toMatchObject({ CLAUDE_CODE_ARTIFACT: "0", CLAUDE_CODE_SEND_FEEDBACK: "0" });
    expect(options.settings).toEqual({ autoDreamEnabled: false });
  });

  test("a proxied process carries it too: the request is sent from this machine", () => {
    setProviderProxyRoute("anthropic", { provider: "anthropic", alias: "whale", baseUrl: "http://127.0.0.1:1", token: "t" });
    expect(claudeProcessOptions("/work").env).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_ENTRYPOINT: "exocortex" });
  });

  test("providers.anthropic.sdkEntrypoint leaves it to the SDK", () => {
    writeExocortexConfig({ providers: { anthropic: { sdkEntrypoint: true } } });
    const options = claudeProcessOptions("/work");
    expect(options.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect(options.settings).toBeUndefined();
  });

  test("only Exocortex's label is rewritten for API credits", () => {
    expect(agentSdkUserAgent("claude-cli/2.1.303 (external, exocortex, agent-sdk/0.3.294)")).toBe("claude-cli/2.1.303 (external, sdk-ts, agent-sdk/0.3.294)");
    expect(agentSdkUserAgent("claude-cli/2.1.303 (external, cli)")).toBe("claude-cli/2.1.303 (external, cli)");
  });
});
