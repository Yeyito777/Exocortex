/**
 * `exocortexd proxy --link-only`: the stdio bridge limited to the /proxy model
 * link, for an SSH key that may borrow this machine's provider login and do
 * nothing else (a forced `command=` in authorized_keys; docs/provider-proxy.md,
 * "A key that can only borrow the login").
 *
 * The plain bridge carries the whole daemon protocol: whoever holds the key can
 * list and drive this machine's conversations, run remote_bash, or register as
 * the machine client_bash runs on. Here every line is parsed and only the link
 * messages pass, re-serialized so the daemon sees exactly what was checked:
 *
 * - From the client: provider_proxy_hello (its clientHost removed, so this
 *   machine's conversations never send client_bash to it), _open, _ws_send,
 *   _cancel, _status, _consume_reset, _accounts and _ping, for the allowed
 *   providers only. remote_bash (provider_proxy_exec) is answered here with an
 *   error result; anything else with an `error`, and never reaches the daemon.
 * - From the daemon: only link events and the `error` answers to forwarded
 *   requests. Broadcasts the daemon sends a connection before its hello
 *   (conversation lists, usage, …) and client_bash requests are dropped. The
 *   hello result gains the `link-only` feature, so the linking daemon does not
 *   offer its models remote_bash.
 */

import {
  PROVIDER_PROXY_LINK_EVENT_TYPES,
  PROVIDER_PROXY_LINK_ONLY_FEATURE,
  isProxyableProvider,
  type ProxyableProviderId,
} from "@exocortex/shared/provider-proxy";

export interface LinkOnlyFilterOptions {
  /** Providers the key may use; default all proxyable ones. */
  providers: readonly ProxyableProviderId[];
}

export interface LinkFilterVerdict {
  /** The line to send on to the daemon (no trailing newline). */
  forward?: string;
  /** An answer for the client instead (no trailing newline). */
  reply?: string;
}

const PASSING_COMMANDS = new Set([
  "provider_proxy_hello",
  "provider_proxy_open",
  "provider_proxy_ws_send",
  "provider_proxy_cancel",
  "provider_proxy_status",
  "provider_proxy_consume_reset",
  "provider_proxy_accounts",
  "provider_proxy_ping",
]);

/** Commands that name one provider, which must be an allowed one. */
const PROVIDER_COMMANDS = new Set([
  "provider_proxy_open",
  "provider_proxy_status",
  "provider_proxy_consume_reset",
  "provider_proxy_accounts",
]);

const DROPPED_EVENTS = new Set(["provider_proxy_client_exec", "provider_proxy_client_exec_cancel"]);

/** Request ids remembered for matching `error` answers; the oldest are forgotten past this. */
const MAX_PENDING_REQ_IDS = 4096;

export const LINK_ONLY_REFUSAL = "Refused: this SSH key may only use the /proxy model link";

export function parseLinkOnlyProviders(value: string | undefined): ProxyableProviderId[] {
  if (!value) return ["openai", "anthropic"];
  const providers = value.split(",").map(name => name.trim()).filter(Boolean);
  for (const provider of providers) {
    if (!isProxyableProvider(provider)) throw new Error(`--link-only: unknown provider "${provider}" (openai, anthropic)`);
  }
  if (providers.length === 0) throw new Error("--link-only: no providers given");
  return providers as ProxyableProviderId[];
}

export class LinkOnlyFilter {
  private readonly providers: ReadonlySet<string>;
  private readonly reqIds = new Set<string>();

  constructor(options: LinkOnlyFilterOptions) {
    this.providers = new Set(options.providers);
  }

  fromClient(line: string): LinkFilterVerdict {
    let command: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reply: JSON.stringify({ type: "error", message: "Invalid JSON" }) };
      command = parsed as Record<string, unknown>;
    } catch {
      return { reply: JSON.stringify({ type: "error", message: "Invalid JSON" }) };
    }
    const type = typeof command.type === "string" ? command.type : "";
    const reqId = typeof command.reqId === "string" ? command.reqId : undefined;

    if (type === "provider_proxy_exec") {
      return {
        reply: JSON.stringify({
          type: "provider_proxy_exec_result",
          execId: typeof command.execId === "string" ? command.execId : "",
          output: "",
          byteTruncated: false,
          exitCode: null,
          signal: null,
          timedOut: false,
          error: "remote_bash is not available: this machine's SSH key may only use the /proxy model link.",
        }),
      };
    }
    if (type === "provider_proxy_exec_cancel") return {};

    const refuse = (message: string): LinkFilterVerdict => ({
      reply: JSON.stringify({ type: "error", ...(reqId !== undefined ? { reqId } : {}), message }),
    });
    if (!PASSING_COMMANDS.has(type)) return refuse(`${LINK_ONLY_REFUSAL} (${type || "no type"})`);
    if (PROVIDER_COMMANDS.has(type) && !this.providers.has(String(command.provider))) {
      return refuse(`${LINK_ONLY_REFUSAL} for ${[...this.providers].join(", ")}`);
    }
    if (type === "provider_proxy_hello") {
      delete command.clientHost;
      const asked = Array.isArray(command.providers) ? command.providers : [];
      command.providers = asked.filter(provider => typeof provider === "string" && this.providers.has(provider));
    }
    if (reqId !== undefined) this.remember(reqId);
    return { forward: JSON.stringify(command) };
  }

  /** The line to pass to the client, or null to drop it. */
  fromDaemon(line: string): string | null {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      event = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    const type = typeof event.type === "string" ? event.type : "";
    const reqId = typeof event.reqId === "string" ? event.reqId : undefined;
    if (type === "error") {
      if (reqId === undefined || !this.reqIds.delete(reqId)) return null;
      return JSON.stringify(event);
    }
    if (!PROVIDER_PROXY_LINK_EVENT_TYPES.has(type) || DROPPED_EVENTS.has(type)) return null;
    if (reqId !== undefined) this.reqIds.delete(reqId);
    if (type === "provider_proxy_hello_result") {
      const features = Array.isArray(event.features) ? event.features.filter(feature => feature !== "exec-alive") : [];
      event.features = [...features, PROVIDER_PROXY_LINK_ONLY_FEATURE];
    }
    return JSON.stringify(event);
  }

  private remember(reqId: string): void {
    this.reqIds.add(reqId);
    if (this.reqIds.size > MAX_PENDING_REQ_IDS) {
      const oldest = this.reqIds.values().next().value;
      if (oldest !== undefined) this.reqIds.delete(oldest);
    }
  }
}
