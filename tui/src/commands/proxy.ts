import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { loadSshAliases } from "../ssh-aliases";
import { theme } from "../theme";
import { validateSshAlias } from "@exocortex/shared/ssh-transport";
import { PROXYABLE_PROVIDERS, isProxyableProvider } from "@exocortex/shared/provider-proxy";
import type { SlashCommand } from "./types";

const USAGE = `Usage: /proxy [${PROXYABLE_PROVIDERS.join("|")} <ssh-alias>|off]`;

/** `/proxy <provider> <ssh-alias>`: send a provider's model requests through another machine's login. */
export const PROXY_COMMAND: SlashCommand = {
  name: "/proxy",
  description: "Use another machine's provider login over SSH",
  getArgs: () => {
    const aliases = loadSshAliases().map(alias => ({ name: alias, desc: "SSH alias" }));
    return {
      "/proxy": PROXYABLE_PROVIDERS.map(provider => ({ name: provider, desc: "proxy this provider's model requests" })),
      ...Object.fromEntries(PROXYABLE_PROVIDERS.map(provider => [`/proxy ${provider}`, [
        ...aliases,
        { name: "off", desc: "use this machine's own login again" },
      ]])),
    };
  },
  handler: (text, state) => {
    const args = text.replace(/^\/proxy(?:\s+|$)/, "").trim().split(/\s+/).filter(Boolean);
    clearPrompt(state);
    if (args.length === 0) return { type: "provider_proxy", action: "status" };
    const [provider, target] = args;
    if (args.length > 2 || !target) {
      pushSystemMessage(state, USAGE);
      return { type: "handled" };
    }
    if (!isProxyableProvider(provider)) {
      pushSystemMessage(state, `Only ${PROXYABLE_PROVIDERS.join(" and ")} can go through /proxy.`, theme.error);
      return { type: "handled" };
    }
    if (target.toLowerCase() === "off") return { type: "provider_proxy", action: "off", provider };
    const aliasError = validateSshAlias(target);
    if (aliasError) {
      pushSystemMessage(state, aliasError, theme.error);
      return { type: "handled" };
    }
    return { type: "provider_proxy", action: "set", provider, alias: target };
  },
};
