/** /proxy status for the transcript and the status line. */

import type { ProviderProxyInfo } from "./protocol";
import type { RenderState } from "./state";
import { maybeCensorEmail } from "./privacy";

/** The proxy for the provider the prompt would use, if it goes through /proxy. */
export function activeProviderProxy(state: Pick<RenderState, "providerProxies" | "provider">): ProviderProxyInfo | null {
  return state.providerProxies?.find(proxy => proxy.provider === state.provider) ?? null;
}

export function describeProviderProxyState(proxy: ProviderProxyInfo, hideSensitiveInfo: boolean): string {
  if (proxy.state === "connecting") return "connecting…";
  if (proxy.state === "disconnected") return `down${proxy.message ? `: ${proxy.message}` : ""}`;
  if (proxy.remoteLoggedIn === false) return `connected, but ${proxy.message ?? "the remote is not logged in"}`;
  const account = maybeCensorEmail(proxy.remoteAccount, hideSensitiveInfo);
  return `connected${proxy.remoteHost ? ` (${proxy.remoteHost}${account ? `, ${account}` : ""})` : ""}`;
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
