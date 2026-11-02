import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { resetProviderProxyRoutesForTest, setProviderProxyRoute } from "../../provider-proxy/route";
import { setApiCreditSecretsForTests, type ApiCreditKey } from "./api-credits";
import { claudeProcessOptions, claudeSubscriptionEnv } from "./cli";
import { agentSdkUserAgent } from "./entrypoint";

const inherited = process.env.CLAUDE_CODE_ENTRYPOINT;
const customEntrypoint = () => writeExocortexConfig({ providers: { anthropic: { customEntrypoint: true } } });

/** The environment the Agent SDK really spawns Claude Code with, for these options. */
async function spawnedEnv(options: ReturnType<typeof claudeProcessOptions>): Promise<Record<string, string | undefined>> {
  let spawned: SpawnOptions | null = null;
  const runtime = query({
    prompt: "x",
    options: {
      ...options,
      spawnClaudeCodeProcess: (spawnOptions) => {
        spawned = spawnOptions;
        return spawn(process.execPath, ["--version"], { stdio: ["pipe", "pipe", "ignore"] });
      },
    },
  });
  try {
    for await (const _ of runtime) break;
  } catch {
    // The stand-in process is not Claude Code: it only had to be spawned.
  }
  runtime.close();
  if (!spawned) throw new Error("the SDK did not spawn Claude Code");
  return (spawned as SpawnOptions).env;
}

beforeEach(() => {
  // A daemon started from a Claude Code shell inherits that shell's label.
  process.env.CLAUDE_CODE_ENTRYPOINT = "exocortex";
  writeExocortexConfig({});
});

afterEach(() => {
  if (inherited === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = inherited;
  writeExocortexConfig({});
  resetProviderProxyRoutesForTest();
  setApiCreditSecretsForTests(null);
});

describe("Claude Code entrypoint, by default", () => {
  test("the SDK spawns a process with its own label, whatever was inherited", async () => {
    const options = claudeProcessOptions("/tmp", "main", "conv-1");
    expect(options.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    const env = await spawnedEnv(options);
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("exocortex-daemon");
  });

  test("nothing else is overridden", () => {
    const options = claudeProcessOptions("/tmp");
    expect(options.env?.CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_SEND_FEEDBACK).toBeUndefined();
    expect(options.settings).toBeUndefined();
  });

  test("the old sdkEntrypoint setting no longer means anything", () => {
    writeExocortexConfig({ providers: { anthropic: { sdkEntrypoint: true } } } as never);
    expect(claudeProcessOptions("/tmp").env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    writeExocortexConfig({ providers: { anthropic: { sdkEntrypoint: false } } } as never);
    expect(claudeProcessOptions("/tmp").env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  test("a proxied process keeps it too", () => {
    setProviderProxyRoute("anthropic", { provider: "anthropic", alias: "whale", baseUrl: "http://127.0.0.1:1", token: "t" });
    const env = claudeProcessOptions("/tmp").env;
    expect(env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
    expect(env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });
});

describe("providers.anthropic.customEntrypoint", () => {
  test("a subscription process carries Exocortex's label, whatever it inherited", async () => {
    customEntrypoint();
    const options = claudeProcessOptions("/tmp", "main", "conv-1");
    expect(options.env).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: "exocortex", CLAUDE_AGENT_SDK_CLIENT_APP: "exocortex-daemon" });
    expect((await spawnedEnv(options)).CLAUDE_CODE_ENTRYPOINT).toBe("exocortex");
    expect(claudeSubscriptionEnv({ CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "k" })).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: "exocortex" });
    expect(claudeSubscriptionEnv({ ANTHROPIC_API_KEY: "k" }).ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("what Claude Code turns on outside `sdk-*` labels stays off", () => {
    customEntrypoint();
    const options = claudeProcessOptions("/tmp");
    expect(options.env).toMatchObject({ CLAUDE_CODE_ARTIFACT: "0", CLAUDE_CODE_SEND_FEEDBACK: "0" });
    expect(options.settings).toEqual({ autoDreamEnabled: false });
  });

  test("a proxied process carries it too: the request is sent from this machine", () => {
    customEntrypoint();
    setProviderProxyRoute("anthropic", { provider: "anthropic", alias: "whale", baseUrl: "http://127.0.0.1:1", token: "t" });
    expect(claudeProcessOptions("/tmp").env).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_ENTRYPOINT: "exocortex" });
  });
});

describe("API credits", () => {
  test("an API-credit turn keeps the SDK's label, with the flag on as well", async () => {
    customEntrypoint();
    setApiCreditSecretsForTests({ names: async () => ["KEY"], value: async () => "k", helperCommand: () => "print-key" });
    const key: ApiCreditKey = { id: "KEY", label: "main", renewsOnDay: null };
    const options = claudeProcessOptions("/tmp", "main", "conv-1", key);
    expect(options.env?.CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect((await spawnedEnv(options)).CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
  });

  test("only Exocortex's label is rewritten when a /proxy remote signs with a key", () => {
    expect(agentSdkUserAgent("claude-cli/2.1.303 (external, exocortex, agent-sdk/0.3.294)")).toBe("claude-cli/2.1.303 (external, sdk-ts, agent-sdk/0.3.294)");
    expect(agentSdkUserAgent("claude-cli/2.1.303 (external, sdk-ts, agent-sdk/0.3.294)")).toBe("claude-cli/2.1.303 (external, sdk-ts, agent-sdk/0.3.294)");
    expect(agentSdkUserAgent("claude-cli/2.1.303 (external, cli)")).toBe("claude-cli/2.1.303 (external, cli)");
  });
});
