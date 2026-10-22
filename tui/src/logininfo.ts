/**
 * Formatting helpers for the TUI /login status output.
 */

import type { ProviderId } from "./messages";
import type { RenderState } from "./state";
import { availableProviders } from "./providerselection";
import { maybeCensorEmail } from "./privacy";

function providerLabel(state: RenderState, provider: ProviderId): string {
  return state.providerRegistry.find((candidate) => candidate.id === provider)?.label ?? provider;
}

function providerSummary(state: RenderState, provider: ProviderId): string | null {
  const info = state.authInfoByProvider[provider];
  const summary = maybeCensorEmail(info.email, state.hideSensitiveInfo) || info.displayName?.trim() || null;
  // OpenAI has two login methods; say which one is in use.
  if (provider !== "openai" || !info.authenticated || info.source?.startsWith("proxy:")) return summary;
  if (info.source === "api_key") return summary ?? "API key";
  return summary ? `${summary} (ChatGPT account)` : "ChatGPT account";
}

export function buildLoginInfoMessage(state: RenderState): string {
  const providers = availableProviders(state);
  const lines = ["Login status:"];

  for (const provider of providers) {
    const info = state.authInfoByProvider[provider];
    const icon = info.authenticated ? "✓" : "✗";
    const summary = providerSummary(state, provider);
    lines.push(`${icon} ${providerLabel(state, provider)}${summary ? ` — ${summary}` : ""}`);
  }

  lines.push("", "Use /login <provider> to authenticate.");
  return lines.join("\n");
}
