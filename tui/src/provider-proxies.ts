/** /proxy status for the transcript and the status line. */

import type { ProviderProxyInfo } from "./protocol";
import type { RenderState } from "./state";
import { maybeCensorEmail } from "./privacy";

/** The proxy for the provider the prompt would use, if it goes through /proxy. */
export function activeProviderProxy(state: Pick<RenderState, "providerProxies" | "provider">): ProviderProxyInfo | null {
  return state.providerProxies?.find(proxy => proxy.provider === state.provider) ?? null;
}

export function describeProviderProxyState(proxy: ProviderProxyInfo, hideSensitiveInfo: boolean): string {
  if (proxy.state === "connecting") return `connecting…${proxyCreditsNote(proxy)}`;
  if (proxy.state === "disconnected") return `down${proxy.message ? `: ${proxy.message}` : ""}${proxyCreditsNote(proxy)}`;
  if (proxy.remoteLoggedIn === false) return `connected, but ${proxy.message ?? "the remote is not logged in"}${proxyCreditsNote(proxy)}`;
  const account = maybeCensorEmail(proxy.remoteAccount, hideSensitiveInfo);
  return `connected${proxy.remoteHost ? ` (${proxy.remoteHost}${account ? `, ${account}` : ""})` : ""}${proxyCreditsNote(proxy)}`;
}

/** This machine's API-credit keys for when the proxy cannot serve. */
function proxyCreditsNote(proxy: ProviderProxyInfo): string {
  const credits = proxy.apiCredits;
  if (!credits) return "";
  if (credits.active) return `; turns run on API credits${credits.label ? ` (${credits.label})` : ""}`;
  return credits.label ? `; API credits after ${credits.afterSeconds}s down` : "; no API-credit key usable";
}

export function formatProviderProxies(state: Pick<RenderState, "providerProxies" | "hideSensitiveInfo">): string {
  const proxies = state.providerProxies ?? [];
  if (proxies.length === 0) {
    return "No provider goes through /proxy. /proxy <openai|anthropic> <ssh-alias> sends that provider's model requests through the machine's login.";
  }
  return [
    "Through /proxy (saved; conversations, tools and files stay on this machine):",
    ...proxies.map(proxy => `  ${proxy.provider} → ${proxy.alias}: ${describeProviderProxyState(proxy, state.hideSensitiveInfo)}`),
    "/proxy <provider> off stops one.",
  ].join("\n");
}
