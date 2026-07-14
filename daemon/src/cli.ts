/**
 * CLI subcommands for exocortexd.
 *
 * Standalone commands run outside the daemon process.
 * Each function is a complete subcommand — runs and exits.
 */

import { ensureAuthenticated } from "./auth";
import type { ProviderId } from "./messages";
import { getDefaultProvider } from "./providers/registry";
import type { OpenAILoginMethod } from "@exocortex/shared/protocol";

// ── Login ──────────────────────────────────────────────────────────

function parseOpenAILoginMethod(value?: string): OpenAILoginMethod | undefined {
  if (!value) return undefined;
  if (value === "browser") return "browser";
  if (value === "code") return "code";
  throw new Error("Unknown OpenAI login method. Use `exocortexd login openai browser` or `exocortexd login openai code`.");
}

export async function handleLogin(providerArg?: string, loginArg?: string): Promise<void> {
  const provider = (providerArg as ProviderId | undefined) ?? getDefaultProvider().id;
  console.log(`\n  Exocortex — Authentication (${provider})\n`);

  const method = provider === "openai" ? parseOpenAILoginMethod(loginArg) : undefined;
  const apiKey = provider === "deepseek" ? loginArg : undefined;

  const { status, email } = await ensureAuthenticated(provider, {
    onProgress: (msg) => console.log(`  ${msg}`),
    onOpenUrl: async (url) => {
      const { openUrlInBrowser } = await import("./providers/oauth");
      return openUrlInBrowser(url);
    },
    onDeviceCode: ({ verificationUrl, userCode, expiresInSeconds }) => {
      console.log([
        "  OpenAI code authorization:",
        `  1. Open ${verificationUrl} in any browser and sign in.`,
        `  2. Enter this one-time code: ${userCode}`,
        `  The code expires in ${Math.round(expiresInSeconds / 60)} minutes.`,
        "  Continue only if you started this login in Exocortex.",
      ].join("\n"));
    },
  }, method || apiKey ? { ...(method ? { method } : {}), ...(apiKey ? { apiKey } : {}) } : undefined);

  const name = email ?? provider;
  if (status === "already_authenticated") {
    console.log(`  ✓ Already authenticated as ${name}\n`);
  } else if (status === "refreshed") {
    console.log(`  ✓ Session refreshed (${name})\n`);
  } else {
    console.log(`\n  ✓ Authenticated as ${name}\n`);
  }
}
