/**
 * /proxy status block — shown while the current provider goes through /proxy:
 * which SSH alias it uses and whether that link is up.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { activeProviderProxy } from "../provider-proxies";
import { maybeCensorEmail } from "../privacy";

const MAX_DETAIL = 48;

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

export function providerProxyBlock(state: RenderState): StatusBlock | null {
  const proxy = activeProviderProxy(state);
  if (!proxy) return null;

  const label = "Proxy: ";
  const stateColor = proxy.state === "connected" && proxy.remoteLoggedIn !== false ? theme.accent
    : proxy.state === "connecting" ? theme.muted
    : theme.error;
  const stateText = proxy.state === "connected" ? (proxy.remoteLoggedIn === false ? "not logged in" : "connected")
    : proxy.state === "connecting" ? "connecting" : "down";
  const head = `${proxy.alias} ${stateText}`;
  const detail = clip(proxy.state === "connected" && proxy.remoteLoggedIn !== false
    ? maybeCensorEmail(proxy.remoteAccount, state.hideSensitiveInfo) ?? proxy.remoteHost ?? ""
    : proxy.message ?? "", MAX_DETAIL);
  const width = Math.max(label.length + head.length, detail.length);

  return {
    id: "provider-proxy",
    // Which login the prompt uses matters more than the context meter.
    priority: 2,
    width,
    height: detail ? 2 : 1,
    rows: [
      `${theme.muted}${label}${theme.accent}${proxy.alias} ${stateColor}${stateText}${theme.reset}${" ".repeat(Math.max(0, width - label.length - head.length))}`,
      ...(detail ? [`${theme.muted}${detail}${theme.reset}${" ".repeat(Math.max(0, width - detail.length))}`] : []),
    ],
  };
}
