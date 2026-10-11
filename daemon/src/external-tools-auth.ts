import type { LoadedTool } from "./external-tools-types";
import { getVerifiedSession as getVerifiedOpenAISession } from "./providers/openai/auth";
import { providerProxyRoute } from "./provider-proxy/route";

export const EXTERNAL_TOOL_OPENAI_AUTH_ARG = "--exocortex-auth-openai";

interface ExternalToolAuthPayload {
  provider: string;
  accessToken: string;
  accountId?: string | null;
}

function encodeAuthPayload(payload: ExternalToolAuthPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function buildProviderAuthArg(provider: string): Promise<[string, string]> {
  switch (provider) {
    case "openai": {
      // A proxied login stays on the remote machine; there is no token to lend.
      const route = providerProxyRoute("openai");
      if (route) throw new Error(`OpenAI goes through /proxy on ${route.alias}, so its login is not available to external tools on this machine. Run /proxy openai off, or use the tool on ${route.alias}.`);
      const session = await getVerifiedOpenAISession();
      return [
        EXTERNAL_TOOL_OPENAI_AUTH_ARG,
        encodeAuthPayload({
          provider: "openai",
          accessToken: session.accessToken,
          accountId: session.accountId,
        }),
      ];
    }
    default:
      throw new Error(`External tool requested unsupported auth provider: ${provider}`);
  }
}

/**
 * Build hidden CLI args that let an external tool temporarily borrow daemon-owned
 * provider auth for one invocation. The credentials are passed only to tools that
 * explicitly request providers in manifest.json.
 */
export async function getExternalToolAuthArgs(tool: LoadedTool): Promise<string[]> {
  const providers = tool.manifest.auth?.providers ?? [];
  if (providers.length === 0) return [];

  const args: string[] = [];
  for (const provider of providers) {
    const [flag, value] = await buildProviderAuthArg(provider);
    args.push(flag, value);
  }
  return args;
}
